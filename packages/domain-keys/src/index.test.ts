import { describe, expect, it } from "vitest";
import { isJwksVisible, selectActiveKey, type SigningKey } from "./index.js";

const key = (kid: string, state: SigningKey["state"]): SigningKey => ({
  kid,
  state,
  algorithm: "RS256",
});

describe("signing key selection", () => {
  it("never selects a prepared or verifying key for new signatures", () => {
    expect(
      selectActiveKey([key("new", "prepared"), key("old", "verifying")], "RS256"),
    ).toBeUndefined();
  });

  it("fails closed if two keys are active for one algorithm", () => {
    expect(() => selectActiveKey([key("a", "active"), key("b", "active")], "RS256")).toThrow();
  });

  it("keeps a verifying key in JWKS during the transition", () => {
    expect(isJwksVisible(key("old", "verifying"))).toBe(true);
    expect(isJwksVisible(key("old", "removed"))).toBe(false);
  });
});
