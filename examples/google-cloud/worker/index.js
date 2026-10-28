import { probe, jsonRequest, checkApi } from "../../shared/probe.js";

export default probe(async (env, assertion) => {
  const token = await jsonRequest("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: env.GOOGLE_PROVIDER,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: assertion,
    }),
  });
  if (typeof token.access_token !== "string") throw new Error("missing token");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.GOOGLE_PROJECT_ID))
    throw new Error("invalid project");
  await checkApi(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${env.GOOGLE_PROJECT_ID}`,
    token.access_token,
  );
  return { exchange: "ok", api: "cloudresourcemanager.projects.get" };
});
