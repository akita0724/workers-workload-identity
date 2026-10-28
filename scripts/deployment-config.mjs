import path from "node:path";

export function validateSettings(value) {
  const publicUrl = value?.publicUrl;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      publicUrl.endsWith("/")
    )
      throw new Error(
        "publicUrl must be HTTPS without credentials, query, fragment or trailing slash",
      );
  }
  if (!value || typeof value !== "object" || !/^[a-f0-9]{32}$/.test(value.accountId ?? ""))
    throw new Error("accountId must be a 32-character Cloudflare account ID");
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(value.workersSubdomain ?? ""))
    throw new Error(
      "workersSubdomain must be the account's workers.dev subdomain, without a hostname suffix",
    );
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(value.prefix ?? ""))
    throw new Error(
      "prefix must start with a lowercase letter and contain 3 to 41 lowercase letters, digits or hyphens",
    );
  const databases = value.databases ?? {};
  for (const [name, id] of Object.entries(databases)) {
    if (
      !["policy", "keys", "admin"].includes(name) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw new Error("invalid database identifier");
  }
  if (new Set(Object.values(databases)).size !== Object.values(databases).length)
    throw new Error("each database must be separate");
  return {
    accountId: value.accountId,
    workersSubdomain: value.workersSubdomain,
    prefix: value.prefix,
    databases,
    publicUrl,
  };
}

export function adminUrl(adminVars) {
  return new URL(adminVars.ADMIN_BASE_PATH ?? "/", adminVars.ADMIN_ORIGIN).href;
}

export function makeConfigs(raw, root, { sample = false } = {}) {
  const settings = validateSettings(raw);
  const { accountId, prefix, workersSubdomain } = settings;
  const name = (kind) => (kind === "issuer" ? prefix : `${prefix}-${kind}`);
  const publicUrl = settings.publicUrl ?? `https://${prefix}.${workersSubdomain}.workers.dev`;
  const url = () => publicUrl;
  const base = (kind) => ({
    $schema: path.join(root, "node_modules/wrangler/config-schema.json"),
    name: name(kind),
    account_id: accountId,
    main: path.join(root, `apps/${kind === "smoke" ? "smoke" : kind}-worker/src/index.ts`),
    compatibility_date: "2026-10-24",
    workers_dev: kind !== "rotation",
    preview_urls: false,
    observability: { enabled: true, traces: { enabled: true } },
  });
  const db = (kind, binding) => {
    const id =
      settings.databases[kind] ??
      (sample
        ? `00000000-0000-0000-0000-00000000000${{ policy: 1, keys: 2, admin: 3 }[kind]}`
        : undefined);
    if (!id) throw new Error(`database ${kind} has not been provisioned`);
    return {
      binding,
      database_name: name(kind),
      database_id: id,
      migrations_dir: path.join(root, `migrations/${kind === "keys" ? "keys" : kind}`),
    };
  };
  const rotationBinding = {
    binding: "ROTATION",
    service: name("rotation"),
    entrypoint: "RotationRpc",
    props: { caller: "admin" },
  };
  return {
    issuer: {
      ...base("issuer"),
      triggers: { crons: ["17 * * * *"] },
      ...(settings.publicUrl
        ? {
            workers_dev: false,
            routes: [{ pattern: new URL(publicUrl).hostname, custom_domain: true }],
          }
        : {}),
      services: [{ binding: "ADMIN", service: name("admin") }],
      vars: { ISSUER_URL: url("issuer"), RATE_LIMIT_PER_MINUTE: "120" },
      d1_databases: [db("policy", "POLICY_DB"), db("keys", "KEY_DB")],
    },
    rotation: {
      ...base("rotation"),
      triggers: { crons: ["*/5 * * * *"] },
      compatibility_flags: ["global_fetch_strictly_public"],
      vars: {
        ISSUER_URL: url("issuer"),
        CF_ACCOUNT_ID: accountId,
        CF_ISSUER_SCRIPT: name("issuer"),
      },
      secrets: { required: ["CF_API_TOKEN"] },
      workflows: [
        {
          name: name("rotation-workflow"),
          binding: "ROTATION_WORKFLOW",
          class_name: "RotationWorkflow",
        },
      ],
      d1_databases: [db("policy", "POLICY_DB"), db("keys", "KEY_DB")],
    },
    admin: {
      ...base("admin"),
      triggers: { crons: ["*/5 * * * *"] },
      workers_dev: false,
      vars: {
        ADMIN_ORIGIN: new URL(publicUrl).origin,
        ADMIN_BASE_PATH: `${new URL(publicUrl).pathname.replace(/\/$/, "")}/admin/`,
        ADMIN_AUTH_MODE: "passkey",
        ISSUER_URL: publicUrl,
        RP_ID: new URL(url("admin")).hostname,
      },
      secrets: { required: ["CSRF_SECRET"] },
      services: [rotationBinding],
      assets: {
        directory: path.join(root, "apps/admin-ui/dist"),
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
      d1_databases: [db("policy", "POLICY_DB"), db("admin", "ADMIN_DB")],
    },
    receiver: {
      ...base("receiver"),
      main: path.join(root, "apps/smoke-receiver/src/index.ts"),
      compatibility_date: "2026-10-26",
      workers_dev: false,
      vars: {
        ISSUER_URL: url("issuer"),
        SMOKE_AUDIENCE: `urn:${prefix}:smoke`,
        SMOKE_SUBJECT: `service:${prefix}:smoke`,
      },
      services: [{ binding: "ISSUER_METADATA", service: name("issuer") }],
    },
    smoke: {
      ...base("smoke"),
      compatibility_flags: ["global_fetch_strictly_public"],
      vars: {
        ISSUER_URL: url("issuer"),
        SMOKE_AUDIENCE: `urn:${prefix}:smoke`,
        SMOKE_SUBJECT: `service:${prefix}:smoke`,
      },
      secrets: { required: ["SMOKE_TOKEN"] },
      services: [
        rotationBinding,
        {
          binding: "OIDC_ISSUER",
          service: name("issuer"),
          entrypoint: "IssuerRpc",
          props: { clientId: `${prefix}-smoke` },
        },
        {
          binding: "OIDC_OTHER_ISSUER",
          service: name("issuer"),
          entrypoint: "IssuerRpc",
          props: { clientId: `${prefix}-smoke-other` },
        },
        { binding: "E2E_RECEIVER", service: name("receiver") },
      ],
    },
  };
}
