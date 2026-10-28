export const e2eScenarios = [
  "valid",
  "missing-token",
  "malformed-token",
  "tampered-token",
  "wrong-audience",
  "wrong-subject",
  "wrong-issuer",
  "expired-token",
  "unique-tokens",
  "audience-denied",
] as const;
