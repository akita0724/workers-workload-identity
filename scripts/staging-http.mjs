const retryableCodes = new Set([
  "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "EAI_AGAIN",
]);

export class StagingConnectionError extends Error {
  constructor(url, code, attempts) {
    const target = new URL(url);
    const endpoint = `${target.origin}${target.pathname}`;
    const tls = code.startsWith("ERR_SSL") || code.includes("CERT");
    super(
      `Unable to connect to ${endpoint} (${code}; ${attempts} attempt(s)). ` +
        (tls
          ? "Check the configured workers.dev subdomain, Worker URL availability, and local TLS/proxy settings. Retry after the endpoint becomes reachable."
          : "Check the endpoint, DNS, and network connection, then rerun the test."),
    );
    this.name = "StagingConnectionError";
    this.endpoint = endpoint;
    this.code = code;
    this.attempts = attempts;
  }
}

/** Retry only operations explicitly identified as safe to repeat, never key creation. */
export async function stagingFetch(
  url,
  init = {},
  {
    retrySafe = false,
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const maxAttempts = retrySafe ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      const candidate = error?.cause?.code ?? error?.code;
      const code =
        typeof candidate === "string" && /^[A-Z0-9_/]+$/.test(candidate)
          ? candidate
          : error?.name === "TimeoutError"
            ? "ETIMEDOUT"
            : "NETWORK_ERROR";
      if (attempt < maxAttempts && retryableCodes.has(code)) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      // Do not retain remote error messages, request headers, bodies, or causes.
      throw new StagingConnectionError(url, code, attempt);
    }
  }
}
