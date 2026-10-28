import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { OperatorRole } from "@workers-workload-identity/domain-operators";
import type { RotationManagementBinding } from "@workers-workload-identity/contracts";

export interface AdminEnv {
  ADMIN_DB: D1Database;
  POLICY_DB: D1Database;
  ADMIN_AUTH_MODE: string;
  ADMIN_ORIGIN: string;
  ADMIN_BASE_PATH?: string;
  ISSUER_URL?: string;
  ISSUANCE_SLO_PERCENT?: string;
  CSRF_SECRET: string;
  RP_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_STEP_UP_AUD?: string;
  ACCESS_STEP_UP_ORIGIN?: string;
  ASSETS?: Fetcher;
  ROTATION?: RotationManagementBinding;
}

export interface AuthenticatedOperator {
  id: string;
  role: OperatorRole;
  provider: "passkey" | "cloudflare-access";
  providerSubject: string;
  authenticatedAt: number;
  csrfToken: string;
}

const RECENT_AUTH_MAX_AGE_MS = 5 * 60_000;

export function requireRecentAuthentication(operator: AuthenticatedOperator, now = Date.now()) {
  // Access authenticates each request; its JWT iat is not proof of a recent user gesture.
  if (operator.provider !== "passkey") return;
  if (
    !Number.isSafeInteger(operator.authenticatedAt) ||
    operator.authenticatedAt > now ||
    now - operator.authenticatedAt > RECENT_AUTH_MAX_AGE_MS
  ) {
    throw new Error("reauth-required");
  }
}

const operatorRow = z.strictObject({
  id: z.uuid(),
  role: z.enum(["viewer", "operator", "security-admin"]),
  enabled: z.number().int().min(0).max(1),
});

export function adminConfig(env: AdminEnv) {
  const base = z
    .strictObject({
      ADMIN_AUTH_MODE: z.enum(["passkey", "cloudflare-access"]),
      ADMIN_ORIGIN: z.url().startsWith("https://"),
      CSRF_SECRET: z.string().min(32),
    })
    .parse({
      ADMIN_AUTH_MODE: env.ADMIN_AUTH_MODE,
      ADMIN_ORIGIN: env.ADMIN_ORIGIN,
      CSRF_SECRET: env.CSRF_SECRET,
    });
  if (new URL(base.ADMIN_ORIGIN).origin !== base.ADMIN_ORIGIN)
    throw new Error("invalid admin origin");
  if (base.ADMIN_AUTH_MODE === "passkey") {
    const rpID = z.string().min(1).parse(env.RP_ID);
    if (new URL(base.ADMIN_ORIGIN).hostname !== rpID) throw new Error("RP_ID mismatch");
    if (
      env.ACCESS_TEAM_DOMAIN ||
      env.ACCESS_AUD ||
      env.ACCESS_STEP_UP_AUD ||
      env.ACCESS_STEP_UP_ORIGIN
    ) {
      throw new Error("Access config in passkey mode");
    }
    return { ...base, ADMIN_AUTH_MODE: "passkey" as const, RP_ID: rpID };
  }
  const teamDomain = z
    .string()
    .regex(/^[a-z0-9.-]+\.cloudflareaccess\.com$/)
    .parse(env.ACCESS_TEAM_DOMAIN);
  const audience = z.string().min(1).parse(env.ACCESS_AUD);
  const stepUpAudience = z.string().min(1).parse(env.ACCESS_STEP_UP_AUD);
  const stepUpOrigin = z.url().startsWith("https://").parse(env.ACCESS_STEP_UP_ORIGIN);
  if (new URL(stepUpOrigin).origin !== stepUpOrigin) throw new Error("invalid step-up origin");
  if (stepUpOrigin === base.ADMIN_ORIGIN) throw new Error("Access step-up origin must differ");
  if (audience === stepUpAudience) throw new Error("Access step-up AUD must differ");
  if (env.RP_ID) throw new Error("passkey config in Access mode");
  return {
    ...base,
    ADMIN_AUTH_MODE: "cloudflare-access" as const,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: audience,
    ACCESS_STEP_UP_AUD: stepUpAudience,
    ACCESS_STEP_UP_ORIGIN: stepUpOrigin,
  };
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function csrfToken(secret: string, credential: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(credential)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function lookupOperator(
  db: D1Database,
  provider: "passkey" | "cloudflare-access",
  providerSubject: string,
) {
  const raw = await db
    .prepare(
      "SELECT o.id, o.role, o.enabled FROM operators o JOIN operator_identities i ON i.operator_id = o.id WHERE i.provider = ? AND i.provider_subject = ?",
    )
    .bind(provider, providerSubject)
    .first();
  if (!raw) return null;
  const row = operatorRow.parse(raw);
  return row.enabled === 1 ? row : null;
}

export async function authenticate(
  request: Request,
  env: AdminEnv,
): Promise<AuthenticatedOperator | null> {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE === "cloudflare-access") {
    return authenticateAccess(request, env, config.ACCESS_AUD);
  }

  const cookie = request.headers.get("Cookie") ?? "";
  const session = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("oidc_admin_session="))
    ?.slice("oidc_admin_session=".length);
  if (!session) return null;
  const tokenHash = await sha256(session);
  const raw = await env.ADMIN_DB.prepare(
    "SELECT s.operator_id, s.authenticated_at, s.csrf_hash, o.id, o.role, o.enabled FROM admin_sessions s JOIN operators o ON o.id = s.operator_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(tokenHash, Date.now())
    .first();
  if (!raw) return null;
  const row = z
    .strictObject({
      operator_id: z.uuid(),
      authenticated_at: z.number(),
      csrf_hash: z.string(),
      id: z.uuid(),
      role: z.enum(["viewer", "operator", "security-admin"]),
      enabled: z.number().int().min(0).max(1),
    })
    .parse(raw);
  if (row.enabled !== 1) return null;
  const csrf = await csrfToken(config.CSRF_SECRET, session);
  if ((await sha256(csrf)) !== row.csrf_hash) return null;
  return {
    id: row.id,
    role: row.role,
    provider: "passkey",
    providerSubject: row.id,
    authenticatedAt: row.authenticated_at,
    csrfToken: csrf,
  };
}

export async function authenticateAccess(
  request: Request,
  env: AdminEnv,
  audience: string,
): Promise<AuthenticatedOperator | null> {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "cloudflare-access") return null;
  if (audience !== config.ACCESS_AUD && audience !== config.ACCESS_STEP_UP_AUD) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const issuer = `https://${config.ACCESS_TEAM_DOMAIN}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience,
    algorithms: ["RS256"],
  });
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audiences.length !== 1 || audiences[0] !== audience) return null;
  if (payload.type !== "app" || typeof payload.sub !== "string" || !payload.sub) return null;
  const providerSubject = `${issuer}|${payload.sub}`;
  const operator = await lookupOperator(env.ADMIN_DB, "cloudflare-access", providerSubject);
  if (!operator) return null;
  return {
    id: operator.id,
    role: operator.role,
    provider: "cloudflare-access",
    providerSubject,
    authenticatedAt: (payload.iat ?? 0) * 1_000,
    csrfToken: await csrfToken(config.CSRF_SECRET, token),
  };
}

export async function createSession(
  db: D1Database,
  secret: string,
  operatorId: string,
  auditAction?: string,
) {
  const token = randomToken();
  const csrf = await csrfToken(secret, token);
  const now = Date.now();
  const statements = [
    db
      .prepare(
        "INSERT INTO admin_sessions (token_hash, operator_id, csrf_hash, expires_at, authenticated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(await sha256(token), operatorId, await sha256(csrf), now + 8 * 60 * 60 * 1_000, now),
  ];
  if (auditAction)
    statements.push(
      db
        .prepare(
          "INSERT INTO admin_audit_events (event_id,actor_id,action,target,occurred_at) VALUES (?,?,?,?,?)",
        )
        .bind(crypto.randomUUID(), operatorId, auditAction, operatorId, now),
    );
  await db.batch(statements);
  return `oidc_admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`;
}

export function requireMutationProtection(
  request: Request,
  operator: AuthenticatedOperator,
  origin: string,
) {
  if (request.headers.get("Origin") !== origin) throw new Error("invalid-origin");
  if (request.headers.get("X-CSRF-Token") !== operator.csrfToken) throw new Error("invalid-csrf");
}
