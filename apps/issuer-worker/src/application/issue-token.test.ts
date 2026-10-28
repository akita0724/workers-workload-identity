import { describe, expect, it, vi } from "vitest";
import { issueToken, type IssueTokenPorts } from "./issue-token.js";

function ports(): IssueTokenPorts {
  return {
    issuer: "https://issuer.example",
    policies: {
      getClient: async (clientId) => ({
        clientId,
        subject: "service:example",
        enabled: true,
        allowedAudiences: new Set(["urn:allowed"]),
      }),
      getAudience: async (audience) => ({
        audience,
        algorithm: "RS256",
        tokenLifetimeSeconds: 300,
      }),
    },
    keys: {
      listSigningKeys: async () => [{ kid: "key-1", algorithm: "RS256", state: "active" }],
    },
    signer: { sign: vi.fn(async () => "signed.jwt") },
    nowSeconds: () => 1_000,
    newTokenId: () => "token-1",
  };
}

describe("issueToken", () => {
  it("never signs for a client without an audience grant", async () => {
    const dependencies = ports();
    await expect(
      issueToken(dependencies, { clientId: "caller", audience: "urn:forbidden" }),
    ).rejects.toMatchObject({ reason: "audience-not-granted" });
    expect(dependencies.signer.sign).not.toHaveBeenCalled();
  });

  it("passes only approved claims and the active key to the signer", async () => {
    const dependencies = ports();
    await expect(
      issueToken(dependencies, { clientId: "caller", audience: "urn:allowed" }),
    ).resolves.toBe("signed.jwt");
    expect(dependencies.signer.sign).toHaveBeenCalledWith({
      key: { kid: "key-1", algorithm: "RS256", state: "active" },
      issuer: "https://issuer.example",
      subject: "service:example",
      audience: "urn:allowed",
      issuedAt: 1_000,
      expiresAt: 1_300,
      tokenId: "token-1",
    });
  });

  it("fails closed when the configured lifetime exceeds five minutes", async () => {
    const dependencies = ports();
    dependencies.policies.getAudience = async (audience) => ({
      audience,
      algorithm: "RS256",
      tokenLifetimeSeconds: 301,
    });
    await expect(
      issueToken(dependencies, { clientId: "caller", audience: "urn:allowed" }),
    ).rejects.toMatchObject({ reason: "invalid-audience-policy" });
    expect(dependencies.signer.sign).not.toHaveBeenCalled();
  });
});
