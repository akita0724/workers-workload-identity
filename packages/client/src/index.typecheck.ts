// Compile-time contract checks; never executed at runtime.
import { createOidcClient, type IssuerBinding } from "./index.js";
import { defineIssuerBinding } from "./config.js";

function check(binding: IssuerBinding) {
  const client = createOidcClient(binding);
  const result: Promise<string> = client.issue({ aud: "urn:allowed" });
  // @ts-expect-error caller identity must come from configured props
  client.issue({ aud: "urn:allowed", clientId: "example-caller" });
  // @ts-expect-error callers cannot choose subject
  client.issue({ aud: "urn:allowed", sub: "service:spoofed" });
  // @ts-expect-error callers cannot choose TTL
  client.issue({ aud: "urn:allowed", ttl: 600 });
  // @ts-expect-error callers cannot choose algorithm
  client.issue({ aud: "urn:allowed", alg: "ES256" });
  // @ts-expect-error no arbitrary HTTP endpoint transport
  createOidcClient("https://issuer.example");
  // @ts-expect-error props require clientId
  defineIssuerBinding({ binding: "OIDC_ISSUER", service: "issuer", props: {} });
  defineIssuerBinding({
    binding: "OIDC_ISSUER",
    service: "issuer",
    // @ts-expect-error props cannot contain subject overrides
    props: { clientId: "example-caller", sub: "spoofed" },
  });
  defineIssuerBinding({
    binding: "OIDC_ISSUER",
    service: "issuer",
    props: { clientId: "example-caller" },
    // @ts-expect-error named entrypoint cannot be overridden
    entrypoint: "OtherRpc",
  });
  return result;
}
void check;
