# @workers-workload-identity/domain-operators

Dependency-free role rules for admin console operators. The Admin Worker calls `canPerform(operator, action)` before every admin API action. This package has no Cloudflare, Hono, D1, or browser dependencies.

## Roles

Each operator has one role: `viewer`, `operator`, or `security-admin`.

| Action             | `viewer` | `operator` | `security-admin` |
| ------------------ | -------- | ---------- | ---------------- |
| `read`             | Yes      | Yes        | Yes              |
| `edit-policy`      | No       | Yes        | Yes              |
| `manage-operators` | No       | No         | Yes              |
| `rotate-keys`      | No       | No         | Yes              |

`canPerform` returns `false` for every action when the operator is disabled (`enabled: false`).

In the Admin Worker, `edit-policy` covers clients, audiences, grants, running the health check of the issuer's own discovery metadata and JWKS, and proposing a key rotation. `manage-operators` covers listing, inviting, changing, recovering, and removing operators. `rotate-keys` covers starting, approving, controlling, and scheduling key rotations, and immediate rotation.

The package also exports the `AdminAuthMode` type (`passkey` or `cloudflare-access`).
