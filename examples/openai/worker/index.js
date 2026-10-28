import { probe, jsonRequest, checkApi } from "../../shared/probe.js";

export default probe(async (env, assertion) => {
  const token = await jsonRequest("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: assertion,
      identity_provider_id: env.OPENAI_PROVIDER_ID,
      service_account_id: env.OPENAI_SERVICE_ACCOUNT_ID,
    }),
  });
  if (typeof token.access_token !== "string") throw new Error("missing token");
  await checkApi("https://api.openai.com/v1/models", token.access_token);
  return { exchange: "ok", api: "openai.models.list" };
});
