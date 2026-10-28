export interface ClientPolicy {
  readonly clientId: string;
  readonly subject: string;
  readonly enabled: boolean;
  readonly allowedAudiences: ReadonlySet<string>;
}

export type IssuanceDecision =
  | { readonly allowed: true; readonly subject: string }
  | {
      readonly allowed: false;
      readonly reason: "client-disabled" | "audience-not-granted";
    };

export function authorizeIssuance(client: ClientPolicy, audience: string): IssuanceDecision {
  if (!client.enabled) {
    return { allowed: false, reason: "client-disabled" };
  }
  if (!client.allowedAudiences.has(audience)) {
    return { allowed: false, reason: "audience-not-granted" };
  }
  return { allowed: true, subject: client.subject };
}
