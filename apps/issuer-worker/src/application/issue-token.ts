import { authorizeIssuance, type ClientPolicy } from "@workers-workload-identity/domain-identity";
import {
  selectActiveKey,
  type SigningAlgorithm,
  type SigningKey,
} from "@workers-workload-identity/domain-keys";

export interface AudiencePolicy {
  readonly audience: string;
  readonly algorithm: SigningAlgorithm;
  readonly tokenLifetimeSeconds: number;
}

export interface PolicyRepository {
  getClient(clientId: string): Promise<ClientPolicy | undefined>;
  getAudience(audience: string): Promise<AudiencePolicy | undefined>;
}

export interface KeyRepository {
  listSigningKeys(algorithm: SigningAlgorithm): Promise<readonly SigningKey[]>;
}

export interface TokenSigner {
  sign(input: {
    readonly key: SigningKey;
    readonly issuer: string;
    readonly subject: string;
    readonly audience: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly tokenId: string;
  }): Promise<string>;
}

export interface IssueTokenPorts {
  readonly issuer: string;
  readonly policies: PolicyRepository;
  readonly keys: KeyRepository;
  readonly signer: TokenSigner;
  readonly nowSeconds: () => number;
  readonly newTokenId: () => string;
}

export type IssuanceFailure =
  | "unknown-client"
  | "client-disabled"
  | "audience-not-granted"
  | "unknown-audience"
  | "invalid-audience-policy"
  | "no-active-key";

export class IssuanceError extends Error {
  constructor(readonly reason: IssuanceFailure) {
    super(reason);
    this.name = "IssuanceError";
  }
}

export async function issueToken(
  ports: IssueTokenPorts,
  input: { readonly clientId: string; readonly audience: string },
): Promise<string> {
  const client = await ports.policies.getClient(input.clientId);
  if (!client || client.clientId !== input.clientId) {
    throw new IssuanceError("unknown-client");
  }

  const decision = authorizeIssuance(client, input.audience);
  if (!decision.allowed) {
    throw new IssuanceError(decision.reason);
  }

  const audience = await ports.policies.getAudience(input.audience);
  if (!audience || audience.audience !== input.audience) {
    throw new IssuanceError("unknown-audience");
  }
  if (
    !Number.isSafeInteger(audience.tokenLifetimeSeconds) ||
    audience.tokenLifetimeSeconds < 1 ||
    audience.tokenLifetimeSeconds > 300
  ) {
    throw new IssuanceError("invalid-audience-policy");
  }

  const key = selectActiveKey(
    await ports.keys.listSigningKeys(audience.algorithm),
    audience.algorithm,
  );
  if (!key) {
    throw new IssuanceError("no-active-key");
  }

  const issuedAt = ports.nowSeconds();
  return ports.signer.sign({
    key,
    issuer: ports.issuer,
    subject: decision.subject,
    audience: input.audience,
    issuedAt,
    expiresAt: issuedAt + audience.tokenLifetimeSeconds,
    tokenId: ports.newTokenId(),
  });
}
