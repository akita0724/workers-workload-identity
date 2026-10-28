export type OperatorRole = "viewer" | "operator" | "security-admin";
export type AdminAuthMode = "passkey" | "cloudflare-access";

export interface Operator {
  readonly id: string;
  readonly role: OperatorRole;
  readonly enabled: boolean;
}

export type AdminAction = "read" | "edit-policy" | "manage-operators" | "rotate-keys";

export function canPerform(operator: Operator, action: AdminAction): boolean {
  if (!operator.enabled) return false;
  if (action === "read") return true;
  if (action === "edit-policy") return operator.role !== "viewer";
  return operator.role === "security-admin";
}
