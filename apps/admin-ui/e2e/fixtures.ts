import type { Page } from "@playwright/test";

// Browser-only fixtures. Production authentication and API code never import this file.
export function createFixtures() {
  const now = Date.now();
  return {
    "/me": {
      id: "alex@example.com",
      role: "security-admin",
      provider: "passkey",
      authenticatedAt: now,
      csrfToken: "browser-test-csrf",
    },
    "/overview": {
      issuer: "https://identity.example.com",
      counts: { clients: 4, enabledClients: 3, audiences: 3, grants: 5 },
      health: ["discovery", "jwks"].map((name) => ({
        name,
        healthy: 1,
        checked_at: now - 60_000,
        latency_ms: name === "discovery" ? 42 : 28,
        detail: "ok",
      })),
      outcomes: { success: 12842, denied: 24 },
      availability: 99.98,
      sloTarget: 99.9,
      since: now - 86400000,
      metrics: Array.from({ length: 24 }, (_, i) => ({
        minute_bucket: Math.floor(now / 60000) - (23 - i) * 60,
        outcome: "success",
        count: 180 + ((i * 137) % 520),
      })),
    },
    "/clients": {
      clients: ["billing-worker", "analytics-pipeline", "edge-api", "legacy-sync"].map((id, i) => ({
        client_id: id,
        subject: `service:${id}`,
        enabled: i === 3 ? 0 : 1,
        version: 0,
        updated_at: now - i * 3600000,
      })),
      grants: [
        { client_id: "billing-worker", audience: "https://api.example.com" },
        { client_id: "analytics-pipeline", audience: "urn:analytics" },
        { client_id: "edge-api", audience: "https://api.example.com" },
      ],
    },
    "/audiences": {
      audiences: ["https://api.example.com", "urn:analytics", "sts.amazonaws.com"].map(
        (audience, i) => ({
          audience,
          algorithm: "RS256",
          token_lifetime_seconds: 120,
          description: ["本番 API のサービス間認証", "分析パイプライン", "AWS の短命な認証情報"][i],
          verified_for_es256: 0,
          exchange_verified: 1,
          mixed_jwks_verified: 1,
          jwks_cache_seconds: 60,
          version: 0,
          updated_at: now,
        }),
      ),
    },
    "/keys": {
      keys: {
        keys: [
          {
            kid: "rs256-202610-prod-a4f82c",
            algorithm: "RS256",
            state: "active",
            public_jwk_json: '{"kty":"RSA","use":"sig"}',
            created_at: now - 86400000,
            published_at: now - 84000000,
            activated_at: now - 78000000,
            remove_not_before: null,
          },
        ],
        runs: [
          {
            id: "rotation-202610-a4f82c",
            algorithm: "RS256",
            state: "active",
            new_kid: "rs256-202610-prod-a4f82c",
            old_kid: null,
            created_at: now - 86400000,
            updated_at: now - 78000000,
            error_code: null,
            workflowStatus: "complete",
          },
        ],
        schedules: [],
        proposals: [],
        evidence: [],
        actions: [],
      },
    },
    "/operators": {
      operators: ["alex@example.com", "ops@example.com"].map((id, i) => ({
        id,
        role: i ? "operator" : "security-admin",
        enabled: 1,
        version: 0,
        created_at: now - 86400000,
        provider_subject: null,
      })),
    },
    "/passkeys": {
      passkeys: [
        {
          credential_id: "key-1",
          name: "MacBook Pro",
          created_at: now - 86400000,
          last_used_at: now,
        },
      ],
    },
    "/audit": {
      events: ["client.create", "audience.update", "provider.update"].map((action, i) => ({
        event_id: `audit-${i}`,
        actor_id: "alex@example.com",
        action,
        target: ["billing-worker", "https://api.example.com", "sts.amazonaws.com"][i],
        occurred_at: now - i * 3600000,
        source: "policy",
        before_json: null,
        after_json: '{"enabled":true}',
      })),
      nextCursor: null,
    },
  };
}
export async function mockApi(
  page: Page,
  options: {
    role?: string;
    provider?: string;
    signedOut?: boolean;
    fail?: string;
    empty?: boolean;
    basePath?: string;
  } = {},
) {
  // The real hosting Worker strips /admin before serving bundled assets.
  if (options.basePath)
    await page.route(`**${options.basePath}/assets/**`, async (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.slice(options.basePath!.length);
      await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
    });
  const fixtures = createFixtures();
  fixtures["/me"].role = options.role ?? "security-admin";
  fixtures["/me"].provider = options.provider ?? "passkey";
  if (options.empty) {
    fixtures["/clients"] = { clients: [], grants: [] };
    fixtures["/audiences"].audiences = [];
    fixtures["/audit"].events = [];
    fixtures["/overview"].metrics = [];
    fixtures["/overview"].counts = { clients: 0, enabledClients: 0, audiences: 0, grants: 0 };
    fixtures["/overview"].outcomes = { success: 0, denied: 0 };
  }
  const mutations: { path: string; method: string; body: unknown; csrf: string | undefined }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(`${options.basePath ?? ""}/api`, "");
    if (path === "/me" && options.signedOut)
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    if (path === options.fail)
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    if (request.method() !== "GET") {
      const body = request.postDataJSON();
      mutations.push({
        path,
        method: request.method(),
        body,
        csrf: request.headers()["x-csrf-token"],
      });
      if (path === "/clients" && request.method() === "POST") {
        fixtures["/clients"].clients.push({
          client_id: body.clientId,
          subject: body.subject,
          enabled: Number(body.enabled),
          version: 0,
          updated_at: Date.now(),
        });
      }
      return route.fulfill({
        json: { id: "created", invitationToken: "example-invitation-for-browser-tests-only" },
      });
    }
    if (!(path in fixtures)) return route.fulfill({ status: 404, json: { error: "not-found" } });
    return route.fulfill({ json: fixtures[path as keyof typeof fixtures] });
  });
  return { fixtures, mutations };
}
