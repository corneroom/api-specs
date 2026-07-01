# Gateway integration tests

Black-box HTTP tests that hit the **live staging app gateway** the way the mobile
app does — same auth headers, same paths. Catches gateway/routing/auth regressions
that unit tests can't (e.g. a removed route reappearing, or a service quietly
changing which auth header it accepts).

## Run

```bash
cp tests/.env.example tests/.env     # fill in a STAGING test account
make test-gateway                    # (or: node tests/run.mjs)
```

Creds come from `tests/.env` (gitignored) or the environment (`GW_URL`,
`TEST_EMAIL`, `TEST_PASSWORD`) so CI can inject them. Never commit real creds.

## Auth model (important)

The mobile `AuthInterceptor` sends **three** headers on every request:
`Authorization: Bearer <jwt>`, `X-Corneroom-Access: <raw>`,
`X-Forwarded-Authorization: Bearer <jwt>`. Backends disagree on which they read —
user-service accepts `X-Corneroom-Access` alone, but **payment-service and
verification-service require `Authorization`**. Tests default to `auth: 'full'`
(all three, like the app). Use `auth: 'access-only'` or `auth: 'none'` for
negative cases.

## Expand coverage (per service)

Each service is one file in `services/`, auto-discovered by `run.mjs`:

```js
// tests/services/booking.mjs
export default {
  name: 'booking-service',
  cases: [
    { name: 'GET /bookings (authed)', path: '/bookings', expect: 200 },
    // { name, method='GET', path, auth='full'|'access-only'|'none', body?, expect: 200|[200,204] }
  ],
};
```

Drop the file in — no wiring needed. Keep Phase 1 **read-only** (GETs + negative
auth checks). Mutating flows (POST/DELETE) need fixtures + cleanup — add those
deliberately per flow, not table-driven.

## Roadmap
- **Phase 1 (here):** read-only smoke of key endpoints + auth/security guards.
- **Phase 2:** drive cases from `gateway/app-swagger.yaml` to cover every path
  automatically + validate responses against the schema.
- **Phase 3:** write-path flows with setup/teardown.
