import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  introspectWorkflowInstance,
  reset,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tickSchedules, type Env as RotationEnv } from "./index.js";
declare global {
  namespace Cloudflare {
    interface Env extends RotationEnv {
      POLICY_MIGRATIONS: D1Migration[];
      KEY_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("./index.js");
    }
  }
}
const rpc = () => exports.RotationRpc({ props: { caller: "admin" } });
const runId = "11111111-1111-4111-8111-111111111111";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await applyD1Migrations(env.KEY_DB, env.KEY_MIGRATIONS);
});
afterEach(() => vi.unstubAllGlobals());
async function published() {
  const now = Date.now();
  await env.KEY_DB.batch([
    env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid, algorithm, state, public_jwk_json, secret_binding, created_at) VALUES ('old', 'RS256', 'active', '{}', 'SIGNING_KEY_OLD', 0)",
    ),
    env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid, algorithm, state, public_jwk_json, secret_binding, created_at, published_at) VALUES ('new', 'RS256', 'prepared', '{}', 'SIGNING_KEY_NEW', 0, ?)",
    ).bind(now - 61000),
    env.KEY_DB.prepare(
      "INSERT INTO rotation_runs (id, algorithm, state, new_kid, old_kid, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, 'RS256', 'published', 'new', 'old', 60, 300, 0, 0)",
    ).bind(runId),
  ]);
}
function cloudflareFetch() {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [{ kid: "new" }] });
    if (url.includes("/deployments?"))
      return Response.json({
        success: true,
        result: { deployments: [{ versions: [{ percentage: 100, version_id: "version-1" }] }] },
      });
    if (url.endsWith("/versions/version-1"))
      return Response.json({
        success: true,
        result: { resources: { bindings: [{ name: "SIGNING_KEY_NEW" }] } },
      });
    if (url.includes("/secrets") && ["PUT", "DELETE"].includes(init?.method ?? ""))
      return Response.json({ success: true, result: {} });
    throw new Error("unexpected outbound request");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("rotation deployment gates", () => {
  it("rejects non-admin props and caller-supplied target or key material", async () => {
    // @ts-expect-error intentionally invalid caller props
    const bad = exports.RotationRpc({ props: { caller: "other" } });
    await expect((async () => await bad.listKeys())()).rejects.toThrow();
    await expect(
      (async () =>
        await rpc().plan({
          algorithm: "RS256",
          prepublishSeconds: 60,
          retirementGraceSeconds: 300,
          privateKey: "untrusted",
        }))(),
    ).rejects.toThrow();
    expect(await env.KEY_DB.prepare("SELECT COUNT(*) FROM rotation_runs").first("COUNT(*)")).toBe(
      0,
    );
  });
  it.each([401, 403])(
    "stops on API status %s before locking or uploading a secret",
    async (status) => {
      const fetcher = vi.fn(async () =>
        Response.json(
          { success: false, errors: [{ code: 10000, message: "sensitive upstream detail" }] },
          { status },
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const id = crypto.randomUUID();
      await env.KEY_DB.prepare(
        "INSERT INTO rotation_runs (id, algorithm, state, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, 'RS256', 'draft', 60, 300, 0, 0)",
      )
        .bind(id)
        .run();
      await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, id);
      await env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
      await instance.waitForStatus("errored");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        await env.KEY_DB.prepare("SELECT state, error_code FROM rotation_runs WHERE id = ?")
          .bind(id)
          .first(),
      ).toEqual({ state: "failed", error_code: `cloudflare-api-${status}` });
      expect(await env.KEY_DB.prepare("SELECT COUNT(*) FROM signing_keys").first("COUNT(*)")).toBe(
        0,
      );
      // The failed run no longer holds the unique per-algorithm open-rotation slot.
      await env.KEY_DB.prepare(
        "INSERT INTO rotation_runs (id, algorithm, state, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, 'RS256', 'draft', 60, 300, 0, 0)",
      )
        .bind(crypto.randomUUID())
        .run();
    },
  );

  it("releases the rotation after a definite upload authentication rejection", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT"
        ? Response.json({ errors: [{ code: 10000 }] }, { status: 401 })
        : Response.json({ success: true, result: {} }),
    );
    vi.stubGlobal("fetch", fetcher);
    const id = crypto.randomUUID();
    await env.KEY_DB.prepare(
      "INSERT INTO rotation_runs (id, algorithm, state, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, 'RS256', 'draft', 60, 300, 0, 0)",
    )
      .bind(id)
      .run();
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, id);
    await env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
    await instance.waitForStatus("errored");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      await env.KEY_DB.prepare("SELECT state, error_code FROM rotation_runs WHERE id = ?")
        .bind(id)
        .first(),
    ).toEqual({ state: "failed", error_code: "cloudflare-api-401" });
    expect(await env.KEY_DB.prepare("SELECT COUNT(*) FROM signing_keys").first("COUNT(*)")).toBe(0);
  });

  it("keeps an ambiguous upload blocked and never uploads a second key on retry", async () => {
    let uploads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          uploads++;
          throw new TypeError("connection closed after upload");
        }
        return Response.json({ success: true, result: {} });
      }),
    );
    const id = crypto.randomUUID();
    await env.KEY_DB.prepare(
      "INSERT INTO rotation_runs (id, algorithm, state, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, 'RS256', 'draft', 60, 300, 0, 0)",
    )
      .bind(id)
      .run();
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, id);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
    await instance.waitForStatus("errored");
    expect(uploads).toBe(1);
    expect(
      await env.KEY_DB.prepare("SELECT state FROM rotation_runs WHERE id = ?")
        .bind(id)
        .first("state"),
    ).toBe("secret-staging");
  });

  it("generates a key in the Workflow and persists only public material", async () => {
    const fetcher = cloudflareFetch();
    const id = "22222222-2222-4222-8222-222222222222";
    await env.KEY_DB.prepare(
      "INSERT INTO rotation_runs (id, algorithm, state, prepublish_seconds, retirement_grace_seconds, created_at, updated_at) VALUES (?, 'RS256', 'draft', 60, 300, 0, 0)",
    )
      .bind(id)
      .run();
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, id);
    await env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
    const kid = await instance.waitForStepResult({ name: "stage secret and publish JWK" });
    expect(typeof kid).toBe("string");
    const key = await env.KEY_DB.prepare("SELECT * FROM signing_keys WHERE kid = ?")
      .bind(kid)
      .first<{ state: string; public_jwk_json: string }>();
    expect(key?.state).toBe("prepared");
    const jwk = JSON.parse(key!.public_jwk_json);
    expect(jwk.kty).toBe("RSA");
    expect(jwk).not.toHaveProperty("d");
    expect(JSON.stringify(key)).not.toContain("PRIVATE KEY");
    const upload = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(upload?.[1]?.body)).text).toContain("BEGIN PRIVATE KEY");
    await (await env.ROTATION_WORKFLOW.get(id)).terminate();
  });
  it("allows first-key bootstrap before recipient checks can be performed", async () => {
    await published();
    await env.KEY_DB.prepare("DELETE FROM signing_keys WHERE kid='old'").run();
    await env.KEY_DB.prepare("UPDATE rotation_runs SET old_kid=NULL").run();
    cloudflareFetch();
    await rpc().activate(runId);
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid='new'").first("state"),
    ).toBe("active");
  });

  it("rejects missing or excessive recipient cache limits before deployment", async () => {
    await published();
    const fetcher = cloudflareFetch();
    await env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience,algorithm,token_lifetime_seconds,jwks_cache_seconds,created_at,updated_at) VALUES ('urn:check','RS256',300,NULL,0,0)",
    ).run();
    await expect((async () => await rpc().activate(runId))()).rejects.toThrow("not verified");
    await env.POLICY_DB.prepare("UPDATE audiences SET jwks_cache_seconds=60").run();
    await expect((async () => await rpc().activate(runId))()).rejects.toThrow("not verified");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("switches only after publication, audience evidence, and deployed-secret checks; retains the old key", async () => {
    await published();
    const fetcher = cloudflareFetch();
    await env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience, algorithm, token_lifetime_seconds, jwks_cache_seconds, created_at, updated_at) VALUES ('urn:test', 'RS256', 300, NULL, 0, 0)",
    ).run();
    await expect((async () => await rpc().activate(runId))()).rejects.toThrow("not verified");
    expect(fetcher).not.toHaveBeenCalled();
    await env.POLICY_DB.prepare("UPDATE audiences SET jwks_cache_seconds = 0").run();
    await env.POLICY_DB.prepare(
      "UPDATE audiences SET exchange_verified=1,mixed_jwks_verified=1",
    ).run();
    await rpc().activate(runId);
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid = 'new'").first("state"),
    ).toBe("active");
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid = 'old'").first("state"),
    ).toBe("verifying");
    await expect((async () => await rpc().retire(runId))()).rejects.toThrow("may still be valid");
    await env.KEY_DB.prepare(
      "UPDATE signing_keys SET remove_not_before = 0 WHERE kid = 'old'",
    ).run();
    await env.KEY_DB.prepare(
      "INSERT INTO issuance_reservations VALUES ('pending', 'old', ?, ?, NULL)",
    )
      .bind(Date.now(), Date.now() + 30000)
      .run();
    await expect((async () => await rpc().retire(runId))()).rejects.toThrow(
      "pending old-key issuance",
    );
    await env.KEY_DB.prepare("UPDATE issuance_reservations SET completed_at = ?")
      .bind(Date.now())
      .run();
    await rpc().retire(runId);
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid = 'old'").first("state"),
    ).toBe("removed");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});

describe("immediate workflow", () => {
  it("resumes an active rotation and retires the old key after the recorded deadline", async () => {
    await published();
    const fetcher = cloudflareFetch();
    await rpc().immediateActivate(
      runId,
      {
        reason: "Immediate key rotation test",
        expectedKid: "new",
        acknowledgeCacheRisk: true,
      },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    await env.KEY_DB.prepare("UPDATE signing_keys SET remove_not_before = ? WHERE kid = 'old'")
      .bind(Date.now() - 1000)
      .run();
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, runId);
    await env.ROTATION_WORKFLOW.create({ id: runId, params: { runId } });
    await instance.waitForStatus("complete");
    expect(
      await env.KEY_DB.prepare("SELECT state FROM rotation_runs WHERE id = ?")
        .bind(runId)
        .first("state"),
    ).toBe("removed");
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid = 'old'").first("state"),
    ).toBe("removed");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
  it("wakes on immediate activation and retains the old key until its deadline", async () => {
    await published();
    await env.KEY_DB.prepare("UPDATE signing_keys SET published_at = ? WHERE kid = 'new'")
      .bind(Date.now())
      .run();
    cloudflareFetch();
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, runId);
    await env.ROTATION_WORKFLOW.create({ id: runId, params: { runId } });
    await instance.waitForStepResult({ name: "stage secret and publish JWK" });
    await rpc().immediateActivate(
      runId,
      {
        reason: "Immediate key rotation test",
        expectedKid: "new",
        acknowledgeCacheRisk: true,
      },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    await instance.waitForStepResult({ name: "verify gates and activate" });
    const old = await env.KEY_DB.prepare(
      "SELECT state, remove_not_before FROM signing_keys WHERE kid = 'old'",
    ).first<{ state: string; remove_not_before: number }>();
    expect(old?.state).toBe("verifying");
    expect(old!.remove_not_before).toBeGreaterThan(Date.now());
    expect(
      await env.KEY_DB.prepare("SELECT state FROM rotation_runs WHERE id = ?")
        .bind(runId)
        .first("state"),
    ).toBe("active");
    await (await env.ROTATION_WORKFLOW.get(runId)).terminate();
  });
});

describe("rotation operations", () => {
  const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    proposer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  it("requires recipient evidence before enabling automation, detects stale versions, and starts one run for duplicate ticks", async () => {
    const input = {
      algorithm: "RS256",
      version: 0,
      enabled: true,
      intervalDays: 90,
      nextRunAt: Date.now() + 120000,
      prepublishSeconds: 60,
      retirementGraceSeconds: 300,
    };
    await expect((async () => await rpc().configureSchedule(input, admin))()).rejects.toThrow(
      "not-verified",
    );
    await env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid,algorithm,state,public_jwk_json,secret_binding,created_at) VALUES ('current','RS256','active','{}','CURRENT',0)",
    ).run();
    await env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience,algorithm,token_lifetime_seconds,jwks_cache_seconds,created_at,updated_at) VALUES ('urn:test','RS256',300,0,0,0)",
    ).run();
    // A cache value alone is insufficient; each confirmation is required.
    await expect((async () => await rpc().configureSchedule(input, admin))()).rejects.toThrow(
      "not-verified",
    );
    await env.POLICY_DB.prepare("UPDATE audiences SET exchange_verified=1").run();
    await expect((async () => await rpc().configureSchedule(input, admin))()).rejects.toThrow(
      "not-verified",
    );
    await env.POLICY_DB.prepare("UPDATE audiences SET mixed_jwks_verified=1").run();
    expect(await rpc().configureSchedule(input, admin)).toEqual({ version: 1 });
    await expect((async () => await rpc().configureSchedule(input, admin))()).rejects.toThrow(
      "version-conflict",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false }, { status: 401 })),
    );
    await env.KEY_DB.prepare("UPDATE rotation_schedules SET next_run_at=?")
      .bind(Date.now() - 1000)
      .run();
    await Promise.all([tickSchedules(env), tickSchedules(env)]);
    const runs = await env.KEY_DB.prepare("SELECT id FROM rotation_runs").all<{ id: string }>();
    expect(runs.results).toHaveLength(1);
    await using instance = await introspectWorkflowInstance(
      env.ROTATION_WORKFLOW,
      runs.results[0].id,
    );
    await instance.waitForStatus("errored");
    await tickSchedules(env);
    expect(await env.KEY_DB.prepare("SELECT COUNT(*) n FROM rotation_runs").first("n")).toBe(1);
  });
  it("disables a due schedule when evidence is missing", async () => {
    await env.KEY_DB.prepare(
      "INSERT INTO rotation_schedules VALUES ('RS256',1,90,1,60,300,1,'seed',NULL,0)",
    ).run();
    await tickSchedules(env);
    expect(
      await env.KEY_DB.prepare("SELECT enabled,last_error FROM rotation_schedules").first(),
    ).toEqual({ enabled: 0, last_error: "recipient-verification-required" });
    expect(await env.KEY_DB.prepare("SELECT COUNT(*) n FROM rotation_runs").first("n")).toBe(0);
  });
  it("requires the ES256-specific compatibility confirmation for ES256 automation", async () => {
    await env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid,algorithm,state,public_jwk_json,secret_binding,created_at) VALUES ('current','ES256','active','{}','CURRENT',0)",
    ).run();
    await env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience,algorithm,token_lifetime_seconds,jwks_cache_seconds,exchange_verified,mixed_jwks_verified,created_at,updated_at) VALUES ('urn:ec','ES256',300,0,1,1,0,0)",
    ).run();
    const input = {
      algorithm: "ES256",
      version: 0,
      enabled: true,
      intervalDays: 90,
      nextRunAt: Date.now() + 120000,
      prepublishSeconds: 60,
      retirementGraceSeconds: 300,
    };
    await expect((async () => await rpc().configureSchedule(input, admin))()).rejects.toThrow(
      "not-verified",
    );
    await env.POLICY_DB.prepare("UPDATE audiences SET verified_for_es256=1").run();
    expect(await rpc().configureSchedule(input, admin)).toEqual({ version: 1 });
  });

  it("checks all audiences again on the due tick when a new unverified audience appears", async () => {
    await env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid,algorithm,state,public_jwk_json,secret_binding,created_at) VALUES ('current','RS256','active','{}','CURRENT',0)",
    ).run();
    await env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience,algorithm,token_lifetime_seconds,jwks_cache_seconds,exchange_verified,mixed_jwks_verified,created_at,updated_at) VALUES ('urn:verified','RS256',300,0,1,1,0,0),('urn:new','RS256',300,0,0,0,0,0)",
    ).run();
    await env.KEY_DB.prepare(
      "INSERT INTO rotation_schedules VALUES ('RS256',1,90,1,60,300,1,'seed',NULL,0)",
    ).run();
    await tickSchedules(env);
    expect(
      await env.KEY_DB.prepare("SELECT enabled FROM rotation_schedules").first("enabled"),
    ).toBe(0);
    expect(await env.KEY_DB.prepare("SELECT COUNT(*) n FROM rotation_runs").first("n")).toBe(0);
  });

  it("rejects activation when confirmations are revoked during deployment checks", async () => {
    await published();
    await env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience,algorithm,token_lifetime_seconds,jwks_cache_seconds,exchange_verified,mixed_jwks_verified,created_at,updated_at) VALUES ('urn:verified','RS256',300,0,1,1,0,0)",
    ).run();
    const fetcher = cloudflareFetch();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/versions/version-1"))
        await env.POLICY_DB.prepare("UPDATE audiences SET exchange_verified=0").run();
      return original(input, init);
    });
    await expect((async () => await rpc().activate(runId))()).rejects.toThrow("not-verified");
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid='new'").first("state"),
    ).toBe("prepared");
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid='old'").first("state"),
    ).toBe("active");
  });

  it("requires another administrator to approve a proposal and rejects repeat approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false }, { status: 401 })),
    );
    const proposal = await rpc().propose(
      { algorithm: "RS256", prepublishSeconds: 60, retirementGraceSeconds: 300 },
      proposer,
    );
    await expect((async () => await rpc().approve(proposal.id, proposer))()).rejects.toThrow(
      "approval-denied",
    );
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, proposal.id);
    await rpc().approve(proposal.id, admin);
    await instance.waitForStatus("errored");
    await expect((async () => await rpc().approve(proposal.id, admin))()).rejects.toThrow(
      "approval-denied",
    );
    expect(await env.KEY_DB.prepare("SELECT COUNT(*) n FROM rotation_runs").first("n")).toBe(1);
  });
  it("pauses and resumes a real Workflow and records the actor and reason", async () => {
    cloudflareFetch();
    const id = crypto.randomUUID();
    await env.KEY_DB.prepare(
      "INSERT INTO rotation_runs (id,algorithm,state,prepublish_seconds,retirement_grace_seconds,created_at,updated_at) VALUES (?,'RS256','draft',60,300,0,0)",
    )
      .bind(id)
      .run();
    await using instance = await introspectWorkflowInstance(env.ROTATION_WORKFLOW, id);
    await env.ROTATION_WORKFLOW.create({ id, params: { runId: id } });
    await instance.waitForStepResult({ name: "stage secret and publish JWK" });
    await rpc().control(
      id,
      { action: "pause", reason: "Review deployment before activation" },
      admin,
    );
    expect((await (await env.ROTATION_WORKFLOW.get(id)).status()).status).toBe("paused");
    await rpc().control(id, { action: "resume", reason: "Deployment review was completed" }, admin);
    expect((await (await env.ROTATION_WORKFLOW.get(id)).status()).status).not.toBe("paused");
    expect(
      await env.KEY_DB.prepare("SELECT COUNT(*) n FROM rotation_actions WHERE actor_id=?")
        .bind(admin)
        .first("n"),
    ).toBe(4);
    await (await env.ROTATION_WORKFLOW.get(id)).terminate();
  });
  it("requires explicit immediate acknowledgement and expected key, keeps deployment and retirement gates", async () => {
    await published();
    cloudflareFetch();
    await env.KEY_DB.prepare("UPDATE signing_keys SET published_at=? WHERE kid='new'")
      .bind(Date.now())
      .run();
    await expect((async () => await rpc().activate(runId))()).rejects.toThrow("wait incomplete");
    const input = {
      reason: "Compromise response approved",
      expectedKid: "wrong",
      acknowledgeCacheRisk: true,
    };
    await expect(
      (async () => await rpc().immediateActivate(runId, input, admin))(),
    ).rejects.toThrow("control-denied");
    await rpc().immediateActivate(runId, { ...input, expectedKid: "new" }, admin);
    expect(
      await env.KEY_DB.prepare("SELECT state FROM signing_keys WHERE kid='new'").first("state"),
    ).toBe("active");
    await expect((async () => await rpc().retire(runId))()).rejects.toThrow("may still be valid");
  });
});
