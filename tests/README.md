# Gateway tests

Black-box HTTP tests against a **live** app gateway, hitting it the way the mobile
app does — same auth headers, same paths. Catches gateway/routing/auth regressions
that unit tests can't (e.g. a removed route reappearing, or a service quietly
changing which auth header it accepts).

There are **two suites**, and the difference matters:

| | `make smoke ENV=…` | `make test-gateway` |
|---|---|---|
| Credentials | none | staging test account |
| Writes | **never** | yes (blocks users, edits wishlists) |
| Safe against prod | **yes** | **no** |
| Covers | public surface, auth-is-enforced, privacy regressions, buckets | full authenticated per-service behaviour |

## Smoke suite (read-only, works on prod)

Answers one question for one environment: *is this gateway wired up, serving, and
not leaking what we already fixed?*

```bash
make smoke ENV=staging
make smoke ENV=prod          # prod = api.corneroom.com, the domain real clients use
```

`ENV` is required on purpose — there is no default, for the same reason `make
gateway` has none: a silent default is how you end up verifying the wrong
environment. To point at an ad-hoc target:

```bash
GW_URL=https://<host>/api/v1 PUBLIC_BUCKET=<bucket>[,<bucket>] node tests/smoke.mjs
```

Exit codes: `0` all good · `1` a check failed · `2` usage error.

**Nothing in it is hardcoded.** Every id it needs (a host id, an object URL) is
discovered from the environment it's pointed at, so the same suite is valid
against staging and prod. A check whose data doesn't exist in that environment
**skips visibly** rather than failing — prod has no experiences yet, and that is
not a regression:

```
⏭ GET /experiences/public  — endpoint healthy but empty in this environment
```

What it asserts, beyond routing and health:

- **Auth is enforced** — `/users/me`, `/bookings`, `/wishlists`, `/payments/methods`
  must reject anonymous callers, and the internal KYC-status write must stay 404.
- **Privacy regressions** (see `PRELAUNCH_CHECKLIST.md` §6) — no `pending_revision`
  and no street address on the public feed; coordinates present (or the map has no
  pins) and **deterministic across requests**. Exact-vs-approximate can't be proven
  from outside without the stored value, so the suite asserts the property it can
  prove: a per-request *random* offset would let a caller average it away, and that
  is the regression worth catching.
- **Buckets serve but don't enumerate** — anonymous object listing must 401, while a
  real thumbnail URL must still return 200.

Add a check by editing `tests/smoke.mjs` directly; it's deliberately one flat file
with no fixtures, so it stays readable as a "what does a healthy environment look
like" checklist.

## Authenticated suite (STAGING ONLY)

> **Never point this at production.** It creates blocks and wishlist entries. They
> are cleaned up (the runner continues past failures so cleanup always executes),
> but they are still writes against a live marketplace, and they emit events.

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

For a flow that needs more than one identity or its own polling (e.g. a
referral reward that has to be observed from a second account, or a
Pub/Sub-driven side effect that lands a few seconds late), a case can supply
`run` instead of `path`/`expect` — it does its own fetches and is still
reported through the same ✓/✗ accounting:

```js
{ name: '...', run: async () => { /* throw to fail, resolve to pass */ } }
```

See `lib/booking-flow.mjs` (register a throwaway account, drive it through a
real Stripe-sandbox booking) and `lib/poll.mjs` (poll-with-timeout for async
state), and `services/rewards-referral-flow.mjs` for a full example.

Write flows currently here, all money state-machine transitions:

| File | Guards |
|---|---|
| `rewards-referral-flow.mjs` | CR-588 — cancelling a referral's qualifying booking resets (or voids) the referral |
| `payment-coupon-hold-flow.mjs` | one coupon can only discount one booking at a time; the hold releases when the booking drops it or its draft is deleted |
| `payment-intent-reuse-flow.mjs` | one live PaymentIntent per booking — repeat/re-priced requests reuse it, and an authorized booking refuses a second one |

**Every booking a write flow creates must be torn down before the file ends**
(`teardownBooking` handles any state). The suite runs every 6 hours against a
handful of shared staging listings; uncancelled bookings accumulate until date
collisions make `POST /bookings/initiate` start 400ing. This has already caused
real scheduled-CI flakiness.

A `services/*.mjs.disabled` file is a finished flow that is deliberately NOT
discovered by `run.mjs`. Today that is `payment-dispute-flow.mjs.disabled`
(CR-612 dispute hold): it is blocked on a product race, not on the test — its
header documents exactly what, with the staging evidence, and how to re-enable
it (rename back).

## Roadmap
- **Phase 1 (here):** read-only smoke of key endpoints + auth/security guards.
- **Phase 2:** drive cases from `gateway/app-swagger.yaml` to cover every path
  automatically + validate responses against the schema.
- **Phase 3:** write-path flows with setup/teardown.
