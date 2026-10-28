import { test } from "node:test";
import assert from "node:assert/strict";
import { operationArgs, recoverySql } from "./operations.mjs";
test("operations require an explicit target and never accept a shell expression as a binding", () => {
  assert.throws(() =>
    operationArgs("backup", { config: "sample.json", binding: "ADMIN_DB", file: "backup.sql" }),
  );
  assert.throws(() =>
    operationArgs("backup", {
      config: "sample.json",
      binding: "ADMIN_DB;anything",
      target: "remote",
      file: "backup.sql",
    }),
  );
  const args = operationArgs("backup", {
    config: "sample.json",
    binding: "ADMIN_DB",
    target: "local",
    file: "backup.sql",
  });
  assert.ok(args.includes("--local"));
  assert.ok(!args.includes("--remote"));
});
test("recovery is scoped to an enabled security admin, hashes credentials, escapes reasons and writes an audit", () => {
  const sql = recoverySql({
    operatorId: "11111111-1111-4111-8111-111111111111",
    reason: "Verified person's identity",
    hash: "a".repeat(64),
    eventId: "22222222-2222-4222-8222-222222222222",
    now: 12345,
  });
  assert.match(sql, /role='security-admin'/);
  assert.match(sql, /person''s/);
  assert.match(sql, /operator.cli-recover/);
  assert.match(sql, /last_mutation_id/);
  assert.match(sql, /912345/);
  assert.ok(
    sql.indexOf("INSERT INTO bootstrap_invites") < sql.indexOf("DELETE FROM passkey_credentials"),
  );
});
