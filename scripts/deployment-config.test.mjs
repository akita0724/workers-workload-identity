import { test } from "node:test";
import assert from "node:assert/strict";
import { adminUrl, makeConfigs, validateSettings } from "./deployment-config.mjs";

const settings = {
  accountId: "a".repeat(32),
  prefix: "test-oidc-staging",
  workersSubdomain: "example-account",
  databases: {
    policy: "11111111-1111-4111-8111-111111111111",
    keys: "22222222-2222-4222-8222-222222222222",
    admin: "33333333-3333-4333-8333-333333333333",
  },
};
test("generated staging bindings keep the trust and data boundaries", () => {
  const config = makeConfigs(settings, "/project");
  assert.deepEqual(
    config.issuer.d1_databases.map((db) => db.binding),
    ["POLICY_DB", "KEY_DB"],
  );
  assert.deepEqual(
    config.admin.d1_databases.map((db) => db.binding),
    ["POLICY_DB", "ADMIN_DB"],
  );
  assert.equal(config.rotation.workers_dev, false);
  assert.equal(config.receiver.workers_dev, false);
  assert.equal(config.receiver.preview_urls, false);
  assert.equal(config.receiver.d1_databases, undefined);
  assert.equal(config.receiver.secrets, undefined);
  assert.deepEqual(config.receiver.services, [
    { binding: "ISSUER_METADATA", service: settings.prefix },
  ]);
  assert.deepEqual(config.smoke.services[2].props, { clientId: `${settings.prefix}-smoke-other` });
  assert.deepEqual(config.smoke.services[3], {
    binding: "E2E_RECEIVER",
    service: `${settings.prefix}-receiver`,
  });
  assert.deepEqual(config.rotation.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.deepEqual(config.smoke.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.equal(config.admin.vars.RP_ID, "test-oidc-staging.example-account.workers.dev");
  assert.deepEqual(config.admin.services[0].props, { caller: "admin" });
  assert.deepEqual(config.smoke.services[1].props, { clientId: "test-oidc-staging-smoke" });
  assert.equal(config.smoke.services[1].entrypoint, "IssuerRpc");
  assert.equal(config.issuer.vars.ISSUER_URL, config.smoke.vars.ISSUER_URL);
  assert.equal(JSON.stringify(config).includes('CF_API_TOKEN":"'), false);
});
test("admin console URL is served under the issuer at /admin/", () => {
  const config = makeConfigs(settings, "/project");
  assert.equal(
    adminUrl(config.admin.vars),
    "https://test-oidc-staging.example-account.workers.dev/admin/",
  );
  const prefixed = makeConfigs({ ...settings, publicUrl: "https://example.com/oidc" }, "/project");
  assert.equal(adminUrl(prefixed.admin.vars), "https://example.com/oidc/admin/");
  assert.equal(
    new URL("api/me", adminUrl(prefixed.admin.vars)).href,
    "https://example.com/oidc/admin/api/me",
  );
});
test("rejects invalid resource names, accounts, and shared databases", () => {
  assert.throws(() => validateSettings({ ...settings, prefix: "Invalid/Name" }));
  assert.throws(() => validateSettings({ ...settings, accountId: "missing" }));
  assert.throws(() => validateSettings({ ...settings, workersSubdomain: "example.workers.dev" }));
  assert.throws(() =>
    validateSettings({
      ...settings,
      databases: { policy: settings.databases.policy, keys: settings.databases.policy },
    }),
  );
  assert.throws(() => makeConfigs({ ...settings, databases: {} }, "/project"));
});

test("default oidc worker name determines issuer URL and every service reference", () => {
  const config = makeConfigs({ ...settings, prefix: "oidc" }, "/project");
  assert.equal(config.issuer.name, "oidc");
  assert.equal(config.issuer.vars.ISSUER_URL, "https://oidc.example-account.workers.dev");
  assert.equal(config.rotation.vars.CF_ISSUER_SCRIPT, "oidc");
  assert.equal(config.smoke.services[1].service, "oidc");
  assert.equal(config.admin.name, "oidc-admin");
  assert.equal(config.rotation.name, "oidc-rotation");
  assert.equal(config.smoke.name, "oidc-smoke");
});
