// Each run requests a fresh assertion. Neither credentials nor provider response bodies are returned.
async function authorized(request, secret) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(secret));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(header.slice(7)));
}

export function probe(run) {
  return {
    async fetch(request, env) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/")
        return new Response("Not found", { status: 404 });
      if (!(await authorized(request, env.PROBE_SECRET)))
        return new Response("Unauthorized", { status: 401 });
      try {
        const assertion = await env.OIDC_ISSUER.issue({ aud: env.AUDIENCE });
        const result = await run(env, assertion);
        return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json(
          { ok: false, error: "probe_failed" },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
    },
  };
}

export async function jsonRequest(url, options) {
  const response = await fetch(url, { ...options, redirect: "error" });
  if (!response.ok) throw new Error("provider request failed");
  return response.json();
}

export async function checkApi(url, token, headers = {}) {
  const response = await fetch(url, {
    headers: { ...headers, authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (!response.ok) throw new Error("provider API failed");
  await response.body?.cancel();
}
