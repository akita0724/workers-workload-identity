import {
  assertionSchema,
  issueRequestSchema,
  issuanceErrorCodeSchema,
  type IssuerBinding,
  type IssueRequest,
  type IssuanceErrorCode,
} from "@workers-workload-identity/contracts";

export type {
  CallerProps,
  IssuerBinding,
  IssueRequest,
  IssuanceErrorCode,
} from "@workers-workload-identity/contracts";

export type OidcClientErrorCode = IssuanceErrorCode | "transport-error" | "invalid-response";

export class OidcClientError extends Error {
  constructor(readonly code: OidcClientErrorCode) {
    super(code);
    this.name = "OidcClientError";
  }
}

export interface OidcClient {
  issue(request: IssueRequest): Promise<string>;
}

/** Create inside the caller's request handler; do not retain bindings across requests. */
export function createOidcClient(binding: IssuerBinding): OidcClient {
  return {
    async issue(request) {
      const input = issueRequestSchema.safeParse(request);
      if (!input.success) throw new OidcClientError("invalid-request");
      let response: unknown;
      try {
        // Preserve the RPC receiver. No HTTP fallback, retries, or token caching.
        response = await binding.issue(input.data);
      } catch (error) {
        const code = issuanceErrorCodeSchema.safeParse(
          error instanceof Error ? error.message : undefined,
        );
        // Never attach the remote message, stack, or cause: they may contain credentials.
        throw new OidcClientError(code.success ? code.data : "transport-error");
      }
      const assertion = assertionSchema.safeParse(response);
      if (!assertion.success) throw new OidcClientError("invalid-response");
      return assertion.data;
    },
  };
}
