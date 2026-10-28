import {
  createOidcClient,
  OidcClientError,
  type IssuerBinding,
} from "@workers-workload-identity/client";
import { decodeJwt } from "jose";
import { z } from "zod";

import { e2eScenarios } from "./e2e-scenarios.js";
export { e2eScenarios } from "./e2e-scenarios.js";

export interface E2eEnv {
  OIDC_ISSUER: IssuerBinding;
  OIDC_OTHER_ISSUER: IssuerBinding;
  E2E_RECEIVER: Pick<Fetcher, "fetch">;
  SMOKE_AUDIENCE: string;
}

/** Called only after the smoke Worker's bearer-secret authorization. */
export async function runE2e(request: Request, env: E2eEnv): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const parsed = z
    .strictObject({ scenario: z.enum(e2eScenarios) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid-request" }, { status: 400, headers });
  const { scenario } = parsed.data;
  let stage = "issue";
  try {
    const client = createOidcClient(env.OIDC_ISSUER);
    if (scenario === "audience-denied") {
      try {
        await client.issue({ aud: `${env.SMOKE_AUDIENCE}:forbidden` });
      } catch (error) {
        if (error instanceof OidcClientError && error.code === "audience-denied")
          return Response.json({ ok: true, scenario, issuanceDenied: true }, { headers });
        throw error;
      }
      throw new Error("forbidden audience was issued");
    }
    const receive = (token: string | undefined, path = "/resource") =>
      env.E2E_RECEIVER.fetch(`https://receiver.test${path}`, {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
        redirect: "manual",
      });
    if (scenario === "unique-tokens") {
      const tokens = await Promise.all(
        Array.from({ length: 4 }, () => client.issue({ aud: env.SMOKE_AUDIENCE })),
      );
      // Decoding here only checks uniqueness; acceptance is decided by the receiver.
      const ids = tokens.map((token) => decodeJwt(token).jti);
      if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== tokens.length)
        throw new Error("duplicate token ID");
      stage = "receiver";
      const results = await Promise.all(tokens.map((token) => receive(token)));
      if (results.some((result) => result.status !== 200)) throw new Error("receiver rejected");
      for (const result of results) {
        if (!(await result.json<{ ok: boolean }>()).ok) throw new Error("invalid receiver result");
      }
      return Response.json({ ok: true, scenario, uniqueTokens: tokens.length }, { headers });
    }

    let token: string | undefined;
    if (scenario === "malformed-token") token = "not-a-jwt";
    else if (scenario !== "missing-token") {
      const caller =
        scenario === "wrong-subject" ? createOidcClient(env.OIDC_OTHER_ISSUER) : client;
      const audience =
        scenario === "wrong-audience"
          ? `${env.SMOKE_AUDIENCE}:other`
          : scenario === "expired-token"
            ? `${env.SMOKE_AUDIENCE}:short-lived`
            : env.SMOKE_AUDIENCE;
      token = await caller.issue({ aud: audience });
    }
    if (scenario === "tampered-token") {
      const parts = token!.split(".");
      parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
      token = parts.join(".");
    }
    stage = "receiver";
    const path =
      scenario === "expired-token"
        ? "/short-lived"
        : scenario === "wrong-issuer"
          ? "/wrong-issuer"
          : "/resource";
    if (scenario === "expired-token") {
      // Prove this same assertion is accepted before testing expiry. The policy
      // gives this dedicated audience a two-second TTL; no verifier clock override.
      if ((await receive(token, path)).status !== 200) throw new Error("short token rejected");
      await new Promise((resolve) => setTimeout(resolve, 2100));
    }
    const response = await receive(token, path);
    const expectedStatus = scenario === "valid" ? 200 : 401;
    if (response.status !== expectedStatus) throw new Error("unexpected receiver status");
    const result = await response.json<{ ok?: boolean; error?: string }>();
    if (expectedStatus === 200 ? result.ok !== true : result.error !== "invalid-token")
      throw new Error("unexpected receiver result");
    return Response.json({ ok: true, scenario, receiverStatus: response.status }, { headers });
  } catch (error) {
    return Response.json(
      {
        error: "e2e-failed",
        scenario,
        stage,
        ...(error instanceof OidcClientError ? { code: error.code } : {}),
      },
      { status: 503, headers },
    );
  }
}
