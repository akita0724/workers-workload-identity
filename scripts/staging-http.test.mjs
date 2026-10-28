import { test } from "node:test";
import assert from "node:assert/strict";
import { stagingFetch, StagingConnectionError } from "./staging-http.mjs";

const handshake = () =>
  new TypeError("sensitive remote detail", {
    cause: Object.assign(new Error("private"), { code: "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE" }),
  });
test("retries transient handshake failures only for an explicitly safe operation", async () => {
  let attempts = 0;
  const waits = [];
  const response = await stagingFetch(
    "https://oidc-smoke.example.workers.dev/keys",
    { method: "POST" },
    {
      retrySafe: true,
      fetchImpl: async () => {
        if (++attempts < 3) throw handshake();
        return new Response("{}");
      },
      sleep: async (delay) => waits.push(delay),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
});
test("does not retry a key-generation request with an ambiguous outcome", async () => {
  let attempts = 0;
  await assert.rejects(
    stagingFetch(
      "https://oidc-smoke.example.workers.dev/rotation",
      { method: "POST" },
      {
        fetchImpl: async () => {
          attempts++;
          throw handshake();
        },
      },
    ),
    (error) => error instanceof StagingConnectionError && error.attempts === 1,
  );
  assert.equal(attempts, 1);
});
test("bounds retries and reports endpoint and code without retaining credentials", async () => {
  await assert.rejects(
    stagingFetch(
      "https://user:password@oidc-smoke.example.workers.dev/keys?token=private",
      { headers: { Authorization: "Bearer private" } },
      {
        retrySafe: true,
        fetchImpl: async () => {
          throw handshake();
        },
        sleep: async () => {},
      },
    ),
    (error) => {
      assert.equal(error.attempts, 4);
      assert.match(error.message, /https:\/\/oidc-smoke.example.workers.dev\/keys/);
      assert.match(error.message, /ERR_SSL_SSL\/TLS_ALERT_HANDSHAKE_FAILURE/);
      assert.doesNotMatch(error.message, /password|private|sensitive/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
test("does not retry HTTP failures or certificate validation errors", async () => {
  let calls = 0;
  assert.equal(
    (
      await stagingFetch(
        "https://oidc.example.workers.dev",
        {},
        {
          retrySafe: true,
          fetchImpl: async () => {
            calls++;
            return new Response(null, { status: 401 });
          },
        },
      )
    ).status,
    401,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    stagingFetch(
      "https://oidc.example.workers.dev",
      {},
      {
        retrySafe: true,
        fetchImpl: async () => {
          throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
        },
      },
    ),
    { code: "CERT_HAS_EXPIRED", attempts: 1 },
  );
});
