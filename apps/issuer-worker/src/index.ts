import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import {
  callerPropsSchema,
  algorithmSchema,
  issueRequestSchema,
  issuerConfigSchema,
  type CallerProps,
  type IssueRequest,
  type IssuerBinding,
} from "@workers-workload-identity/contracts";
import { issueToken, IssuanceError } from "./application/issue-token.js";
import { enforceRateLimit, keyRepository, policyRepository } from "./adapters/d1.js";
import { listPublicKeys, signer } from "./adapters/signer.js";

export interface Env {
  POLICY_DB: D1Database;
  KEY_DB: D1Database;
  ISSUER_URL: string;
  ADMIN?: Fetcher;
  RATE_LIMIT_PER_MINUTE: string;
  [binding: string]: unknown;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  if (c.env.__ROUTED) return next();
  const issuer = new URL(c.env.ISSUER_URL);
  const base = issuer.pathname.replace(/\/$/, "");
  const url = new URL(c.req.url);
  if (url.origin !== issuer.origin) return c.text("Not found", 404);
  if (url.pathname === `${base}/admin`) return c.redirect(`${base}/admin/`, 308);
  if (url.pathname.startsWith(`${base}/admin/`) && c.env.ADMIN) {
    url.pathname = url.pathname.slice(`${base}/admin`.length);
    return c.env.ADMIN.fetch(new Request(url, c.req.raw));
  }
  if (base) {
    if (!url.pathname.startsWith(`${base}/`)) return c.text("Not found", 404);
    url.pathname = url.pathname.slice(base.length);
    return app.fetch(new Request(url, c.req.raw), {
      ...c.env,
      ISSUER_URL: c.env.ISSUER_URL,
      __ROUTED: true,
    } as Env);
  }
  await next();
});

app.get("/.well-known/openid-configuration", async (c) => {
  const config = issuerConfigSchema.parse({
    ISSUER_URL: c.env.ISSUER_URL,
    RATE_LIMIT_PER_MINUTE: c.env.RATE_LIMIT_PER_MINUTE,
  });
  return c.json(
    {
      issuer: config.ISSUER_URL,
      jwks_uri: `${config.ISSUER_URL.replace(/\/$/, "")}/jwks.json`,
      // AWS IAM requires this compatibility field; no OIDC authorization endpoint is provided.
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      // Capabilities, not the currently published keys or audience policy.
      id_token_signing_alg_values_supported: algorithmSchema.options,
      claims_supported: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
    },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
});

app.get("/jwks.json", async (c) => {
  const keys = await listPublicKeys(c.env.KEY_DB);
  return c.json({ keys }, 200, { "Cache-Control": "public, max-age=60" });
});

app.notFound((c) => c.text("Not found", 404));
app.onError(() => new Response("Unavailable", { status: 503 }));

export default Object.assign(app, {
  async scheduled(_event: ScheduledController, env: Env) {
    const minute = Math.floor(Date.now() / 60_000);
    await env.POLICY_DB.batch([
      env.POLICY_DB.prepare("DELETE FROM issuance_rate_limits WHERE minute_bucket < ?").bind(
        minute - 60,
      ),
      env.POLICY_DB.prepare("DELETE FROM issuance_audit_events WHERE occurred_at < ?").bind(
        Date.now() - 30 * 86_400_000,
      ),
      env.POLICY_DB.prepare("DELETE FROM issuance_metrics WHERE minute_bucket < ?").bind(
        minute - 30 * 1440,
      ),
    ]);
    await env.KEY_DB.prepare("DELETE FROM issuance_reservations WHERE expires_at < ?")
      .bind(Date.now() - 86_400_000)
      .run();
  },
});

export class IssuerRpc extends WorkerEntrypoint<Env, CallerProps> implements IssuerBinding {
  async issue(request: unknown): Promise<string> {
    const startedAt = Date.now();
    const eventId = crypto.randomUUID();
    const props = callerPropsSchema.safeParse(this.ctx.props);
    const input = issueRequestSchema.safeParse(request);
    let outcome = "success";
    let kid: string | null = null;
    let assertion: string | undefined;
    try {
      if (!props.success) throw new Error("caller-denied");
      if (!input.success) throw new Error("invalid-request");
      assertion = await this.issueAssertion(input.data, props.data.clientId, (keyId) => {
        kid = keyId;
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "issuance-unavailable";
      outcome = ["caller-denied", "audience-denied", "rate-limited", "invalid-request"].includes(
        code,
      )
        ? code
        : "issuance-unavailable";
    }
    // Persist before releasing a signed token. Never copy raw requests or exceptions.
    try {
      await this.env.POLICY_DB.prepare(
        "INSERT INTO issuance_audit_events (event_id,request_id,client_id,audience,kid,outcome,latency_ms,occurred_at) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          eventId,
          input.success ? (input.data.requestId ?? eventId) : eventId,
          props.success ? props.data.clientId : null,
          input.success ? input.data.aud : null,
          kid,
          outcome,
          Math.max(0, Date.now() - startedAt),
          startedAt,
        )
        .run();
    } catch {
      outcome = "issuance-unavailable";
      console.warn(JSON.stringify({ event: "issuance-audit-unavailable", eventId }));
    }
    this.ctx.waitUntil(
      this.env.POLICY_DB.prepare(
        "INSERT INTO issuance_metrics (minute_bucket,outcome,count) VALUES (?,?,1) ON CONFLICT(minute_bucket,outcome) DO UPDATE SET count=count+1",
      )
        .bind(Math.floor(Date.now() / 60_000), outcome)
        .run()
        .catch(() => {
          console.warn(JSON.stringify({ event: "issuance-metrics-unavailable" }));
        }),
    );
    if (outcome !== "success" || assertion === undefined) throw new Error(outcome);
    return assertion;
  }

  private async issueAssertion(
    input: IssueRequest,
    clientId: string,
    onKey: (kid: string) => void,
  ): Promise<string> {
    const nowSeconds = () => Math.floor(Date.now() / 1_000);
    try {
      const config = issuerConfigSchema.parse({
        ISSUER_URL: this.env.ISSUER_URL,
        RATE_LIMIT_PER_MINUTE: this.env.RATE_LIMIT_PER_MINUTE,
      });
      await enforceRateLimit(
        this.env.POLICY_DB,
        clientId,
        config.RATE_LIMIT_PER_MINUTE,
        nowSeconds(),
      );
      return await issueToken(
        {
          issuer: config.ISSUER_URL,
          policies: policyRepository(this.env.POLICY_DB),
          keys: keyRepository(this.env.KEY_DB),
          signer: {
            sign: async (signingInput) => {
              onKey(signingInput.key.kid);
              return signer(this.env.KEY_DB, this.env).sign(signingInput);
            },
          },
          nowSeconds,
          newTokenId: () => crypto.randomUUID(),
        },
        { clientId, audience: input.aud },
      );
    } catch (error) {
      if (error instanceof IssuanceError) {
        if (error.reason === "unknown-client" || error.reason === "client-disabled") {
          throw new Error("caller-denied");
        }
        if (error.reason === "audience-not-granted" || error.reason === "unknown-audience") {
          throw new Error("audience-denied");
        }
      }
      if (error instanceof Error && error.message === "rate-limited") throw error;
      throw new Error("issuance-unavailable");
    }
  }
}
