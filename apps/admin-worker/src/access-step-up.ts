import { canPerform, type AdminAction } from "@workers-workload-identity/domain-operators";
import { z } from "zod";
import type { AdminEnv, AuthenticatedOperator } from "./auth.js";

export const stepUpAction = z.enum([
  "operator.create",
  "operator.update",
  "operator.delete",
  "operator.recover",
  "rotation.plan",
  "rotation.approve",
  "rotation.control",
  "rotation.schedule",
  "rotation.immediate",
]);
export type StepUpAction = z.infer<typeof stepUpAction>;

const permissions: Record<StepUpAction, AdminAction> = {
  "operator.create": "manage-operators",
  "rotation.plan": "rotate-keys",
  "operator.update": "manage-operators",
  "operator.delete": "manage-operators",
  "operator.recover": "manage-operators",
  "rotation.approve": "rotate-keys",
  "rotation.control": "rotate-keys",
  "rotation.schedule": "rotate-keys",
  "rotation.immediate": "rotate-keys",
};
const CHALLENGE_LIFETIME_MS = 2 * 60_000;
const ACCESS_PROOF_MAX_AGE_MS = 5 * 60_000;

function requireAccessPermission(operator: AuthenticatedOperator, action: StepUpAction) {
  if (
    operator.provider !== "cloudflare-access" ||
    !canPerform({ id: operator.id, role: operator.role, enabled: true }, permissions[action])
  ) {
    throw new Error("forbidden");
  }
}

export async function startAccessStepUp(
  env: AdminEnv,
  operator: AuthenticatedOperator,
  action: StepUpAction,
) {
  requireAccessPermission(operator, action);
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.ADMIN_DB.prepare("DELETE FROM access_step_up_challenges WHERE expires_at <= ?")
    .bind(now)
    .run();
  await env.ADMIN_DB.prepare(
    "INSERT INTO access_step_up_challenges (id, operator_id, provider_subject, action, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, operator.id, operator.providerSubject, action, now, now + CHALLENGE_LIFETIME_MS)
    .run();
  return id;
}

export async function completeAccessStepUp(
  env: AdminEnv,
  operator: AuthenticatedOperator,
  id: string,
) {
  if (operator.provider !== "cloudflare-access") throw new Error("forbidden");
  const now = Date.now();
  if (
    !Number.isSafeInteger(operator.authenticatedAt) ||
    operator.authenticatedAt > now ||
    now - operator.authenticatedAt > ACCESS_PROOF_MAX_AGE_MS
  ) {
    throw new Error("reauth-required");
  }
  const raw = await env.ADMIN_DB.prepare(
    "SELECT action FROM access_step_up_challenges WHERE id = ? AND operator_id = ? AND provider_subject = ? AND expires_at > ? AND verified_at IS NULL AND used_at IS NULL",
  )
    .bind(id, operator.id, operator.providerSubject, now)
    .first<{ action: string }>();
  if (!raw) throw new Error("reauth-required");
  const action = stepUpAction.parse(raw.action);
  requireAccessPermission(operator, action);
  const result = await env.ADMIN_DB.prepare(
    "UPDATE access_step_up_challenges SET verified_at = ? WHERE id = ? AND operator_id = ? AND provider_subject = ? AND action = ? AND expires_at > ? AND verified_at IS NULL AND used_at IS NULL",
  )
    .bind(now, id, operator.id, operator.providerSubject, action, now)
    .run();
  if (result.meta.changes !== 1) throw new Error("reauth-required");
}

export async function accessStepUpStatus(
  env: AdminEnv,
  operator: AuthenticatedOperator,
  id: string,
) {
  if (operator.provider !== "cloudflare-access") throw new Error("forbidden");
  const raw = await env.ADMIN_DB.prepare(
    "SELECT action, verified_at FROM access_step_up_challenges WHERE id = ? AND operator_id = ? AND provider_subject = ? AND expires_at > ? AND used_at IS NULL",
  )
    .bind(id, operator.id, operator.providerSubject, Date.now())
    .first<{ action: string; verified_at: number | null }>();
  if (!raw) throw new Error("reauth-required");
  requireAccessPermission(operator, stepUpAction.parse(raw.action));
  return raw.verified_at !== null;
}

export async function consumeAccessStepUp(
  env: AdminEnv,
  operator: AuthenticatedOperator,
  action: StepUpAction,
  id: string | undefined,
) {
  requireAccessPermission(operator, action);
  if (!id || !z.uuid().safeParse(id).success) throw new Error("reauth-required");
  const now = Date.now();
  const result = await env.ADMIN_DB.prepare(
    "UPDATE access_step_up_challenges SET used_at = ? WHERE id = ? AND operator_id = ? AND provider_subject = ? AND action = ? AND verified_at IS NOT NULL AND verified_at >= ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(now, id, operator.id, operator.providerSubject, action, now - CHALLENGE_LIFETIME_MS, now)
    .run();
  if (result.meta.changes !== 1) throw new Error("reauth-required");
}
