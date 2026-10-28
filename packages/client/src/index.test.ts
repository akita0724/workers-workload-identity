import { describe, expect, it, vi } from "vitest";
import { createOidcClient, OidcClientError, type IssuerBinding } from "./index.js";
import { defineIssuerBinding } from "./config.js";

const token = "header.payload.signature";

describe("caller client", () => {
  it("preserves the RPC receiver and does not cache tokens", async () => {
    const binding = {
      issue: vi.fn(async function (this: IssuerBinding, request) {
        expect(this).toBe(binding);
        expect(request).toEqual({ aud: "urn:allowed" });
        return token;
      }),
    } satisfies IssuerBinding;
    const client = createOidcClient(binding);
    await expect(client.issue({ aud: "urn:allowed" })).resolves.toBe(token);
    await client.issue({ aud: "urn:allowed" });
    expect(binding.issue).toHaveBeenCalledTimes(2);
  });

  it("forwards a UUID correlation ID without changing identity or caching", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const binding = { issue: vi.fn(async () => token) };
    await createOidcClient(binding).issue({ aud: "urn:allowed", requestId });
    expect(binding.issue).toHaveBeenCalledWith({ aud: "urn:allowed", requestId });
  });

  it.each([
    {},
    { aud: "" },
    { aud: "urn:a", requestId: "arbitrary-untrusted-data" },
    { aud: "urn:a", clientId: "spoofed" },
    { aud: "urn:a", sub: "spoofed" },
    { aud: "urn:a", ttl: 900 },
    { aud: "urn:a", alg: "ES256" },
  ])("rejects invalid input before RPC: %j", async (request) => {
    const binding = { issue: vi.fn(async () => token) };
    // Deliberately exercise a JavaScript caller bypassing static checks.
    // @ts-expect-error runtime boundary input
    await expect(createOidcClient(binding).issue(request)).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(binding.issue).not.toHaveBeenCalled();
  });

  it.each([
    "invalid-request",
    "caller-denied",
    "audience-denied",
    "rate-limited",
    "issuance-unavailable",
  ])("classifies %s without retrying", async (code) => {
    const binding = {
      issue: vi.fn(async () => {
        throw new Error(code);
      }),
    };
    await expect(createOidcClient(binding).issue({ aud: "a" })).rejects.toMatchObject({ code });
    expect(binding.issue).toHaveBeenCalledTimes(1);
  });

  it("discards unknown remote error details", async () => {
    const binding = {
      issue: async () => {
        throw new Error("private credential");
      },
    };
    try {
      await createOidcClient(binding).issue({ aud: "a" });
      expect.fail("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(OidcClientError);
      expect(error).toMatchObject({ code: "transport-error", message: "transport-error" });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private credential");
    }
  });

  it.each(["", "not a jwt", "a.b", "a.b.c.d", "a.b." + "c".repeat(32768)])(
    "rejects malformed responses",
    async (response) => {
      await expect(
        createOidcClient({ issue: async () => response }).issue({ aud: "a" }),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );
});

describe("deployment binding configuration", () => {
  it("matches the existing named entrypoint and props", () => {
    expect(
      defineIssuerBinding({
        binding: "OIDC_ISSUER",
        service: "oidc",
        props: { clientId: "example-caller-prod" },
      }),
    ).toEqual({
      binding: "OIDC_ISSUER",
      service: "oidc",
      entrypoint: "IssuerRpc",
      props: { clientId: "example-caller-prod" },
    });
  });

  it.each([{ clientId: "x" }, { clientId: "example-caller-prod", sub: "spoofed" }, {}])(
    "rejects invalid or extended props",
    (props) => {
      expect(() =>
        // @ts-expect-error runtime boundary input
        defineIssuerBinding({ binding: "OIDC_ISSUER", service: "issuer", props }),
      ).toThrow();
    },
  );
});
