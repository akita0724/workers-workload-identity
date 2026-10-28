import { probe, jsonRequest, checkApi } from "../../shared/probe.js";

export default probe(async (env, assertion) => {
  const body = {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
    federation_rule_id: env.CLAUDE_RULE_ID,
    organization_id: env.CLAUDE_ORGANIZATION_ID,
    service_account_id: env.CLAUDE_SERVICE_ACCOUNT_ID,
  };
  if (env.CLAUDE_WORKSPACE_ID) body.workspace_id = env.CLAUDE_WORKSPACE_ID;
  const token = await jsonRequest("https://api.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (typeof token.access_token !== "string") throw new Error("missing token");
  await checkApi("https://api.anthropic.com/v1/models?limit=1", token.access_token, {
    "anthropic-version": "2023-06-01",
  });
  return { exchange: "ok", api: "claude.models.list" };
});
