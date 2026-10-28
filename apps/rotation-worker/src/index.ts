import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import {
  rotationPlanSchema,
  rotationScheduleSchema,
  rotationControlSchema,
  immediateRotationSchema,
} from "@workers-workload-identity/contracts";

type RotationPlan = z.infer<typeof rotationPlanSchema>;
type RunParams = { runId: string };

export interface Env {
  KEY_DB: D1Database;
  POLICY_DB: D1Database;
  ISSUER_URL: string;
  CF_ACCOUNT_ID: string;
  CF_ISSUER_SCRIPT: string;
  CF_API_TOKEN: string;
  ROTATION_WORKFLOW: Workflow<RunParams>;
}

const runRowSchema = z.strictObject({
  id: z.uuid(),
  algorithm: z.enum(["RS256", "ES256"]),
  state: z.string(),
  new_kid: z.string().nullable(),
  old_kid: z.string().nullable(),
  prepublish_seconds: z.number().int().positive(),
  retirement_grace_seconds: z.number().int().positive(),
  created_at: z.number(),
  updated_at: z.number(),
  error_code: z.string().nullable(),
});
type RunRow = z.infer<typeof runRowSchema>;

function settings(env: Env) {
  return z
    .strictObject({
      ISSUER_URL: z.url().startsWith("https://"),
      CF_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
      CF_ISSUER_SCRIPT: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      CF_API_TOKEN: z.string().min(20),
    })
    .parse({
      ISSUER_URL: env.ISSUER_URL,
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      CF_ISSUER_SCRIPT: env.CF_ISSUER_SCRIPT,
      CF_API_TOKEN: env.CF_API_TOKEN,
    });
}

class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: readonly number[],
    method: string,
    path: string,
  ) {
    super(
      `Cloudflare API ${method} ${path} status ${status}${codes.length ? ` (codes: ${codes.join(", ")})` : ""}`,
    );
  }
}

async function cfApi(env: Env, path: string, method = "GET", body?: unknown): Promise<unknown> {
  const config = settings(env);
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.CF_ACCOUNT_ID}/workers/scripts/${config.CF_ISSUER_SCRIPT}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.CF_API_TOKEN}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const errors = z
      .object({ errors: z.array(z.object({ code: z.number().int() })) })
      .safeParse(body);
    throw new CloudflareApiError(
      response.status,
      errors.success ? errors.data.errors.map((error) => error.code) : [],
      method,
      path,
    );
  }
  const envelope = z
    .object({ success: z.boolean(), result: z.unknown() })
    .parse(await response.json());
  if (!envelope.success) throw new Error("Cloudflare API rejected operation");
  return envelope.result;
}

async function getRun(env: Env, runId: string): Promise<RunRow> {
  return runRowSchema.parse(
    await env.KEY_DB.prepare("SELECT * FROM rotation_runs WHERE id = ?").bind(runId).first(),
  );
}

function publicJwk(
  jwk: Awaited<ReturnType<typeof exportJWK>>,
  algorithm: "RS256" | "ES256",
  kid: string,
) {
  if (algorithm === "RS256") {
    const rsa = z.object({ kty: z.literal("RSA"), n: z.string(), e: z.string() }).parse(jwk);
    return { kty: "RSA" as const, n: rsa.n, e: rsa.e, kid, alg: algorithm, use: "sig" as const };
  }
  const ec = z
    .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() })
    .parse(jwk);
  return {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: ec.x,
    y: ec.y,
    kid,
    alg: algorithm,
    use: "sig" as const,
  };
}

// A definite authentication rejection cannot have installed the new secret.
// Unknown upload outcomes must remain blocked for manual reconciliation.
async function stageApi(
  env: Env,
  runId: string,
  state: "draft" | "secret-staging",
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      const code = `cloudflare-api-${error.status}`;
      await env.KEY_DB.prepare(
        "UPDATE rotation_runs SET state = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND state = ? AND new_kid IS NULL AND NOT EXISTS (SELECT 1 FROM signing_keys WHERE rotation_id = ?)",
      )
        .bind(code, Date.now(), runId, state, runId)
        .run();
      throw new NonRetryableError(
        `${code}: ${error.message}. Correct Controller CF_API_TOKEN or its permissions, then start a new rotation.`,
      );
    }
    throw error;
  }
}

async function stage(env: Env, runId: string): Promise<string> {
  const run = await getRun(env, runId);
  if (run.state === "published" || run.state === "active" || run.state === "removed") {
    if (!run.new_kid) throw new Error("run missing new key");
    return run.new_kid;
  }
  if (run.state !== "draft")
    throw new NonRetryableError(run.error_code ?? "rotation requires manual recovery");
  // Validate read access while a retry is still safe, before locking or generating a key.
  await stageApi(env, runId, "draft", () => cfApi(env, "/deployments?per_page=1"));
  const locked = await env.KEY_DB.prepare(
    "UPDATE rotation_runs SET state = 'secret-staging', updated_at = ? WHERE id = ? AND state = 'draft'",
  )
    .bind(Date.now(), runId)
    .run();
  if (locked.meta.changes !== 1) throw new Error("rotation already started");

  const kid = crypto.randomUUID();
  const binding = `SIGNING_KEY_${kid.replaceAll("-", "").toUpperCase()}`;
  const keys = await generateKeyPair(run.algorithm, {
    extractable: true,
    ...(run.algorithm === "RS256" ? { modulusLength: 3072 } : {}),
  });
  const privatePem = await exportPKCS8(keys.privateKey);
  const jwk = publicJwk(await exportJWK(keys.publicKey), run.algorithm, kid);
  await stageApi(env, runId, "secret-staging", () =>
    cfApi(env, "/secrets", "PUT", { name: binding, text: privatePem, type: "secret_text" }),
  );
  const now = Date.now();
  await env.KEY_DB.batch([
    env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid, algorithm, state, public_jwk_json, secret_binding, created_at, published_at, rotation_id) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?)",
    ).bind(kid, run.algorithm, JSON.stringify(jwk), binding, now, now, runId),
    env.KEY_DB.prepare(
      "UPDATE rotation_runs SET state = 'published', new_kid = ?, updated_at = ? WHERE id = ? AND state = 'secret-staging'",
    ).bind(kid, now, runId),
    env.KEY_DB.prepare(
      "INSERT INTO rotation_evidence (id,run_id,kind,evidence_json,recorded_at) VALUES (?,?,'publication',?,?)",
    ).bind(
      crypto.randomUUID(),
      runId,
      JSON.stringify({ kid, algorithm: run.algorithm, publishedAt: now }),
      now,
    ),
  ]);
  return kid;
}

async function verifyPublishedAndDeployed(env: Env, kid: string, binding: string) {
  const config = settings(env);
  const jwksResponse = await fetch(`${config.ISSUER_URL}/jwks.json`, { cache: "no-store" });
  if (!jwksResponse.ok) throw new Error("JWKS unavailable");
  const jwks = z
    .object({ keys: z.array(z.object({ kid: z.string() }).passthrough()) })
    .parse(await jwksResponse.json());
  if (!jwks.keys.some((key) => key.kid === kid)) throw new Error("new key absent from public JWKS");

  const deployments = z
    .object({
      deployments: z.array(
        z.object({
          versions: z.array(z.object({ percentage: z.number(), version_id: z.string() })),
        }),
      ),
    })
    .parse(await cfApi(env, "/deployments?per_page=1"));
  const versions = deployments.deployments[0]?.versions;
  if (!versions || versions.length !== 1 || versions[0]?.percentage !== 100) {
    throw new Error("issuer version is not deployed at 100 percent");
  }
  const version = z
    .object({
      resources: z.object({ bindings: z.array(z.object({ name: z.string() }).passthrough()) }),
    })
    .parse(await cfApi(env, `/versions/${versions[0].version_id}`));
  if (!version.resources.bindings.some((item) => item.name === binding)) {
    throw new Error("new secret is not bound in the serving version");
  }
  return versions[0].version_id;
}

async function verifyAudienceCache(
  env: Env,
  run: Pick<RunRow, "algorithm" | "prepublish_seconds">,
) {
  const rows = await env.POLICY_DB.prepare(
    "SELECT jwks_cache_seconds FROM audiences WHERE algorithm = ?",
  )
    .bind(run.algorithm)
    .all();
  for (const raw of rows.results) {
    const item = z
      .strictObject({
        jwks_cache_seconds: z.number().int().nonnegative().nullable(),
      })
      .parse(raw);
    if (item.jwks_cache_seconds === null || run.prepublish_seconds < item.jwks_cache_seconds + 60) {
      throw new Error("audience cache behavior is not verified");
    }
  }
}

async function verifyRecipientChecks(env: Env, algorithm: "RS256" | "ES256") {
  const rows = await env.POLICY_DB.prepare(
    "SELECT exchange_verified,mixed_jwks_verified,verified_for_es256 FROM audiences WHERE algorithm=?",
  )
    .bind(algorithm)
    .all();
  if (!rows.results.length) throw new Error("automatic-rotation-not-verified");
  for (const raw of rows.results) {
    const row = z
      .strictObject({
        exchange_verified: z.literal(1),
        mixed_jwks_verified: z.literal(1),
        verified_for_es256: z.number().int().min(0).max(1),
      })
      .safeParse(raw);
    if (!row.success || (algorithm === "ES256" && row.data.verified_for_es256 !== 1))
      throw new Error("automatic-rotation-not-verified");
  }
}

async function activate(env: Env, runId: string, immediate = false): Promise<void> {
  const run = await getRun(env, runId);
  if (run.state === "active" || run.state === "removed") return;
  if (run.state !== "published" || !run.new_kid) throw new Error("rotation is not published");
  const now = Date.now();
  const key = z
    .strictObject({ kid: z.string(), secret_binding: z.string(), published_at: z.number() })
    .parse(
      await env.KEY_DB.prepare(
        "SELECT kid, secret_binding, published_at FROM signing_keys WHERE kid = ? AND state = 'prepared'",
      )
        .bind(run.new_kid)
        .first(),
    );
  if (!immediate && now < key.published_at + run.prepublish_seconds * 1_000) {
    throw new Error("prepublication wait incomplete");
  }
  if (!immediate) {
    await verifyAudienceCache(env, run);
    if (run.old_kid) await verifyRecipientChecks(env, run.algorithm);
  }
  const versionId = await verifyPublishedAndDeployed(env, key.kid, key.secret_binding);
  // Re-read after outbound deployment checks: confirmations may have been revoked.
  if (!immediate) {
    await verifyAudienceCache(env, run);
    if (run.old_kid) await verifyRecipientChecks(env, run.algorithm);
  }
  const removeNotBefore = now + (330 + run.retirement_grace_seconds) * 1_000;
  const statements = [];
  if (run.old_kid) {
    statements.push(
      env.KEY_DB.prepare(
        "UPDATE signing_keys SET state = 'verifying', last_old_issued_at = ?, remove_not_before = ? WHERE kid = ? AND state = 'active'",
      ).bind(now, removeNotBefore, run.old_kid),
    );
  }
  statements.push(
    env.KEY_DB.prepare(
      "UPDATE signing_keys SET state = 'active', activated_at = ? WHERE kid = ? AND state = 'prepared'",
    ).bind(now, run.new_kid),
    env.KEY_DB.prepare(
      "UPDATE rotation_runs SET state = 'active', updated_at = ? WHERE id = ? AND state = 'published'",
    ).bind(now, runId),
    env.KEY_DB.prepare(
      "INSERT INTO rotation_evidence (id, run_id, kind, evidence_json, recorded_at) VALUES (?, ?, 'deployment', ?, ?)",
    ).bind(
      crypto.randomUUID(),
      runId,
      JSON.stringify({
        versionId,
        kid: key.kid,
        observedAt: now,
        prepublishSeconds: run.prepublish_seconds,
        immediate,
      }),
      now,
    ),
  );
  const results = await env.KEY_DB.batch(statements);
  if (results.some((result) => result.meta.changes !== 1))
    throw new Error("rotation activation conflict");
}

async function retire(env: Env, runId: string): Promise<void> {
  const run = await getRun(env, runId);
  if (run.state === "removed") return;
  if (run.state !== "active") throw new Error("rotation is not active");
  if (!run.old_kid) {
    await env.KEY_DB.prepare(
      "UPDATE rotation_runs SET state = 'removed', updated_at = ? WHERE id = ? AND state = 'active'",
    )
      .bind(Date.now(), runId)
      .run();
    return;
  }
  const old = z
    .strictObject({ kid: z.string(), secret_binding: z.string(), remove_not_before: z.number() })
    .parse(
      await env.KEY_DB.prepare(
        "SELECT kid, secret_binding, remove_not_before FROM signing_keys WHERE kid = ? AND state = 'verifying'",
      )
        .bind(run.old_kid)
        .first(),
    );
  const now = Date.now();
  if (now < old.remove_not_before) throw new Error("old JWTs may still be valid");
  const pending = await env.KEY_DB.prepare(
    "SELECT COUNT(*) AS count FROM issuance_reservations WHERE kid = ? AND completed_at IS NULL AND expires_at > ?",
  )
    .bind(old.kid, now)
    .first<{ count: number }>();
  if (!pending || pending.count !== 0) throw new Error("pending old-key issuance");
  await cfApi(env, `/secrets/${encodeURIComponent(old.secret_binding)}`, "DELETE");
  const results = await env.KEY_DB.batch([
    env.KEY_DB.prepare(
      "UPDATE signing_keys SET state = 'removed' WHERE kid = ? AND state = 'verifying'",
    ).bind(old.kid),
    env.KEY_DB.prepare(
      "UPDATE rotation_runs SET state = 'removed', updated_at = ? WHERE id = ? AND state = 'active'",
    ).bind(now, runId),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) throw new Error("retirement conflict");
}

export class RotationWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const runId = z.uuid().parse(event.payload.runId);
    await step.do("stage secret and publish JWK", async () => stage(this.env, runId));
    const run = await getRun(this.env, runId);
    if (run.state === "published") {
      const key = await this.env.KEY_DB.prepare(
        "SELECT published_at FROM signing_keys WHERE kid = ?",
      )
        .bind(run.new_kid)
        .first<{ published_at: number }>();
      if (!key) throw new Error("published key missing");
      const deadline = key.published_at + run.prepublish_seconds * 1_000;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        try {
          await step.waitForEvent("wait for publication or immediate activation", {
            type: "immediate-activated",
            timeout: `${Math.max(1, Math.ceil(remaining / 1_000))} seconds`,
          });
        } catch (error) {
          // Only an elapsed publication deadline may be treated as a timeout.
          if (Date.now() < deadline) throw error;
        }
      }
    }
    await step.do("verify gates and activate", async () => activate(this.env, runId));
    const activeRun = await getRun(this.env, runId);
    if (activeRun.state === "active" && activeRun.old_kid) {
      const old = await this.env.KEY_DB.prepare(
        "SELECT remove_not_before FROM signing_keys WHERE kid = ? AND state = 'verifying'",
      )
        .bind(activeRun.old_kid)
        .first<{ remove_not_before: number }>();
      if (!old || old.remove_not_before == null)
        throw new Error("old-key retirement deadline missing");
      if (old.remove_not_before > Date.now()) {
        await step.sleepUntil("old-key retirement deadline", old.remove_not_before);
      }
    }
    await step.do("retire old key", async () => retire(this.env, runId));
  }
}

export class RotationRpc extends WorkerEntrypoint<Env, { caller: "admin" }> {
  private authorize() {
    z.strictObject({ caller: z.literal("admin") }).parse(this.ctx.props);
    settings(this.env);
  }

  async listKeys() {
    this.authorize();
    const [keys, runs] = await Promise.all([
      this.env.KEY_DB.prepare(
        "SELECT kid, algorithm, state, public_jwk_json, created_at, published_at, activated_at, remove_not_before FROM signing_keys ORDER BY created_at DESC",
      ).all(),
      this.env.KEY_DB.prepare(
        "SELECT id, algorithm, state, new_kid, old_kid, created_at, updated_at, error_code FROM rotation_runs ORDER BY created_at DESC LIMIT 100",
      ).all(),
    ]);
    const [schedules, proposals, evidence, actions] = await Promise.all([
      this.env.KEY_DB.prepare("SELECT * FROM rotation_schedules ORDER BY algorithm").all(),
      this.env.KEY_DB.prepare(
        "SELECT * FROM rotation_proposals ORDER BY created_at DESC LIMIT 50",
      ).all(),
      this.env.KEY_DB.prepare(
        "SELECT * FROM rotation_evidence ORDER BY recorded_at DESC LIMIT 100",
      ).all(),
      this.env.KEY_DB.prepare(
        "SELECT * FROM rotation_actions ORDER BY occurred_at DESC LIMIT 100",
      ).all(),
    ]);
    const enriched = await Promise.all(
      runs.results.map(async (run) => {
        let workflowStatus = "unknown";
        try {
          workflowStatus = (await (await this.env.ROTATION_WORKFLOW.get(String(run.id))).status())
            .status;
        } catch {
          /* Registry state remains visible if Workflows is unavailable. */
        }
        return { ...run, workflowStatus };
      }),
    );
    return {
      keys: keys.results,
      runs: enriched,
      schedules: schedules.results,
      proposals: proposals.results,
      evidence: evidence.results,
      actions: actions.results,
    };
  }

  async plan(raw: unknown) {
    this.authorize();
    const input: RotationPlan = rotationPlanSchema.parse(raw);
    const id = crypto.randomUUID();
    const now = Date.now();
    const old = await this.env.KEY_DB.prepare(
      "SELECT kid FROM signing_keys WHERE algorithm = ? AND state = 'active'",
    )
      .bind(input.algorithm)
      .first<{ kid: string }>();
    await this.env.KEY_DB.prepare(
      "INSERT INTO rotation_runs (id, algorithm, state, old_kid, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        input.algorithm,
        old?.kid ?? null,
        input.prepublishSeconds,
        input.retirementGraceSeconds,
        now,
        now,
      )
      .run();
    await this.env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
    return { id, state: "draft" };
  }

  async activate(runId: string) {
    this.authorize();
    await activate(this.env, z.uuid().parse(runId));
    return { id: runId, state: "active" };
  }

  async retire(runId: string) {
    this.authorize();
    await retire(this.env, z.uuid().parse(runId));
    return { id: runId, state: "removed" };
  }

  async propose(raw: unknown, actorId: string) {
    this.authorize();
    z.uuid().parse(actorId);
    const input = rotationPlanSchema.parse(raw),
      id = crypto.randomUUID(),
      now = Date.now();
    await this.env.KEY_DB.prepare(
      "INSERT INTO rotation_proposals (id,proposed_by,plan_json,state,created_at) VALUES (?,?,?,'proposed',?)",
    )
      .bind(id, actorId, JSON.stringify(input), now)
      .run();
    return { id, state: "proposed" };
  }

  async approve(id: string, actorId: string) {
    this.authorize();
    z.uuid().parse(id);
    z.uuid().parse(actorId);
    const proposal = await this.env.KEY_DB.prepare(
      "SELECT proposed_by,plan_json,state FROM rotation_proposals WHERE id=?",
    )
      .bind(id)
      .first<{ proposed_by: string; plan_json: string; state: string }>();
    if (!proposal || proposal.state !== "proposed" || proposal.proposed_by === actorId)
      throw new Error("proposal-approval-denied");
    const input = rotationPlanSchema.parse(JSON.parse(proposal.plan_json)),
      now = Date.now();
    const old = await this.env.KEY_DB.prepare(
      "SELECT kid FROM signing_keys WHERE algorithm=? AND state='active'",
    )
      .bind(input.algorithm)
      .first<{ kid: string }>();
    const results = await this.env.KEY_DB.batch([
      this.env.KEY_DB.prepare(
        "UPDATE rotation_proposals SET state='approved',approved_by=?,approved_at=? WHERE id=? AND state='proposed' AND proposed_by<>?",
      ).bind(actorId, now, id, actorId),
      this.env.KEY_DB.prepare(
        "INSERT INTO rotation_runs (id,algorithm,state,old_kid,prepublish_seconds,retirement_grace_seconds,created_at,updated_at) SELECT ?,?,'draft',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rotation_proposals WHERE id=? AND approved_by=? AND approved_at=?)",
      ).bind(
        id,
        input.algorithm,
        old?.kid ?? null,
        input.prepublishSeconds,
        input.retirementGraceSeconds,
        now,
        now,
        id,
        actorId,
        now,
      ),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1)
      throw new Error("proposal-approval-denied");
    await startWorkflow(this.env, id);
    await recordAction(this.env, id, actorId, "rotation.approve", {});
    return { id, state: "draft" };
  }

  async control(id: string, raw: unknown, actorId: string) {
    this.authorize();
    z.uuid().parse(id);
    z.uuid().parse(actorId);
    const input = rotationControlSchema.parse(raw),
      run = await getRun(this.env, id);
    if (["removed", "failed", "secret-staging"].includes(run.state))
      throw new Error("rotation-control-denied");
    await recordAction(this.env, id, actorId, `rotation.${input.action}.requested`, {
      reason: input.reason,
    });
    const instance = await this.env.ROTATION_WORKFLOW.get(id);
    if (input.action === "retry") {
      if (run.state === "draft") {
        let status: string | null = null;
        try {
          status = (await instance.status()).status;
        } catch {
          /* The D1 commit may precede Workflow creation. */
        }
        if (status === null) await startWorkflow(this.env, id);
        else if (status === "errored" || status === "terminated") await instance.restart();
        else throw new Error("rotation-control-denied");
      } else {
        const status = await instance.status();
        if (status.status !== "errored" && status.status !== "terminated")
          throw new Error("rotation-control-denied");
        await instance.restart();
      }
    } else if (input.action === "pause") await instance.pause();
    else await instance.resume();
    await recordAction(this.env, id, actorId, `rotation.${input.action}`, { reason: input.reason });
    return { id, ok: true };
  }

  async immediateActivate(id: string, raw: unknown, actorId: string) {
    this.authorize();
    z.uuid().parse(id);
    z.uuid().parse(actorId);
    const input = immediateRotationSchema.parse(raw),
      run = await getRun(this.env, id);
    if (run.state !== "published" || run.new_kid !== input.expectedKid)
      throw new Error("rotation-control-denied");
    await recordAction(this.env, id, actorId, "rotation.immediate.requested", input);
    // Deployment/JWKS integrity and old-token retirement checks still apply.
    await activate(this.env, id, true);
    try {
      const instance = await this.env.ROTATION_WORKFLOW.get(id);
      await instance.sendEvent({ type: "immediate-activated", payload: {} });
    } catch (error) {
      // Activation has already committed; the Workflow can still continue at its original deadline.
      console.error(
        JSON.stringify({
          event: "immediate-workflow-notification-failed",
          runId: id,
          error: String(error),
        }),
      );
    }
    await recordAction(this.env, id, actorId, "rotation.immediate", {
      reason: input.reason,
      kid: input.expectedKid,
    });
    console.warn(JSON.stringify({ event: "immediate-key-activation", runId: id, actorId }));
    return { id, state: "active" };
  }

  async configureSchedule(raw: unknown, actorId: string) {
    this.authorize();
    z.uuid().parse(actorId);
    const input = rotationScheduleSchema.parse(raw),
      event = crypto.randomUUID(),
      now = Date.now();
    if (input.enabled) {
      if (input.nextRunAt < now + 60_000) throw new Error("schedule-date-invalid");
      await verifyAutomaticEligibility(this.env, input.algorithm, input.prepublishSeconds);
    }
    const result = await this.env.KEY_DB.batch([
      this.env.KEY_DB.prepare(
        "INSERT INTO rotation_schedules (algorithm,enabled,interval_days,next_run_at,prepublish_seconds,retirement_grace_seconds,version,last_mutation_id,updated_at) SELECT ?,?,?,?,?,?,1,?,? WHERE ?=0 OR EXISTS (SELECT 1 FROM rotation_schedules WHERE algorithm=? AND version=?) ON CONFLICT(algorithm) DO UPDATE SET enabled=excluded.enabled,interval_days=excluded.interval_days,next_run_at=excluded.next_run_at,prepublish_seconds=excluded.prepublish_seconds,retirement_grace_seconds=excluded.retirement_grace_seconds,version=rotation_schedules.version+1,last_mutation_id=excluded.last_mutation_id,last_error=NULL,updated_at=excluded.updated_at WHERE rotation_schedules.version=?",
      ).bind(
        input.algorithm,
        Number(input.enabled),
        input.intervalDays,
        input.nextRunAt,
        input.prepublishSeconds,
        input.retirementGraceSeconds,
        event,
        now,
        input.version,
        input.algorithm,
        input.version,
        input.version,
      ),
      this.env.KEY_DB.prepare(
        "INSERT INTO rotation_actions (id,actor_id,action,detail_json,occurred_at) SELECT ?,?,'rotation.schedule',?,? WHERE EXISTS (SELECT 1 FROM rotation_schedules WHERE algorithm=? AND last_mutation_id=?)",
      ).bind(event, actorId, JSON.stringify(input), now, input.algorithm, event),
    ]);
    if (result[0].meta.changes !== 1) throw new Error("version-conflict");
    return { version: input.version + 1 };
  }
}

async function recordAction(
  env: Env,
  runId: string | null,
  actorId: string,
  action: string,
  detail: unknown,
) {
  await env.KEY_DB.prepare(
    "INSERT INTO rotation_actions (id,run_id,actor_id,action,detail_json,occurred_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), runId, actorId, action, JSON.stringify(detail), Date.now())
    .run();
}
async function startWorkflow(env: Env, id: string) {
  try {
    await env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
  } catch (error) {
    // A duplicate delivery must not create a second Workflow or generate another key.
    try {
      await (await env.ROTATION_WORKFLOW.get(id)).status();
    } catch {
      throw error;
    }
  }
}
async function verifyAutomaticEligibility(
  env: Env,
  algorithm: "RS256" | "ES256",
  prepublishSeconds: number,
) {
  const active = await env.KEY_DB.prepare(
    "SELECT kid FROM signing_keys WHERE algorithm=? AND state='active'",
  )
    .bind(algorithm)
    .first();
  const audience = await env.POLICY_DB.prepare(
    "SELECT audience FROM audiences WHERE algorithm=? LIMIT 1",
  )
    .bind(algorithm)
    .first();
  if (!active || !audience) throw new Error("automatic-rotation-not-verified");
  await verifyAudienceCache(env, { algorithm, prepublish_seconds: prepublishSeconds });
  await verifyRecipientChecks(env, algorithm);
}

export async function tickSchedules(env: Env, now = Date.now()) {
  const schedules = await env.KEY_DB.prepare(
    "SELECT * FROM rotation_schedules WHERE enabled=1 AND next_run_at<=?",
  )
    .bind(now)
    .all();
  for (const raw of schedules.results) {
    const item = z
      .object({
        algorithm: z.enum(["RS256", "ES256"]),
        version: z.number(),
        interval_days: z.number(),
        next_run_at: z.number(),
        prepublish_seconds: z.number(),
        retirement_grace_seconds: z.number(),
      })
      .parse(raw);
    const open = await env.KEY_DB.prepare(
      "SELECT id FROM rotation_runs WHERE algorithm=? AND state NOT IN ('removed','failed')",
    )
      .bind(item.algorithm)
      .first();
    if (open) continue;
    try {
      await verifyAutomaticEligibility(env, item.algorithm, item.prepublish_seconds);
    } catch {
      await env.KEY_DB.prepare(
        "UPDATE rotation_schedules SET enabled=0,last_error='recipient-verification-required',version=version+1,updated_at=? WHERE algorithm=? AND version=?",
      )
        .bind(now, item.algorithm, item.version)
        .run();
      await recordAction(env, null, "scheduler", "rotation.schedule.blocked", {
        algorithm: item.algorithm,
      });
      console.warn(
        JSON.stringify({ event: "rotation-schedule-blocked", algorithm: item.algorithm }),
      );
      continue;
    }
    const id = crypto.randomUUID();
    const old = await env.KEY_DB.prepare(
      "SELECT kid FROM signing_keys WHERE algorithm=? AND state='active'",
    )
      .bind(item.algorithm)
      .first<{ kid: string }>();
    let result;
    try {
      result = await env.KEY_DB.batch([
        env.KEY_DB.prepare(
          "INSERT INTO rotation_runs (id,algorithm,state,old_kid,prepublish_seconds,retirement_grace_seconds,created_at,updated_at) SELECT ?,?,'draft',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rotation_schedules WHERE algorithm=? AND version=? AND enabled=1 AND next_run_at<=?)",
        ).bind(
          id,
          item.algorithm,
          old!.kid,
          item.prepublish_seconds,
          item.retirement_grace_seconds,
          now,
          now,
          item.algorithm,
          item.version,
          now,
        ),
        env.KEY_DB.prepare(
          "UPDATE rotation_schedules SET next_run_at=?,version=version+1,last_mutation_id=?,last_error=NULL,updated_at=? WHERE algorithm=? AND version=? AND EXISTS (SELECT 1 FROM rotation_runs WHERE id=?)",
        ).bind(now + item.interval_days * 86_400_000, id, now, item.algorithm, item.version, id),
      ]);
    } catch (error) {
      const concurrent = await env.KEY_DB.prepare(
        "SELECT id FROM rotation_runs WHERE algorithm=? AND state NOT IN ('removed','failed')",
      )
        .bind(item.algorithm)
        .first();
      if (concurrent) continue;
      throw error;
    }
    if (result[0].meta.changes === 1) {
      await startWorkflow(env, id);
      await recordAction(env, id, "scheduler", "rotation.scheduled", { algorithm: item.algorithm });
    }
  }
  // Recover a crash between the D1 commit and Workflow creation using the same run ID.
  const drafts = await env.KEY_DB.prepare(
    "SELECT id FROM rotation_runs WHERE state='draft' LIMIT 20",
  ).all<{ id: string }>();
  for (const draft of drafts.results) await startWorkflow(env, draft.id);
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await tickSchedules(env);
  },
} satisfies ExportedHandler<Env>;
