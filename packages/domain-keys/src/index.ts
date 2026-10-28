export type SigningAlgorithm = "RS256" | "ES256";
export type KeyState = "prepared" | "active" | "verifying" | "removed";

export interface SigningKey {
  readonly kid: string;
  readonly algorithm: SigningAlgorithm;
  readonly state: KeyState;
}

export function isJwksVisible(key: SigningKey): boolean {
  return key.state !== "removed";
}

export function selectActiveKey(
  keys: readonly SigningKey[],
  algorithm: SigningAlgorithm,
): SigningKey | undefined {
  const active = keys.filter((key) => key.algorithm === algorithm && key.state === "active");
  if (active.length > 1) {
    throw new Error(`multiple active signing keys for ${algorithm}`);
  }
  return active[0];
}
