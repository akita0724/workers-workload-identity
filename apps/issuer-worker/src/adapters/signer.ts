import { importJWK, importPKCS8, jwtVerify, SignJWT, type JWK } from "jose";
import { z } from "zod";
import type { TokenSigner } from "../application/issue-token.js";

const rsaJwk = z.strictObject({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal("RS256"),
  use: z.literal("sig"),
});
const ecJwk = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal("ES256"),
  use: z.literal("sig"),
});
export const publicJwkSchema = z.discriminatedUnion("kty", [rsaJwk, ecJwk]);
export type PublicJwk = z.infer<typeof publicJwkSchema>;

const signingKeyRow = z.strictObject({
  kid: z.string().min(1),
  algorithm: z.enum(["RS256", "ES256"]),
  state: z.enum(["active", "verifying"]),
  secret_binding: z.string().regex(/^SIGNING_KEY_[A-Z0-9_]+$/),
  public_jwk_json: z.string(),
});

export function signer(db: D1Database, env: Record<string, unknown>): TokenSigner {
  return {
    async sign(input): Promise<string> {
      const reservedAt = Date.now();
      const reservationId = crypto.randomUUID();
      const expiresAt = reservedAt + 30_000;
      const reservation = await db
        .prepare(
          "INSERT INTO issuance_reservations (reservation_id, kid, reserved_at, expires_at) SELECT ?, kid, ?, ? FROM signing_keys WHERE kid = ? AND algorithm = ? AND state = 'active'",
        )
        .bind(reservationId, reservedAt, expiresAt, input.key.kid, input.key.algorithm)
        .run();
      if (reservation.meta.changes !== 1) throw new Error("signing key no longer active");
      const raw = await db
        .prepare(
          "SELECT kid, algorithm, state, secret_binding, public_jwk_json FROM signing_keys WHERE kid = ? AND state IN ('active', 'verifying')",
        )
        .bind(input.key.kid)
        .first();
      const row = signingKeyRow.parse(raw);
      if (row.algorithm !== input.key.algorithm) throw new Error("key algorithm changed");
      const jwk = publicJwkSchema.parse(JSON.parse(row.public_jwk_json));
      if (jwk.kid !== row.kid || jwk.alg !== row.algorithm)
        throw new Error("key registry mismatch");
      const secret = env[row.secret_binding];
      if (typeof secret !== "string") throw new Error("signing key binding unavailable");
      const privateKey = await importPKCS8(secret, row.algorithm);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: row.algorithm, kid: row.kid, typ: "JWT" })
        .setIssuer(input.issuer)
        .setSubject(input.subject)
        .setAudience(input.audience)
        .setIssuedAt(input.issuedAt)
        .setNotBefore(input.issuedAt)
        .setExpirationTime(input.expiresAt)
        .setJti(input.tokenId)
        .sign(privateKey);
      const publicKey = await importJWK(jwk as JWK, row.algorithm);
      await jwtVerify(token, publicKey, {
        issuer: input.issuer,
        audience: input.audience,
        algorithms: [row.algorithm],
      });
      if (Date.now() >= expiresAt) throw new Error("issuance reservation expired");
      await db
        .prepare("UPDATE issuance_reservations SET completed_at = ? WHERE reservation_id = ?")
        .bind(Date.now(), reservationId)
        .run();
      return token;
    },
  };
}

export async function listPublicKeys(db: D1Database): Promise<PublicJwk[]> {
  const rows = await db
    .prepare("SELECT kid, algorithm, public_jwk_json FROM signing_keys WHERE state != 'removed'")
    .all();
  return rows.results.map((raw) => {
    const row = z
      .strictObject({
        kid: z.string(),
        algorithm: z.enum(["RS256", "ES256"]),
        public_jwk_json: z.string(),
      })
      .parse(raw);
    const jwk = publicJwkSchema.parse(JSON.parse(row.public_jwk_json));
    if (jwk.kid !== row.kid || jwk.alg !== row.algorithm) throw new Error("key registry mismatch");
    return jwk;
  });
}
