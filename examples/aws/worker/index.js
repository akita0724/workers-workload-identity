import {
  STSClient,
  AssumeRoleWithWebIdentityCommand,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";
import { probe } from "../../shared/probe.js";

export default probe(async (env, assertion) => {
  const sts = new STSClient({ region: env.AWS_REGION, maxAttempts: 1 });
  const { Credentials } = await sts.send(
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: env.AWS_ROLE_ARN,
      RoleSessionName: "workload-identity-probe",
      WebIdentityToken: assertion,
      DurationSeconds: 900,
    }),
  );
  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken)
    throw new Error("missing credentials");
  const client = new STSClient({
    region: env.AWS_REGION,
    maxAttempts: 1,
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
    },
  });
  const identity = await client.send(new GetCallerIdentityCommand({}));
  if (!identity.Arn || !identity.Account) throw new Error("missing identity");
  return { exchange: "ok", api: "sts:GetCallerIdentity" };
});
