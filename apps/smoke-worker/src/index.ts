import {
  createOidcClient,
  OidcClientError,
  type IssuerBinding,
} from "@workers-workload-identity/client";
import { importJWK, jwtVerify, type JWK } from "jose";
import { z } from "zod";
import { runE2e, type E2eEnv } from "./e2e.js";

export interface Env extends E2eEnv {
  OIDC_ISSUER: IssuerBinding;
  ROTATION: {
    plan(input: {
      algorithm: "RS256";
      prepublishSeconds: number;
      retirementGraceSeconds: number;
    }): Promise<unknown>;
    listKeys(): Promise<unknown>;
  };
  SMOKE_TOKEN: string;
  ISSUER_URL: string;
  SMOKE_AUDIENCE: string;
  SMOKE_SUBJECT: string;
}

const keysSchema = z.object({
  keys: z.array(z.object({ kid: z.string(), state: z.string() }).passthrough()),
  runs: z.array(z.unknown()),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = { "Cache-Control": "no-store" };
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/check", "/keys", "/rotation", "/e2e"].includes(path)) {
      return new Response("Not found", { status: 404, headers });
    }
    const encoder = new TextEncoder();
    const authorization = request.headers.get("Authorization") ?? "";
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode("workers-workload-identity smoke authorization"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const expected = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`Bearer ${env.SMOKE_TOKEN}`),
    );
    if (
      env.SMOKE_TOKEN.length < 32 ||
      authorization.length > 512 ||
      !(await crypto.subtle.verify("HMAC", key, expected, encoder.encode(authorization)))
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    if (path === "/e2e") return runE2e(request, env);
    let stage = "rotation";
    try {
      if (path === "/keys") {
        const status = keysSchema.parse(await env.ROTATION.listKeys());
        return Response.json(
          { keys: status.keys.map(({ kid, state }) => ({ kid, state })), runs: status.runs },
          { headers },
        );
      }
      if (path === "/rotation") {
        return Response.json(
          await env.ROTATION.plan({
            algorithm: "RS256",
            prepublishSeconds: 60,
            retirementGraceSeconds: 300,
          }),
          { status: 202, headers },
        );
      }
      stage = "input";
      const input = z
        .strictObject({ mode: z.enum(["active", "disabled"]).default("active") })
        .parse(await request.json());
      stage = "issue";
      const client = createOidcClient(env.OIDC_ISSUER);
      if (input.mode === "disabled") {
        try {
          await client.issue({ aud: env.SMOKE_AUDIENCE });
        } catch (error) {
          if (error instanceof OidcClientError && error.code === "caller-denied") {
            return Response.json({ ok: true, callerDenied: true }, { headers });
          }
          throw error;
        }
        throw new Error("disabled caller issued a token");
      }
      const token = await client.issue({ aud: env.SMOKE_AUDIENCE });
      stage = "jwks";
      const response = await fetch(`${env.ISSUER_URL}/jwks.json`, {
        cache: "no-store",
        redirect: "manual",
      });
      if (!response.ok) throw new Error("jwks-unavailable");
      const jwks = z
        .object({ keys: z.array(z.object({ kid: z.string(), alg: z.string() }).passthrough()) })
        .parse(await response.json());
      stage = "verification";
      let verified = false;
      for (const jwk of jwks.keys.filter((key) => key.alg === "RS256")) {
        try {
          const { payload, protectedHeader } = await jwtVerify(
            token,
            await importJWK(jwk as JWK, "RS256"),
            {
              issuer: env.ISSUER_URL,
              audience: env.SMOKE_AUDIENCE,
              subject: env.SMOKE_SUBJECT,
              algorithms: ["RS256"],
              requiredClaims: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
            },
          );
          if (
            protectedHeader.kid !== jwk.kid ||
            typeof payload.iat !== "number" ||
            typeof payload.exp !== "number" ||
            payload.exp - payload.iat > 300
          )
            throw new Error("invalid-claims");
          verified = true;
          break;
        } catch {
          /* Try the other public key during rotation. */
        }
      }
      if (!verified) throw new Error("verification-failed");
      stage = "audience-policy";
      let audienceDenied = false;
      try {
        await client.issue({ aud: `${env.SMOKE_AUDIENCE}:forbidden` });
      } catch (error) {
        audienceDenied = error instanceof OidcClientError && error.code === "audience-denied";
      }
      if (!audienceDenied) throw new Error("audience-policy-failed");
      return Response.json(
        { ok: true, signatureVerified: true, audienceDenied: true },
        { headers },
      );
    } catch (error) {
      return Response.json(
        {
          error: "smoke-failed",
          stage,
          ...(error instanceof OidcClientError ? { code: error.code } : {}),
        },
        { status: 503, headers },
      );
    }
  },
} satisfies ExportedHandler<Env>;
