import { z } from "zod";
import type { AdminEnv } from "./auth.js";

export async function checkHealth(env: AdminEnv) {
  const issuer = z.url().startsWith("https://").parse(env.ISSUER_URL);
  // The issuer strips a trailing slash when it builds URLs, so match that here.
  const base = issuer.replace(/\/$/, "");
  const now = Date.now();
  for (const [name, path] of [
    ["discovery", "/.well-known/openid-configuration"],
    ["jwks", "/jwks.json"],
  ]) {
    const started = Date.now();
    let healthy = false;
    try {
      const response = await fetch(base + path, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("http-error");
      const data = await response.json();
      if (name === "discovery") {
        const metadata = z
          .object({ issuer: z.literal(issuer), jwks_uri: z.literal(base + "/jwks.json") })
          .safeParse(data);
        healthy = metadata.success;
      } else {
        const jwks = z
          .object({
            keys: z
              .array(
                z
                  .object({
                    kid: z.string().min(1),
                    alg: z.enum(["RS256", "ES256"]),
                    kty: z.string(),
                  })
                  .passthrough(),
              )
              .min(1),
          })
          .safeParse(data);
        healthy =
          jwks.success &&
          jwks.data.keys.every(
            (key) => !["d", "p", "q", "dp", "dq", "qi", "k"].some((field) => field in key),
          );
      }
    } catch {
      healthy = false;
    }
    const previous = await env.ADMIN_DB.prepare("SELECT healthy FROM health_checks WHERE name=?")
      .bind(name)
      .first<{ healthy: number }>();
    await env.ADMIN_DB.prepare(
      "INSERT INTO health_checks (name,healthy,checked_at,latency_ms,detail) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET healthy=excluded.healthy,checked_at=excluded.checked_at,latency_ms=excluded.latency_ms,detail=excluded.detail",
    )
      .bind(
        name,
        Number(healthy),
        now,
        Date.now() - started,
        healthy ? "ok" : "unavailable-or-invalid",
      )
      .run();
    if ((!previous && !healthy) || (previous && previous.healthy !== Number(healthy)))
      console.warn(
        JSON.stringify({ event: "issuer-health-changed", check: name, healthy, checkedAt: now }),
      );
  }
}

export async function overview(env: AdminEnv) {
  const since = Math.floor((Date.now() - 86_400_000) / 60_000);
  const [health, metrics, counts] = await Promise.all([
    env.ADMIN_DB.prepare("SELECT * FROM health_checks ORDER BY name").all(),
    env.POLICY_DB.prepare(
      "SELECT minute_bucket,outcome,count FROM issuance_metrics WHERE minute_bucket >= ? ORDER BY minute_bucket",
    )
      .bind(since)
      .all<{ minute_bucket: number; outcome: string; count: number }>(),
    env.POLICY_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM clients) AS clients,(SELECT COUNT(*) FROM clients WHERE enabled=1) AS enabledClients,(SELECT COUNT(*) FROM audiences) AS audiences,(SELECT COUNT(*) FROM client_audience_grants) AS grants",
    ).first(),
  ]);
  const outcomes: Record<string, number> = {};
  for (const row of metrics.results)
    outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + row.count;
  const issued = outcomes.success ?? 0,
    unavailable = outcomes["issuance-unavailable"] ?? 0;
  // Caller/policy denials are expected decisions, not availability failures.
  const availability = issued + unavailable ? (issued / (issued + unavailable)) * 100 : null;
  return {
    issuer: env.ISSUER_URL ?? null,
    counts,
    health: health.results,
    metrics: metrics.results,
    outcomes,
    availability,
    sloTarget: z.coerce
      .number()
      .min(0)
      .max(100)
      .parse(env.ISSUANCE_SLO_PERCENT ?? "99.9"),
    since: since * 60_000,
  };
}

export async function maintainAdmin(env: AdminEnv) {
  const now = Date.now();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("DELETE FROM auth_rate_limits WHERE minute_bucket < ?").bind(
      Math.floor(now / 60_000) - 60,
    ),
    env.ADMIN_DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now),
    env.ADMIN_DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").bind(now),
    env.ADMIN_DB.prepare("DELETE FROM access_step_up_challenges WHERE expires_at <= ?").bind(now),
    env.ADMIN_DB.prepare("DELETE FROM bootstrap_invites WHERE expires_at <= ?").bind(now),
  ]);
  if (env.ISSUER_URL) await checkHealth(env);
}
