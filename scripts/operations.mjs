import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function recoverySql({ operatorId, reason, hash, eventId, now }) {
  if (
    !/^[a-f0-9-]{36}$/.test(operatorId) ||
    !reason ||
    reason.length < 8 ||
    reason.length > 1024 ||
    !Number.isSafeInteger(now) ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    throw new Error("Invalid recovery input");
  const id = literal(operatorId),
    event = literal(eventId),
    guard = `EXISTS (SELECT 1 FROM operators WHERE id=${id} AND last_mutation_id=${event})`;
  return [
    `UPDATE operators SET version=version+1,last_mutation_id=${event},updated_at=${now} WHERE id=${id} AND enabled=1 AND role='security-admin';`,
    `DELETE FROM bootstrap_invites WHERE operator_id=${id} AND ${guard};`,
    `INSERT INTO bootstrap_invites (token_hash,operator_id,expires_at) SELECT ${literal(hash)},${id},${now + 900000} WHERE ${guard};`,
    ...["admin_sessions", "webauthn_challenges", "passkey_credentials"].map(
      (table) => `DELETE FROM ${table} WHERE operator_id=${id} AND ${guard};`,
    ),
    `INSERT INTO admin_audit_events (event_id,actor_id,action,target,after_json,occurred_at) SELECT ${event},'deployment-operator','operator.cli-recover',${id},${literal(JSON.stringify({ reason }))},${now} WHERE ${guard};`,
  ].join("\n");
}
export function operationArgs(command, { config, binding, target, file }) {
  if (
    !config ||
    !/^([A-Z][A-Z0-9_]{0,63})$/.test(binding ?? "") ||
    !["local", "remote"].includes(target)
  )
    throw new Error("Specify --config, --binding and --target local|remote explicitly");
  const args = [
    "d1",
    command === "backup" ? "export" : "execute",
    binding,
    "--config",
    path.resolve(config),
    `--${target}`,
  ];
  return command === "backup"
    ? [...args, "--output", path.resolve(file)]
    : [...args, "--file", path.resolve(file), "--yes"];
}
function wrangler(args) {
  return execFileSync(
    process.execPath,
    [path.join(root, "node_modules/wrangler/bin/wrangler.js"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
}
function main() {
  process.umask(0o077);
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      binding: { type: "string" },
      target: { type: "string" },
      out: { type: "string" },
      file: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      "confirm-restore": { type: "boolean" },
      "confirm-revoke-credentials": { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (!["backup", "restore", "recover-admin"].includes(command))
    throw new Error("Use backup, restore, or recover-admin. See docs/operations.md.");
  // Also validates the explicit target before generating credentials or contacting Cloudflare.
  operationArgs("backup", {
    config: v.config,
    binding: v.binding,
    target: v.target,
    file: v.out ?? v.file ?? "unused",
  });
  if (command === "backup") {
    if (!v.out || existsSync(v.out)) throw new Error("--out must name a new .sql file");
    wrangler(
      operationArgs(command, {
        config: v.config,
        binding: v.binding,
        target: v.target,
        file: v.out,
      }),
    );
    chmodSync(v.out, 0o600);
    console.log(`Backup saved to ${path.resolve(v.out)}`);
    return;
  }
  if (command === "restore") {
    if (!v.file || !existsSync(v.file) || !v["confirm-restore"])
      throw new Error(
        "Restore requires --file and --confirm-restore. Use an isolated empty database.",
      );
    wrangler(
      operationArgs(command, {
        config: v.config,
        binding: v.binding,
        target: v.target,
        file: v.file,
      }),
    );
    console.log("Import complete. Validate the restored database before changing any bindings.");
    return;
  }
  if (v.binding !== "ADMIN_DB" || !v["confirm-revoke-credentials"] || !v.out || existsSync(v.out))
    throw new Error(
      "Recovery requires ADMIN_DB, --operator, --reason, --confirm-revoke-credentials and a new --out file",
    );
  const token = randomBytes(32).toString("base64url"),
    now = Date.now();
  const sql = recoverySql({
    operatorId: v.operator,
    reason: v.reason,
    hash: createHash("sha256").update(token).digest("hex"),
    eventId: randomUUID(),
    now,
  });
  writeFileSync(
    v.out,
    JSON.stringify(
      { operatorId: v.operator, invitationToken: token, expiresAt: now + 900000 },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  try {
    const output = JSON.parse(
      wrangler([
        "d1",
        "execute",
        v.binding,
        "--config",
        path.resolve(v.config),
        `--${v.target}`,
        "--command",
        sql,
        "--json",
      ]),
    );
    if (output[0]?.meta?.changes !== 1)
      throw new Error("No enabled security administrator matched the target");
  } catch {
    unlinkSync(v.out);
    throw new Error("Recovery did not complete. Inspect the database audit before retrying.");
  }
  console.log(
    `One-use invitation saved to ${path.resolve(v.out)} (15 minutes). No credential was printed.`,
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
