import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { adminConfig, createSession, sha256, type AdminEnv } from "./auth.js";

const authenticationBody = z.strictObject({
  challengeId: z.uuid(),
  response: z.object({ id: z.string().min(1) }).passthrough(),
});
const registrationBody = z.strictObject({
  challengeId: z.uuid(),
  invitationToken: z.string().min(32),
  response: z.object({ id: z.string().min(1) }).passthrough(),
});
const challengeRow = z.strictObject({
  id: z.uuid(),
  operator_id: z.uuid().nullable(),
  challenge: z.string(),
  purpose: z.string(),
  invitation_hash: z.string().nullable(),
  expires_at: z.number(),
});
const credentialRow = z.strictObject({
  credential_id: z.string(),
  operator_id: z.uuid(),
  public_key: z.array(z.number().int().min(0).max(255)),
  counter: z.number().int().nonnegative(),
  transports_json: z.string(),
});

export async function enforceAuthRateLimit(env: AdminEnv, request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = await sha256(ip);
  const result = await env.ADMIN_DB.prepare(
    "INSERT INTO auth_rate_limits (ip_hash, minute_bucket, count) VALUES (?, ?, 1) ON CONFLICT(ip_hash, minute_bucket) DO UPDATE SET count = count + 1 WHERE count < 20",
  )
    .bind(ipHash, Math.floor(Date.now() / 60_000))
    .run();
  if (result.meta.changes !== 1) throw new Error("auth-rate-limited");
}

export async function startLogin(env: AdminEnv) {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "passkey") throw new Error("passkey-disabled");
  const options = await generateAuthenticationOptions({
    rpID: config.RP_ID,
    userVerification: "required",
    timeout: 60_000,
  });
  const challengeId = crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    "INSERT INTO webauthn_challenges (id, operator_id, challenge, purpose, expires_at) VALUES (?, NULL, ?, 'login', ?)",
  )
    .bind(challengeId, options.challenge, Date.now() + 120_000)
    .run();
  return { challengeId, options };
}

export async function finishLogin(env: AdminEnv, body: unknown) {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "passkey") throw new Error("passkey-disabled");
  const input = authenticationBody.parse(body);
  const challenge = challengeRow.parse(
    await env.ADMIN_DB.prepare(
      "SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = 'login' AND expires_at > ?",
    )
      .bind(input.challengeId, Date.now())
      .first(),
  );
  const credential = credentialRow.parse(
    await env.ADMIN_DB.prepare(
      "SELECT credential_id, operator_id, public_key, counter, transports_json FROM passkey_credentials WHERE credential_id = ?",
    )
      .bind(input.response.id)
      .first(),
  );
  const result = await verifyAuthenticationResponse({
    response: input.response as unknown as AuthenticationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.ADMIN_ORIGIN,
    expectedRPID: config.RP_ID,
    requireUserVerification: true,
    credential: {
      id: credential.credential_id,
      publicKey: new Uint8Array(credential.public_key),
      counter: credential.counter,
      transports: JSON.parse(credential.transports_json),
    },
  });
  if (!result.verified) throw new Error("invalid-passkey");
  const consumed = await env.ADMIN_DB.prepare(
    "DELETE FROM webauthn_challenges WHERE id = ? AND purpose = 'login' AND expires_at > ?",
  )
    .bind(input.challengeId, Date.now())
    .run();
  if (consumed.meta.changes !== 1) throw new Error("challenge-used");
  const operator = await env.ADMIN_DB.prepare("SELECT enabled FROM operators WHERE id = ?")
    .bind(credential.operator_id)
    .first<{ enabled: number }>();
  if (!operator || operator.enabled !== 1) throw new Error("operator-disabled");
  await updatePasskeyCounter(
    env.ADMIN_DB,
    credential.credential_id,
    credential.counter,
    result.authenticationInfo.newCounter,
  );
  return createSession(env.ADMIN_DB, config.CSRF_SECRET, credential.operator_id, "auth.login");
}

export async function updatePasskeyCounter(
  db: D1Database,
  credentialId: string,
  observedCounter: number,
  nextCounter: number,
) {
  const result = await db
    .prepare(
      "UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ? AND counter = ?",
    )
    .bind(nextCounter, Date.now(), credentialId, observedCounter)
    .run();
  if (result.meta.changes !== 1) throw new Error("counter-conflict");
}

export async function startRegistration(env: AdminEnv, invitationToken: string) {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "passkey") throw new Error("passkey-disabled");
  const invitationHash = await sha256(invitationToken);
  const invitation = await env.ADMIN_DB.prepare(
    "SELECT b.operator_id FROM bootstrap_invites b JOIN operators o ON o.id=b.operator_id WHERE b.token_hash = ? AND b.used_at IS NULL AND b.expires_at > ? AND o.enabled=1",
  )
    .bind(invitationHash, Date.now())
    .first<{ operator_id: string }>();
  if (!invitation) throw new Error("invalid-invitation");
  const options = await generateRegistrationOptions({
    rpName: "OIDC Issuer Admin",
    rpID: config.RP_ID,
    userName: invitation.operator_id,
    userID: new TextEncoder().encode(invitation.operator_id),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 60_000,
  });
  const challengeId = crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    "INSERT INTO webauthn_challenges (id, operator_id, challenge, purpose, invitation_hash, expires_at) VALUES (?, ?, ?, 'registration', ?, ?)",
  )
    .bind(
      challengeId,
      invitation.operator_id,
      options.challenge,
      invitationHash,
      Date.now() + 120_000,
    )
    .run();
  return { challengeId, options };
}

export async function finishRegistration(env: AdminEnv, body: unknown) {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "passkey") throw new Error("passkey-disabled");
  const input = registrationBody.parse(body);
  const invitationHash = await sha256(input.invitationToken);
  const challenge = challengeRow.parse(
    await env.ADMIN_DB.prepare(
      "SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = 'registration' AND expires_at > ?",
    )
      .bind(input.challengeId, Date.now())
      .first(),
  );
  if (challenge.invitation_hash !== invitationHash || !challenge.operator_id) {
    throw new Error("invitation-mismatch");
  }
  const result = await verifyRegistrationResponse({
    response: input.response as unknown as RegistrationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.ADMIN_ORIGIN,
    expectedRPID: config.RP_ID,
    requireUserVerification: true,
  });
  if (!result.verified) throw new Error("invalid-passkey");
  const now = Date.now(),
    operatorId = challenge.operator_id,
    credential = result.registrationInfo.credential;
  const guard =
    "EXISTS (SELECT 1 FROM webauthn_challenges WHERE id=? AND operator_id=? AND purpose='registration-consumed')";
  const results = await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      "UPDATE webauthn_challenges SET purpose='registration-consumed' WHERE id=? AND operator_id=? AND invitation_hash=? AND purpose='registration' AND expires_at>? AND EXISTS (SELECT 1 FROM bootstrap_invites WHERE token_hash=? AND operator_id=? AND used_at IS NULL AND expires_at>?) AND EXISTS (SELECT 1 FROM operators WHERE id=? AND enabled=1)",
    ).bind(
      challenge.id,
      operatorId,
      invitationHash,
      now,
      invitationHash,
      operatorId,
      now,
      operatorId,
    ),
    env.ADMIN_DB.prepare(
      `UPDATE bootstrap_invites SET used_at=? WHERE token_hash=? AND operator_id=? AND used_at IS NULL AND expires_at>? AND ${guard}`,
    ).bind(now, invitationHash, operatorId, now, challenge.id, operatorId),
    env.ADMIN_DB.prepare(
      `INSERT INTO passkey_credentials (credential_id,operator_id,public_key,counter,transports_json,created_at) SELECT ?,?,?,?,?,? WHERE ${guard}`,
    ).bind(
      credential.id,
      operatorId,
      Array.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      now,
      challenge.id,
      operatorId,
    ),
    env.ADMIN_DB.prepare(
      "DELETE FROM webauthn_challenges WHERE id=? AND purpose='registration-consumed'",
    ).bind(challenge.id),
  ]);
  if (
    results[0].meta.changes !== 1 ||
    results[1].meta.changes !== 1 ||
    results[2].meta.changes !== 1
  )
    throw new Error("challenge-used");
  return createSession(
    env.ADMIN_DB,
    config.CSRF_SECRET,
    challenge.operator_id,
    "auth.passkey-register",
  );
}

export async function startAdditionalRegistration(env: AdminEnv, operatorId: string) {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "passkey") throw new Error("passkey-disabled");
  const credentials = await env.ADMIN_DB.prepare(
    "SELECT credential_id FROM passkey_credentials WHERE operator_id=?",
  )
    .bind(operatorId)
    .all<{ credential_id: string }>();
  if (credentials.results.length >= 10) throw new Error("passkey-limit");
  const options = await generateRegistrationOptions({
    rpName: "Workload Identity",
    rpID: config.RP_ID,
    userName: operatorId,
    userID: new TextEncoder().encode(operatorId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: credentials.results.map((key) => ({ id: key.credential_id })),
    timeout: 60_000,
  });
  const challengeId = crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    "INSERT INTO webauthn_challenges (id,operator_id,challenge,purpose,expires_at) VALUES (?,?,?,'additional',?)",
  )
    .bind(challengeId, operatorId, options.challenge, Date.now() + 120_000)
    .run();
  return { challengeId, options };
}

export async function finishAdditionalRegistration(
  env: AdminEnv,
  operatorId: string,
  body: unknown,
) {
  const config = adminConfig(env);
  if (config.ADMIN_AUTH_MODE !== "passkey") throw new Error("passkey-disabled");
  const input = authenticationBody.extend({ name: z.string().trim().min(1).max(80) }).parse(body);
  const challenge = challengeRow.parse(
    await env.ADMIN_DB.prepare(
      "SELECT * FROM webauthn_challenges WHERE id=? AND operator_id=? AND purpose='additional' AND expires_at>?",
    )
      .bind(input.challengeId, operatorId, Date.now())
      .first(),
  );
  const result = await verifyRegistrationResponse({
    response: input.response as unknown as RegistrationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.ADMIN_ORIGIN,
    expectedRPID: config.RP_ID,
    requireUserVerification: true,
  });
  if (!result.verified) throw new Error("invalid-passkey");
  const credential = result.registrationInfo.credential,
    now = Date.now(),
    event = crypto.randomUUID();
  const guard =
    "EXISTS (SELECT 1 FROM webauthn_challenges WHERE id=? AND operator_id=? AND purpose='additional-consumed')";
  const results = await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      "UPDATE webauthn_challenges SET purpose='additional-consumed' WHERE id=? AND operator_id=? AND purpose='additional' AND expires_at>? AND (SELECT COUNT(*) FROM passkey_credentials WHERE operator_id=?)<10 AND EXISTS (SELECT 1 FROM operators WHERE id=? AND enabled=1)",
    ).bind(challenge.id, operatorId, now, operatorId, operatorId),
    env.ADMIN_DB.prepare(
      `INSERT INTO passkey_credentials (credential_id,operator_id,public_key,counter,transports_json,created_at,name) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
    ).bind(
      credential.id,
      operatorId,
      Array.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      now,
      input.name,
      challenge.id,
      operatorId,
    ),
    env.ADMIN_DB.prepare(
      `INSERT INTO admin_audit_events (event_id,actor_id,action,target,after_json,occurred_at) SELECT ?,?,'passkey.add',?,?,? WHERE ${guard}`,
    ).bind(
      event,
      operatorId,
      operatorId,
      JSON.stringify({ name: input.name }),
      now,
      challenge.id,
      operatorId,
    ),
    env.ADMIN_DB.prepare(
      "DELETE FROM webauthn_challenges WHERE id=? AND operator_id=? AND purpose='additional-consumed'",
    ).bind(challenge.id, operatorId),
  ]);
  if (results[0].meta.changes !== 1) throw new Error("challenge-used");
}
