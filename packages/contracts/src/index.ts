import { z } from "zod";

export const clientIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);

// RFC 7519 StringOrURI: a colon makes the entire value an RFC 3986 URI.
// Do not use WHATWG URL parsing for this: it normalizes and accepts invalid URI characters.
const pctEncoded = "%[0-9A-Fa-f]{2}";
const unreserved = "A-Za-z0-9._~\\-";
const subDelims = "!$&'()*+,;=";
const pchar = `(?:[${unreserved}${subDelims}:@]|${pctEncoded})`;
const authority = `(?:[${unreserved}${subDelims}:]|${pctEncoded})*@`;
const regName = `(?:[${unreserved}${subDelims}]|${pctEncoded})*`;
const uriPattern = new RegExp(
  `^[A-Za-z][A-Za-z0-9+.-]*:(?://(${authority})?(\\[[^\\]]+\\]|${regName})(?::[0-9]*)?(?:/${pchar}*)*|/(?:${pchar}+(?:/${pchar}*)*)?|${pchar}+(?:/${pchar}*)*|)(?:\\?(?:${pchar}|[/?])*)?(?:#(?:${pchar}|[/?])*)?(?![\\s\\S])`,
);

function isStringOrUri(value: string): boolean {
  if (!value.includes(":")) return true;
  const match = uriPattern.exec(value);
  if (!match) return false;
  const host = match[2];
  if (!host?.startsWith("[")) return true;
  if (/^\[v[0-9a-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+\]$/i.test(host)) return true;
  try {
    new URL(`http://${host}/`);
    return true;
  } catch {
    return false;
  }
}

const stringOrUri = z.string().refine(isStringOrUri, "Must be an RFC 7519 StringOrURI");
export const subjectSchema = stringOrUri.pipe(z.string().min(3).max(256));
export const audienceSchema = stringOrUri.pipe(z.string().min(1).max(2048));
export const algorithmSchema = z.enum(["RS256", "ES256"]);
export const roleSchema = z.enum(["viewer", "operator", "security-admin"]);

export const issueRequestSchema = z.strictObject({
  aud: audienceSchema,
  requestId: z.uuid().optional(),
});

export type IssueRequest = z.infer<typeof issueRequestSchema>;

// Keep the RPC wire contract independent of Worker implementation imports.
export interface IssuerBinding {
  issue(request: IssueRequest): Promise<string>;
}

export const issuanceErrorCodeSchema = z.enum([
  "invalid-request",
  "caller-denied",
  "audience-denied",
  "rate-limited",
  "issuance-unavailable",
]);
export type IssuanceErrorCode = z.infer<typeof issuanceErrorCodeSchema>;

// Shape validation only. Signature and claims must be verified by the relying party.
export const assertionSchema = z
  .string()
  .max(32_768)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const callerPropsSchema = z.strictObject({ clientId: clientIdSchema });
export type CallerProps = z.infer<typeof callerPropsSchema>;
export const issuerUrlSchema = z
  .url()
  .startsWith("https://")
  .refine((value) => {
    if (!isStringOrUri(value) || value.includes("?") || value.includes("#")) return false;
    try {
      const url = new URL(value);
      return !url.username && !url.password && !/^https:\/\/[^/]*@/.test(value);
    } catch {
      return false;
    }
  }, "Issuer must be an HTTPS URI without userinfo, query, or fragment");
export const issuerConfigSchema = z.strictObject({
  ISSUER_URL: issuerUrlSchema,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000),
});

export const clientCreateSchema = z.strictObject({
  clientId: clientIdSchema,
  subject: subjectSchema,
  enabled: z.boolean().default(true),
  audiences: z.array(audienceSchema).max(64).default([]),
});
export const clientUpdateSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  audiences: z.array(audienceSchema).max(64),
});
export const audienceCreateSchema = z.strictObject({
  audience: audienceSchema,
  algorithm: algorithmSchema,
  tokenLifetimeSeconds: z.number().int().min(1).max(300),
  description: z.string().max(1024).default(""),
  verifiedForEs256: z.boolean().default(false),
  exchangeVerified: z.boolean().default(false),
  mixedJwksVerified: z.boolean().default(false),
  jwksCacheSeconds: z.number().int().nonnegative().max(2_592_000).nullable().default(null),
});
export const audienceUpdateSchema = audienceCreateSchema.omit({ audience: true }).extend({
  version: z.number().int().nonnegative(),
});
export const operatorCreateSchema = z.strictObject({
  id: z.uuid(),
  providerSubject: z.string().min(1).max(512).optional(),
  role: roleSchema,
});
export const rotationPlanSchema = z.strictObject({
  algorithm: algorithmSchema,
  prepublishSeconds: z.number().int().min(60).max(2_592_000),
  retirementGraceSeconds: z.number().int().min(300).max(2_592_000),
});

export const operatorUpdateSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  role: roleSchema,
  enabled: z.boolean(),
});
export const versionSchema = z.strictObject({ version: z.number().int().nonnegative() });
export const reasonSchema = z.string().trim().min(8).max(1024);
export const rotationControlSchema = z.strictObject({
  action: z.enum(["pause", "resume", "retry"]),
  reason: reasonSchema,
});
export const immediateRotationSchema = z.strictObject({
  reason: reasonSchema,
  acknowledgeCacheRisk: z.literal(true),
  expectedKid: z.string().min(1).max(128),
});
export const rotationScheduleSchema = rotationPlanSchema.extend({
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  intervalDays: z.number().int().min(7).max(365),
  nextRunAt: z.number().int().positive(),
});
// Admin is the only trusted caller of this control plane. No private key material is returned.
export interface RotationManagementBinding {
  listKeys(): Promise<unknown>;
  plan(input: unknown): Promise<unknown>;
  propose?(input: unknown, actorId: string): Promise<unknown>;
  approve?(id: string, actorId: string): Promise<unknown>;
  control?(id: string, input: unknown, actorId: string): Promise<unknown>;
  immediateActivate?(id: string, input: unknown, actorId: string): Promise<unknown>;
  configureSchedule?(input: unknown, actorId: string): Promise<unknown>;
}
