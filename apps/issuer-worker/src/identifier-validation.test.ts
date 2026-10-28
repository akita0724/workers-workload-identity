import { describe, expect, it } from "vitest";
import {
  audienceSchema,
  issuerUrlSchema,
  subjectSchema,
} from "@workers-workload-identity/contracts";

describe("RFC 7519 StringOrURI identifiers", () => {
  it.each([
    "plain name",
    "service:example",
    "urn:example:a%20b",
    "https://example.com/a?x=1#part",
    "x:/",
    "x://[::1]/",
  ])("accepts %s without changing it", (value) => {
    expect(audienceSchema.parse(value)).toBe(value);
  });
  it.each(["invalid: value", "1bad:value", "urn:bad%xx", "urn:日本語", "https://[not-ipv6]/"])(
    "rejects invalid URI %s",
    (value) => {
      expect(audienceSchema.safeParse(value).success).toBe(false);
      expect(subjectSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("OIDC issuer URL", () => {
  it.each(["https://example.com", "https://example.com/", "https://example.com/tenant/"])(
    "preserves %s",
    (value) => {
      expect(issuerUrlSchema.parse(value)).toBe(value);
    },
  );
  it.each([
    "http://example.com",
    "https://example.com/?",
    "https://example.com/#",
    "https://example.com/?x=1",
    "https://example.com/#fragment",
    "https://user@example.com",
    "https://example.com/a b",
    "https://example.com/%xx",
    "not a URL",
  ])("rejects %s", (value) => {
    expect(issuerUrlSchema.safeParse(value).success).toBe(false);
  });
});
