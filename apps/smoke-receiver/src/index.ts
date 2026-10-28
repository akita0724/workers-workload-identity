import { createLocalJWKSet, jwtVerify } from "jose";

/** Private E2E relying-party fixture. Never bind signing secrets or policy databases here. */
export interface ReceiverEnv {
  ISSUER_METADATA: Fetcher;
  ISSUER_URL: string;
  SMOKE_AUDIENCE: string;
  SMOKE_SUBJECT: string;
}

export default {
  async fetch(request: Request, env: ReceiverEnv): Promise<Response> {
    const headers = { "Cache-Control": "no-store" };
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" || !["/resource", "/short-lived", "/wrong-issuer"].includes(path))
      return new Response("Not found", { status: 404, headers });
    const authorization = request.headers.get("Authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match || authorization.length > 32_800)
      return Response.json({ error: "invalid-token" }, { status: 401, headers });

    // Exercise the issuer's public HTTP handler through a binding, without access
    // to its RPC entrypoint, private key, or D1. Each request refreshes this fixture's JWKS.
    let jwks: ReturnType<typeof createLocalJWKSet>;
    try {
      const response = await env.ISSUER_METADATA.fetch(`${env.ISSUER_URL}/jwks.json`, {
        redirect: "manual",
      });
      if (!response.ok) throw new Error("jwks-unavailable");
      jwks = createLocalJWKSet(await response.json());
    } catch {
      return Response.json({ error: "verification-unavailable" }, { status: 503, headers });
    }
    try {
      const { payload } = await jwtVerify(match[1], jwks, {
        issuer: path === "/wrong-issuer" ? `${env.ISSUER_URL}/untrusted` : env.ISSUER_URL,
        subject: env.SMOKE_SUBJECT,
        audience:
          path === "/short-lived" ? `${env.SMOKE_AUDIENCE}:short-lived` : env.SMOKE_AUDIENCE,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
        maxTokenAge: "300s",
        clockTolerance: 0,
      });
      if (
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 300
      )
        throw new Error("invalid-lifetime");
      return Response.json({ ok: true }, { headers });
    } catch {
      return Response.json({ error: "invalid-token" }, { status: 401, headers });
    }
  },
} satisfies ExportedHandler<ReceiverEnv>;
