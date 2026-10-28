import { test } from "node:test";
import assert from "node:assert/strict";
import google from "../google-cloud/worker/index.js";
import azure from "../azure/worker/index.js";
import claude from "../claude/worker/index.js";
import openai from "../openai/worker/index.js";
import aws from "../aws/worker/index.js";
import {
  STSClient,
  AssumeRoleWithWebIdentityCommand,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";

const secret = "s".repeat(40);
const assertion = "test.assertion.signature";
const token = "secret-access-token";
const request = (auth = secret) =>
  new Request("https://probe.example/", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}` },
  });

const cases = [
  {
    name: "google",
    worker: google,
    env: {
      GOOGLE_PROVIDER:
        "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/provider",
      GOOGLE_PROJECT_ID: "example-project",
    },
    exchange: "https://sts.googleapis.com/v1/token",
    api: "https://cloudresourcemanager.googleapis.com/v1/projects/example-project",
    check: (body) => {
      assert.equal(body.subjectToken, assertion);
      assert.equal(body.subjectTokenType, "urn:ietf:params:oauth:token-type:jwt");
    },
  },
  {
    name: "azure",
    worker: azure,
    env: {
      AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_CLIENT_ID: "client",
      AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_RESOURCE_GROUP: "example",
    },
    exchange:
      "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/oauth2/v2.0/token",
    api: "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/example?api-version=2021-04-01",
    form: true,
    check: (body) => {
      assert.equal(body.get("client_assertion"), assertion);
      assert.equal(body.get("grant_type"), "client_credentials");
    },
  },
  {
    name: "claude",
    worker: claude,
    env: {
      CLAUDE_RULE_ID: "fdrl_example",
      CLAUDE_ORGANIZATION_ID: "org",
      CLAUDE_SERVICE_ACCOUNT_ID: "svac_example",
      CLAUDE_WORKSPACE_ID: "wrkspc_example",
    },
    exchange: "https://api.anthropic.com/v1/oauth/token",
    api: "https://api.anthropic.com/v1/models?limit=1",
    check: (body) => {
      assert.equal(body.assertion, assertion);
      assert.equal(body.workspace_id, "wrkspc_example");
    },
  },
  {
    name: "openai",
    worker: openai,
    env: { OPENAI_PROVIDER_ID: "provider", OPENAI_SERVICE_ACCOUNT_ID: "account" },
    exchange: "https://auth.openai.com/oauth/token",
    api: "https://api.openai.com/v1/models",
    check: (body) => {
      assert.equal(body.subject_token, assertion);
      assert.equal(body.identity_provider_id, "provider");
    },
  },
];

for (const item of cases) {
  test(`${item.name}: issues, exchanges and calls the API without returning credentials`, async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(String(url));
      assert.equal(options.redirect, "error");
      if (String(url) === item.exchange) {
        item.check(item.form ? options.body : JSON.parse(options.body));
        return Response.json({ access_token: token });
      }
      assert.equal(String(url), item.api);
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      return Response.json({});
    };
    try {
      const env = {
        ...item.env,
        PROBE_SECRET: secret,
        AUDIENCE: "test-audience",
        OIDC_ISSUER: {
          issue: async ({ aud }) => {
            assert.equal(aud, "test-audience");
            return assertion;
          },
        },
      };
      const result = await item.worker.fetch(request(), env);
      assert.equal(result.status, 200);
      const body = await result.text();
      assert.ok(!body.includes(token) && !body.includes(assertion));
      assert.equal(calls.length, 2);
      assert.equal((await item.worker.fetch(request("wrong"), env)).status, 401);
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("provider failures do not disclose credentials or response bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(`private: ${assertion}`, { status: 400 });
  try {
    const result = await openai.fetch(request(), {
      PROBE_SECRET: secret,
      AUDIENCE: "a",
      OIDC_ISSUER: { issue: async () => assertion },
    });
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { ok: false, error: "probe_failed" });
  } finally {
    globalThis.fetch = original;
  }
});

test("aws exchanges the assertion and checks the resulting identity", async () => {
  const original = STSClient.prototype.send;
  const calls = [];
  STSClient.prototype.send = async function (command) {
    calls.push(command);
    if (command instanceof AssumeRoleWithWebIdentityCommand) {
      assert.equal(command.input.WebIdentityToken, assertion);
      return {
        Credentials: {
          AccessKeyId: "test-id",
          SecretAccessKey: "test-secret",
          SessionToken: token,
        },
      };
    }
    assert.ok(command instanceof GetCallerIdentityCommand);
    return { Arn: "arn:aws:sts::123456789012:assumed-role/test/probe", Account: "123456789012" };
  };
  try {
    const result = await aws.fetch(request(), {
      PROBE_SECRET: secret,
      AUDIENCE: "a",
      AWS_REGION: "us-east-1",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test",
      OIDC_ISSUER: { issue: async () => assertion },
    });
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.ok(!body.includes(token) && !body.includes(assertion) && !body.includes("test-secret"));
    assert.equal(calls.length, 2);
  } finally {
    STSClient.prototype.send = original;
  }
});
