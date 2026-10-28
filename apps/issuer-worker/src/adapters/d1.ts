import { z } from "zod";
import { audienceSchema, subjectSchema } from "@workers-workload-identity/contracts";
import type { ClientPolicy } from "@workers-workload-identity/domain-identity";
import type { SigningAlgorithm, SigningKey } from "@workers-workload-identity/domain-keys";
import type {
  AudiencePolicy,
  KeyRepository,
  PolicyRepository,
} from "../application/issue-token.js";

const clientRow = z.strictObject({
  client_id: z.string(),
  subject: subjectSchema,
  enabled: z.number().int().min(0).max(1),
});
const grantRow = z.strictObject({ audience: audienceSchema });
const audienceRow = z.strictObject({
  audience: audienceSchema,
  algorithm: z.enum(["RS256", "ES256"]),
  token_lifetime_seconds: z.number().int().min(1).max(300),
  verified_for_es256: z.number().int().min(0).max(1),
});
const keyRow = z.strictObject({
  kid: z.string(),
  algorithm: z.enum(["RS256", "ES256"]),
  state: z.enum(["prepared", "active", "verifying", "removed"]),
});

export function policyRepository(db: D1Database): PolicyRepository {
  return {
    async getClient(clientId): Promise<ClientPolicy | undefined> {
      const raw = await db
        .prepare("SELECT client_id, subject, enabled FROM clients WHERE client_id = ?")
        .bind(clientId)
        .first();
      if (!raw) return undefined;
      const client = clientRow.parse(raw);
      const rows = await db
        .prepare("SELECT audience FROM client_audience_grants WHERE client_id = ?")
        .bind(clientId)
        .all();
      return {
        clientId: client.client_id,
        subject: client.subject,
        enabled: client.enabled === 1,
        allowedAudiences: new Set(rows.results.map((row) => grantRow.parse(row).audience)),
      };
    },
    async getAudience(audience): Promise<AudiencePolicy | undefined> {
      const raw = await db
        .prepare(
          "SELECT audience, algorithm, token_lifetime_seconds, verified_for_es256 FROM audiences WHERE audience = ?",
        )
        .bind(audience)
        .first();
      if (!raw) return undefined;
      const row = audienceRow.parse(raw);
      if (row.algorithm === "ES256" && row.verified_for_es256 !== 1) {
        throw new Error("ES256 audience has no verification evidence");
      }
      return {
        audience: row.audience,
        algorithm: row.algorithm,
        tokenLifetimeSeconds: row.token_lifetime_seconds,
      };
    },
  };
}

export function keyRepository(db: D1Database): KeyRepository {
  return {
    async listSigningKeys(algorithm: SigningAlgorithm): Promise<readonly SigningKey[]> {
      const rows = await db
        .prepare("SELECT kid, algorithm, state FROM signing_keys WHERE algorithm = ?")
        .bind(algorithm)
        .all();
      return rows.results.map((row) => keyRow.parse(row));
    },
  };
}

export async function enforceRateLimit(
  db: D1Database,
  clientId: string,
  limit: number,
  nowSeconds: number,
): Promise<void> {
  const bucket = Math.floor(nowSeconds / 60);
  const result = await db
    .prepare(
      "INSERT INTO issuance_rate_limits (client_id, minute_bucket, count) VALUES (?, ?, 1) ON CONFLICT(client_id, minute_bucket) DO UPDATE SET count = count + 1 WHERE count < ?",
    )
    .bind(clientId, bucket, limit)
    .run();
  if (result.meta.changes !== 1) throw new Error("rate-limited");
}
