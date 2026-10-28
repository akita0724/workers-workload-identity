import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapSql,
  smokeSeedSql,
  e2eSeedSql,
  smokeEnabledSql,
  d1QueryArgs,
} from "./staging-sql.mjs";
import { recoverySql } from "./operations.mjs";

// Exercise Wrangler's actual query-batch path, with a fresh, isolated local D1.
// Group successful setup/reads to avoid repeatedly starting the CLI for each assertion.
test(
  "staging D1 operations use query batches, preserve quoting and roll back on failure",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "workers-workload-identity-sql-")),
      config = path.join(dir, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "sql-regression",
        compatibility_date: "2026-10-24",
        d1_databases: [
          {
            binding: "DB",
            database_name: "sql-regression",
            database_id: "00000000-0000-0000-0000-000000000001",
          },
        ],
      }),
    );
    function query(sql, { fails = false } = {}) {
      const args = d1QueryArgs("DB", config, sql, {
        local: true,
        persistTo: path.join(dir, "state"),
      });
      assert.ok(args.includes("--command"));
      assert.ok(!args.includes("--file"));
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            CI: "true",
            WRANGLER_SEND_METRICS: "false",
            WRANGLER_LOG_PATH: path.join(dir, "wrangler.log"),
          },
        },
      );
      assert.ifError(result.error);
      if (fails) {
        assert.notEqual(result.status, 0);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    }
    try {
      const migrations = await Promise.all(
        [
          "policy/0001_initial.sql",
          "admin/0001_initial.sql",
          "admin/0002_access_step_up.sql",
          "admin/0003_management.sql",
          "admin/0004_step_up_actions.sql",
          "policy/0002_operations.sql",
        ].map((name) => readFile(new URL("../migrations/" + name, import.meta.url), "utf8")),
      );
      const input = {
        clientId: "oidc-smoke",
        subject: "service:quote'test",
        audience: "urn:quote'test",
        now: 1,
        eventId: "seed",
      };
      assert.doesNotMatch(smokeSeedSql(input), /BEGIN TRANSACTION|COMMIT;/);
      const initial = query(
        [
          ...migrations,
          smokeSeedSql(input),
          smokeSeedSql({ ...input, eventId: "seed-again" }),
          "SELECT subject,(SELECT COUNT(*) FROM client_audience_grants) AS grants FROM clients",
        ].join("\n"),
      );
      assert.deepEqual(initial.at(-1).results, [{ subject: input.subject, grants: 1 }]);
      // Failure of the audit insert must roll back the preceding policy update.
      query(smokeEnabledSql({ clientId: input.clientId, enabled: 0, now: 2, eventId: "seed" }), {
        fails: true,
      });
      assert.deepEqual(query("SELECT enabled,version FROM clients").at(-1).results, [
        { enabled: 1, version: 0 },
      ]);
      const admin = {
        id: "11111111-1111-4111-8111-111111111111",
        hash: "invite-hash",
        now: 4,
        eventId: "bootstrap",
      };
      const seeded = query(
        [
          smokeEnabledSql({ clientId: input.clientId, enabled: 0, now: 2, eventId: "disable" }),
          smokeEnabledSql({ clientId: input.clientId, enabled: 1, now: 3, eventId: "enable" }),
          e2eSeedSql({ ...input, eventId: "e2e-seed" }),
          e2eSeedSql({ ...input, eventId: "e2e-seed-again" }),
          bootstrapSql(admin),
          `INSERT INTO passkey_credentials (credential_id,operator_id,public_key,counter,transports_json,created_at) VALUES ('lost','${admin.id}',X'0102',0,'[]',4);`,
          "SELECT enabled,version,(SELECT COUNT(*) FROM clients) AS clients,(SELECT COUNT(*) FROM client_audience_grants) AS grants,(SELECT token_lifetime_seconds FROM audiences WHERE token_lifetime_seconds=2) AS short_ttl,(SELECT subject FROM clients WHERE client_id='oidc-smoke-other') AS other_subject FROM clients WHERE client_id='oidc-smoke';",
        ].join("\n"),
      );
      assert.deepEqual(seeded.at(-1).results, [
        {
          enabled: 1,
          version: 2,
          clients: 2,
          grants: 4,
          short_ttl: 2,
          other_subject: input.subject + ":other",
        },
      ]);
      query(bootstrapSql({ ...admin, id: "second-admin", hash: "second-hash" }), { fails: true });
      query("DELETE FROM passkey_credentials", { fails: true });
      const recovered = query(
        recoverySql({
          operatorId: admin.id,
          reason: "Verified identity for lost credentials",
          hash: "a".repeat(64),
          eventId: "22222222-2222-4222-8222-222222222222",
          now: Date.now(),
        }) +
          "\nSELECT id,(SELECT COUNT(*) FROM operators) AS operators,(SELECT COUNT(*) FROM bootstrap_invites) AS invites,(SELECT COUNT(*) FROM passkey_credentials) AS credentials,(SELECT COUNT(*) FROM admin_audit_events WHERE action='operator.cli-recover') AS recoveries FROM operators;",
      );
      assert.deepEqual(recovered.at(-1).results, [
        { id: admin.id, operators: 1, invites: 1, credentials: 0, recoveries: 1 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
