import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { adminUrl, makeConfigs, validateSettings } from "./deployment-config.mjs";
import { stagingFetch } from "./staging-http.mjs";
import { bootstrapSql, e2eSeedSql, smokeEnabledSql, d1QueryArgs } from "./staging-sql.mjs";

import { e2eScenarios } from "../apps/smoke-worker/src/e2e-scenarios.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "account-id": { type: "string" },
    "workers-subdomain": { type: "string" },
    "public-url": { type: "string" },
    prefix: { type: "string", default: "oidc" },
    sample: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`Usage:
  pnpm staging:configure --account-id <id> --workers-subdomain <subdomain> [--prefix <worker-name>] [--public-url <https-url>]
  pnpm staging:check [--sample]
  pnpm staging:deploy       (requires Wrangler auth and OIDC_ROTATION_API_TOKEN in the environment)
  pnpm staging:bootstrap    (creates the first administrator invitation)
  pnpm staging:test         (creates the first signing key and runs smoke + Worker-to-Worker E2E tests)
Generated configuration and private local files are kept under .deploy/ (ignored by git).
The smoke Worker uses a secret bearer token and returns validation results only.`);
  process.exit(0);
}
const command = positionals[0];
if (
  positionals.length !== 1 ||
  !["configure", "check", "deploy", "bootstrap", "test"].includes(command)
)
  throw new Error("Use configure, check, deploy, bootstrap or test");
if (values.sample && command !== "check")
  throw new Error("--sample is only available for check; sample resources cannot be deployed");
const dir = path.join(root, ".deploy", values.sample ? "sample" : "staging");
await mkdir(dir, { recursive: true, mode: 0o700 });
async function save(name, value) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
}
async function read(name) {
  return JSON.parse(await readFile(path.join(dir, name), "utf8"));
}
function run(args, { capture = false } = {}) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: settings.accountId,
      WRANGLER_LOG_PATH: path.join(dir, "wrangler.log"),
      WRANGLER_SEND_METRICS: "false",
      CI: "true",
    },
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    throw new Error(`Command failed: pnpm ${args[0]} ${args[1] ?? ""} (exit ${result.status})`);
  }
  return result.stdout;
}
function wrangler(args, options) {
  return run(["exec", "wrangler", ...args], options);
}
let settings;
if (command === "configure") {
  settings = validateSettings({
    accountId: values["account-id"],
    workersSubdomain: values["workers-subdomain"],
    prefix: values.prefix,
    publicUrl: values["public-url"],
  });
  try {
    const existing = validateSettings(await read("settings.json"));
    if (
      existing.accountId !== settings.accountId ||
      existing.prefix !== settings.prefix ||
      existing.workersSubdomain !== settings.workersSubdomain ||
      existing.publicUrl !== settings.publicUrl
    )
      throw new Error(
        "Existing staging target differs; use a separate checkout for another target",
      );
    settings = existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await save("settings.json", settings);
  console.log(`Staging target saved to ${path.join(dir, "settings.json")}`);
  process.exit(0);
}
settings = values.sample
  ? validateSettings({
      accountId: "0".repeat(32),
      workersSubdomain: "example-account",
      prefix: values.prefix,
    })
  : validateSettings(await read("settings.json"));
async function configs({ sample = false } = {}) {
  const result = makeConfigs(settings, root, { sample });
  for (const [kind, config] of Object.entries(result)) await save(`${kind}.json`, config);
  return result;
}
const configPath = (kind) => path.join(dir, `${kind}.json`);
if (command === "check") {
  const config = await configs({
    sample: values.sample || Object.keys(settings.databases).length !== 3,
  });
  run(["--filter", "@workers-workload-identity/admin-ui", "build"]);
  for (const kind of Object.keys(config)) {
    wrangler([
      "deploy",
      "--dry-run",
      "--config",
      configPath(kind),
      "--outdir",
      path.join(dir, "build", kind),
    ]);
    wrangler([
      "types",
      path.join(dir, `${kind}.generated.d.ts`),
      "--config",
      configPath(kind),
      "--include-runtime",
      "false",
      "--env-interface",
      `${kind[0].toUpperCase() + kind.slice(1)}Bindings`,
    ]);
  }
  console.log("All five Workers built successfully; this command did not deploy remote resources.");
  process.exit(0);
}
// Fail before modifying resources if credentials are missing or expired.
wrangler(["whoami"]);
if (command === "deploy") {
  if ((process.env.OIDC_ROTATION_API_TOKEN ?? "").length < 20)
    throw new Error(
      "Set OIDC_ROTATION_API_TOKEN in the local environment (Workers Scripts Edit + Read for the target account); do not paste it into chat",
    );
  console.log(
    `Deploying isolated staging resources: account ${settings.accountId}, prefix ${settings.prefix}`,
  );
  for (const kind of ["policy", "keys", "admin"]) {
    if (settings.databases[kind]) continue;
    const output = wrangler(
      [
        "d1",
        "create",
        `${settings.prefix}-${kind}`,
        "--location",
        "apac",
        "--update-config",
        "false",
      ],
      { capture: true },
    );
    const id = output.match(/["']?database_id["']?\s*[:=]\s*["']([a-f0-9-]{36})["']/)?.[1];
    if (!id)
      throw new Error(
        `Created ${kind} database but could not parse its identifier; inspect the account before retrying`,
      );
    settings.databases[kind] = id;
    await save("settings.json", settings);
    console.log(`Provisioned ${kind} database`);
  }
  await configs();
  for (const [binding, worker] of [
    ["POLICY_DB", "issuer"],
    ["KEY_DB", "issuer"],
    ["ADMIN_DB", "admin"],
  ]) {
    wrangler(["d1", "migrations", "apply", binding, "--remote", "--config", configPath(worker)]);
  }
  let secrets;
  try {
    secrets = await read("secrets.json");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secrets = {
      CSRF_SECRET: randomBytes(32).toString("base64url"),
      SMOKE_TOKEN: randomBytes(32).toString("base64url"),
    };
    await save("secrets.json", secrets);
  }
  await save("admin.secrets.json", { CSRF_SECRET: secrets.CSRF_SECRET });
  await save("smoke.secrets.json", { SMOKE_TOKEN: secrets.SMOKE_TOKEN });
  await save("rotation.secrets.json", { CF_API_TOKEN: process.env.OIDC_ROTATION_API_TOKEN });
  run(["--filter", "@workers-workload-identity/admin-ui", "build"]);
  wrangler(["deploy", "--config", configPath("issuer")]);
  for (const kind of ["rotation", "admin", "receiver", "smoke"])
    wrangler([
      "deploy",
      "--config",
      configPath(kind),
      ...(kind === "receiver" ? [] : ["--secrets-file", path.join(dir, `${kind}.secrets.json`)]),
    ]);
  console.log("Staging deployed. Run pnpm staging:bootstrap and pnpm staging:test.");
  process.exit(0);
}
const config = await configs();
async function execute(worker, binding, sql) {
  const file = path.join(dir, "operation.sql");
  await writeFile(file, sql, { mode: 0o600 });
  wrangler(d1QueryArgs(binding, configPath(worker), sql), { capture: true });
}
if (command === "bootstrap") {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  // A bootstrap can only create the first operator. Other operators use the authenticated API.
  const exists = JSON.parse(
    wrangler(
      [
        "d1",
        "execute",
        "ADMIN_DB",
        "--remote",
        "--config",
        configPath("admin"),
        "--command",
        "SELECT COUNT(*) AS count FROM operators",
        "--json",
      ],
      { capture: true },
    ),
  );
  if (exists[0]?.results?.[0]?.count !== 0)
    throw new Error(
      "An operator already exists; use an authenticated administrator to invite more operators",
    );
  await execute("admin", "ADMIN_DB", bootstrapSql({ id, hash, now, eventId: randomUUID() }));
  await save("bootstrap.json", {
    adminUrl: adminUrl(config.admin.vars),
    operatorId: id,
    invitationToken: token,
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
  });
  console.log(
    `Initial administrator invitation saved to ${path.join(dir, "bootstrap.json")} (15 minutes). Open the admin URL and register a passkey.`,
  );
  process.exit(0);
}
const secrets = await read("secrets.json");
const smokeUrl = `https://${config.smoke.name}.${settings.workersSubdomain}.workers.dev`;
async function probe(endpoint, body = {}, expectedStatus) {
  const response = await stagingFetch(
    smokeUrl + endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secrets.SMOKE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    },
    { retrySafe: endpoint === "/keys" },
  );
  if (expectedStatus === undefined ? !response.ok : response.status !== expectedStatus) {
    const body = await response.json().catch(() => null);
    const stage = [
      "rotation",
      "input",
      "issue",
      "jwks",
      "verification",
      "audience-policy",
      "receiver",
    ].includes(body?.stage)
      ? body.stage
      : undefined;
    const code = [
      "invalid-request",
      "caller-denied",
      "audience-denied",
      "rate-limited",
      "issuance-unavailable",
      "transport-error",
      "invalid-response",
    ].includes(body?.code)
      ? body.code
      : undefined;
    throw new Error(
      `Staging probe ${endpoint} returned HTTP ${response.status}${stage ? ` (stage: ${stage}${code ? `; code: ${code}` : ""})` : ""}`,
    );
  }
  return response.json();
}
let status = await probe("/keys");
if (!status.keys.some((key) => key.state === "active")) {
  let pendingRun = status.runs.find((run) => !["removed", "failed"].includes(run.state))?.id;
  if (!pendingRun) pendingRun = (await probe("/rotation")).id;
  console.log(`Waiting for signing key: rotation ${pendingRun}`);
  const deadline = Date.now() + 180_000;
  do {
    if (Date.now() > deadline)
      throw new Error(
        "Initial key activation did not complete within three minutes; inspect rotation Workflow status",
      );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    status = await probe("/keys");
    const pending = status.runs.find((run) => run.id === pendingRun);
    if (pending?.state === "failed") {
      throw new Error(
        `Rotation ${pendingRun} failed: ${pending.error_code ?? "unknown-error"}. Check the Controller token and Workflow logs, correct the configuration, and start a new rotation.`,
      );
    }
  } while (!status.keys.some((key) => key.state === "active"));
}
const client = `${settings.prefix}-smoke`;
const aud = config.smoke.vars.SMOKE_AUDIENCE;
const subject = config.smoke.vars.SMOKE_SUBJECT;
const now = Date.now();
await execute(
  "issuer",
  "POLICY_DB",
  e2eSeedSql({ clientId: client, subject, audience: aud, now, eventId: randomUUID() }),
);
if (!(await probe("/check")).ok) throw new Error("Assertion validation failed");
console.log(
  "PASS: Service Binding props, RS256 issuance, public JWKS verification, audience rejection",
);
for (const scenario of e2eScenarios) {
  const result = await probe("/e2e", { scenario });
  const expectedReceiverStatus = scenario === "valid" ? 200 : 401;
  if (
    result.ok !== true ||
    result.scenario !== scenario ||
    (scenario === "unique-tokens"
      ? result.uniqueTokens !== 4
      : scenario === "audience-denied"
        ? result.issuanceDenied !== true
        : result.receiverStatus !== expectedReceiverStatus)
  )
    throw new Error(`E2E scenario ${scenario} did not return the expected result`);
  console.log(`PASS: Worker-to-Worker E2E ${scenario}`);
}
async function setEnabled(enabled) {
  await execute(
    "issuer",
    "POLICY_DB",
    smokeEnabledSql({ clientId: client, enabled, now: Date.now(), eventId: randomUUID() }),
  );
}
try {
  await setEnabled(0);
  if (!(await probe("/check", { mode: "disabled" })).callerDenied)
    throw new Error("Caller stop did not take effect");
  const e2e = await probe("/e2e", { scenario: "valid" }, 503);
  if (e2e.stage !== "issue" || e2e.code !== "caller-denied")
    throw new Error("Disabled caller reached the E2E receiver");
  console.log("PASS: caller stop reflected on the next issuance and E2E request");
} finally {
  await setEnabled(1);
}
for (const endpoint of ["/api/me", "/api/clients", "/api/keys"]) {
  const response = await stagingFetch(
    new URL(endpoint.slice(1), adminUrl(config.admin.vars)),
    {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
    { retrySafe: true },
  );
  if (response.status !== 401)
    throw new Error(`Unauthenticated admin ${endpoint}: expected 401, received ${response.status}`);
}
for (const endpoint of ["/issue", "/IssuerRpc/issue"]) {
  const response = await stagingFetch(
    config.issuer.vars.ISSUER_URL + endpoint,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
    { retrySafe: true },
  );
  if (response.status !== 404) throw new Error("Issuer exposed an unexpected HTTP issuance route");
}
console.log("PASS: admin authentication required and issuer HTTP issuance unavailable");
console.log("Staging smoke test passed. No assertion or private key was returned by the probe.");
