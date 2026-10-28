import { describe, expect, it } from "vitest";
import { authorizeIssuance, type ClientPolicy } from "./index.js";

const client: ClientPolicy = {
  clientId: "example-caller",
  subject: "service:example-caller",
  enabled: true,
  allowedAudiences: new Set(["urn:example:allowed"]),
};

describe("issuance authorization", () => {
  it("rejects an audience that is not granted", () => {
    expect(authorizeIssuance(client, "urn:example:other")).toEqual({
      allowed: false,
      reason: "audience-not-granted",
    });
  });

  it("rejects a disabled caller even if the audience remains granted", () => {
    expect(authorizeIssuance({ ...client, enabled: false }, "urn:example:allowed")).toEqual({
      allowed: false,
      reason: "client-disabled",
    });
  });
});
