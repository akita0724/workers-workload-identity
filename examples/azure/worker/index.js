import { probe, jsonRequest, checkApi } from "../../shared/probe.js";

export default probe(async (env, assertion) => {
  if (
    !/^[0-9a-f-]{36}$/i.test(env.AZURE_TENANT_ID) ||
    !/^[0-9a-f-]{36}$/i.test(env.AZURE_SUBSCRIPTION_ID) ||
    !/^[\w.()-]{1,90}$/.test(env.AZURE_RESOURCE_GROUP)
  )
    throw new Error("invalid Azure configuration");
  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    scope: "https://management.azure.com/.default",
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const token = await jsonRequest(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
  );
  if (typeof token.access_token !== "string") throw new Error("missing token");
  await checkApi(
    `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourcegroups/${encodeURIComponent(env.AZURE_RESOURCE_GROUP)}?api-version=2021-04-01`,
    token.access_token,
  );
  return { exchange: "ok", api: "azure.resourceGroups.get" };
});
