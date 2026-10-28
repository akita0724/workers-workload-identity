function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// D1 executes the statements in one query request as a batch. Do not send
// BEGIN/COMMIT or use the bulk-import (--file) path for these small operations.
export function d1QueryArgs(binding, configPath, sql, { local = false, persistTo } = {}) {
  return [
    "d1",
    "execute",
    binding,
    local ? "--local" : "--remote",
    "--config",
    configPath,
    "--command",
    sql,
    "--json",
    ...(persistTo ? ["--persist-to", persistTo] : []),
  ];
}

export function bootstrapSql({ id, hash, now, eventId }) {
  return [
    `INSERT INTO operators (id, role, enabled, created_at, updated_at) VALUES (${literal(id)}, 'security-admin', 1, ${now}, ${now});`,
    `INSERT INTO bootstrap_invites VALUES (${literal(hash)}, ${literal(id)}, ${now + 15 * 60_000}, NULL);`,
    `INSERT INTO admin_audit_events (event_id, actor_id, action, target, occurred_at) VALUES (${literal(eventId)}, 'deployment-bootstrap', 'operator.bootstrap', ${literal(id)}, ${now});`,
  ].join("\n");
}

export function smokeSeedSql({ clientId, subject, audience, now, eventId }) {
  return [
    `INSERT INTO audiences (audience, algorithm, token_lifetime_seconds, created_at, updated_at) VALUES (${literal(audience)}, 'RS256', 300, ${now}, ${now}) ON CONFLICT(audience) DO NOTHING;`,
    `INSERT INTO clients (client_id, subject, enabled, created_at, updated_at) VALUES (${literal(clientId)}, ${literal(subject)}, 1, ${now}, ${now}) ON CONFLICT(client_id) DO NOTHING;`,
    `INSERT INTO client_audience_grants VALUES (${literal(clientId)}, ${literal(audience)}) ON CONFLICT DO NOTHING;`,
    `INSERT INTO policy_audit_events (event_id, actor_id, action, target, occurred_at) VALUES (${literal(eventId)}, 'deployment-smoke', 'smoke.seed', ${literal(clientId)}, ${now});`,
  ].join("\n");
}

export function e2eSeedSql({ clientId, subject, audience, now, eventId }) {
  return [
    smokeSeedSql({ clientId, subject, audience, now, eventId }),
    ...[":other", ":short-lived"].flatMap((suffix) => [
      `INSERT INTO audiences (audience, algorithm, token_lifetime_seconds, created_at, updated_at) VALUES (${literal(audience + suffix)}, 'RS256', ${suffix === ":short-lived" ? 2 : 300}, ${now}, ${now}) ON CONFLICT(audience) DO NOTHING;`,
      `INSERT INTO client_audience_grants VALUES (${literal(clientId)}, ${literal(audience + suffix)}) ON CONFLICT DO NOTHING;`,
    ]),
    `INSERT INTO clients (client_id, subject, enabled, created_at, updated_at) VALUES (${literal(clientId + "-other")}, ${literal(subject + ":other")}, 1, ${now}, ${now}) ON CONFLICT(client_id) DO NOTHING;`,
    `INSERT INTO client_audience_grants VALUES (${literal(clientId + "-other")}, ${literal(audience)}) ON CONFLICT DO NOTHING;`,
  ].join("\n");
}

export function smokeEnabledSql({ clientId, enabled, now, eventId }) {
  return [
    `UPDATE clients SET enabled = ${Number(enabled)}, version = version + 1, updated_at = ${now} WHERE client_id = ${literal(clientId)};`,
    `INSERT INTO policy_audit_events (event_id, actor_id, action, target, occurred_at) VALUES (${literal(eventId)}, 'deployment-smoke', 'smoke.${enabled ? "enable" : "disable"}', ${literal(clientId)}, ${now});`,
  ].join("\n");
}
