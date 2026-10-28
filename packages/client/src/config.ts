import { z } from "zod";
import { callerPropsSchema, type CallerProps } from "@workers-workload-identity/contracts";

const bindingOptionsSchema = z.strictObject({
  binding: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/),
  props: callerPropsSchema,
});

export interface IssuerServiceBinding {
  readonly binding: string;
  readonly service: string;
  readonly entrypoint: "IssuerRpc";
  readonly props: CallerProps;
}

/** Deployment configuration only. This does not set the current execution context. */
export function defineIssuerBinding(options: {
  readonly binding: string;
  readonly service: string;
  readonly props: CallerProps;
}): IssuerServiceBinding {
  const input = bindingOptionsSchema.parse(options);
  return { ...input, entrypoint: "IssuerRpc" };
}
