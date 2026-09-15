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

### Two accounts, and why

| | `TEST_EMAIL` | `TEST_HOST_EMAIL` |
|---|---|---|
| Role | guest / reader | seeded bot **HOST** |
| Hosts anything | no (`has_listing:false`) | yes — a bot-pool listing |
| Needed by | everything | `services/booking-host-flow.mjs` only |
| CI secret | `GATEWAY_TEST_EMAIL` / `…_PASSWORD` | `GATEWAY_TEST_HOST_EMAIL` / `…_PASSWORD` |

Every host-side transition — `PATCH /bookings/{id}/accept`, `/reject`, and the
luggage endpoints — requires `booking.Host.ID == userID` (booking-service
`internal/service/booking.go:1060`, `:930`). The primary account hosts nothing,
so those were undrivable and explicitly descoped in
`booking-lifecycle-flow.mjs`'s and `payouts-flow.mjs`'s headers. The second
credential closes that: `lib/auth.mjs` `loginHost()` mirrors `login()` (same
cached-per-process shape, so `authHeaders(hostTokens, …)` works unchanged) and
`lib/env.mjs` `requireHostCreds()` **throws** instead of exiting, so a run
without it fails that one flow loudly and still executes every other flow's
cleanup.

It must be a **bot** host, for the same reason the fixture pool is bot-only:
that flow books, accepts, declines and cancels for real, and a genuine host is
pushed a notification for each. `lib/booking-flow.mjs` exposes
`pickListingHostedBy` / `pickListingNotHostedBy`, which resolve the fixture from
the bot pool by the host id read from `GET /users/me` — nothing is hardcoded, so
a staging reseed is survivable as long as the named account still hosts a
request-to-book listing.

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

A `run` case can also declare itself **un-drivable in this environment** by
calling `skip('reason')` from `lib/skip.mjs`. It is reported as `⏭` and counted
separately — neither a pass nor a failure. Only ever skip on a missing
capability (no credential, no dependency, wrong environment); a misbehaving
product is a failure.

See `lib/booking-flow.mjs` (register a throwaway account, drive it through a
real Stripe-sandbox booking) and `lib/poll.mjs` (poll-with-timeout for async
state), and `services/rewards-referral-flow.mjs` for a full example.

Write flows currently here, all money state-machine transitions:

| File | Guards |
|---|---|
| `rewards-referral-flow.mjs` | CR-588 — cancelling a referral's qualifying booking resets (or voids) the referral |
| `payment-coupon-hold-flow.mjs` | one coupon can only discount one booking at a time; the hold releases when the booking drops it or its draft is deleted |
| `payment-intent-reuse-flow.mjs` | one live PaymentIntent per booking — repeat/re-priced requests reuse it, and an authorized booking refuses a second one |
| `booking-lifecycle-flow.mjs` | a request-to-book stay is AUTHORIZED and never captured while it waits for the host; a guest cancellation refunds exactly the policy tier (`full_refund_24h` / `fifty_percent_24h` / `no_refund`) |
| `booking-host-flow.mjs` | the HOST side of the same stay, driven as a real seeded bot host (`TEST_HOST_EMAIL`): the request shows up in `GET /bookings/host`; a host cannot decide a booking on someone else's listing; **accept** captures the hold exactly once (booking → `confirmed`, Stripe → `succeeded`, ledger → `completed`) while crediting the host's `stats.earnings` **nothing** (that happens at completion, `booking_completion.go:358`); **decline** voids the hold (Stripe → `canceled`, ledger → `cancelled`, no refund row, nothing charged); and neither decision can be replayed |
| `experience-reservations-flow.mjs` | guide-led Experiences end to end — reserve holds one seat (a repeat Reserve reuses it), the standalone `/payments/charges` captures immediately, a `flexible` cancel >24h out refunds the FULL gross and releases the seat, and a repeat cancel is a no-op |
| `payouts-flow.mjs` | the host-money reads — `/payouts/connect/status`'s documented no-method shape, `/payments/earnings`'s response shape (that endpoint reads a collection nothing writes, so it can carry no money claim), and — on the ledger the product really keeps, `/users/me/stats` → `stats.earnings.<line>` — that a GUEST who pays for a stay and then cancels is credited nothing and gets no payout account. Its header records why Connect onboarding and "earnings moved" are descoped |
| `verification-flow.mjs` | a selfie KYC submission is validated, auto-decided (staging `AI_MODE=mock`), and the approval lands on the user's profile as a verified entry via `verification-events`. Reading it back is covered by `verification-history-read.mjs` |
| `listing-management-flow.mjs` | a HOST's own listing end to end — created at `status:pending`/`verified:false`, read back three ways, edited (applies directly, no admin revision, because it isn't live), NOT reachable by a guest, NOT bookable (and refused by the *discovery trust gate*, not the bot gate), not editable or deletable by anyone else, deleted and gone. Pins the three-flag model — moderation `status` vs the host's `active` toggle vs discovery `verified` — by proving a pause/resume attempt before approval is a 409 that moves neither of the other two |
| `conversation-flow.mjs` | a guest ↔ host thread about a listing: opened (and DEDUPED — a repeat open returns the same conversation), sent, unread-counted, read (`read_by` stamped), replied to, polled, edited by its sender only, and an attachment uploaded through `POST /documents/upload` and fetched back **byte for byte** by the recipient while the raw bucket URL stays private. A third account can read none of it and cannot post into it |
| `community-flow.mjs` | a feed post the suite owns: published public, visible in the author's feed, another user's feed and the anonymous public profile feed; likes idempotent and reversible; views counted; the feed viewer's report reaching moderation; a block hiding **exactly** that author's items and nothing else, and unblock restoring them; author-only delete, and gone from both feeds |
| `review-flow.mjs` | who may review, and when: a stay that hasn't started can't be reviewed, a stranger to the booking can't review it, an unknown booking 404s, malformed bodies 422, an experience review can't be aimed at a space booking — and every refusal leaves no review behind |
| `payment-dispute-resolution-flow.mjs` | CR-650 / CR-679 — what happens when the dispute CLOSES: won → the held refund is closed WITHOUT paying (the 2026-09-01 rule, see the file header) and the dispute stops blocking the host's payout; lost → the held request settles as `settled_by_chargeback` and the payout stays blocked. **Gated + currently expected-red on the three payout cases** — see "The gated flow" below |
| `devices-flow.mjs` | the push-token registry on a throwaway account — register, read back with the token intact, update in place (no duplicate row, token preserved), unregister, idempotent repeat unregister |

### The gated flow: dispute resolution (`payment-dispute-resolution-flow.mjs`)

One flow needs two capabilities the rest of the suite deliberately does not have,
so its cases **skip** (`⏭`, via `lib/skip.mjs`) instead of failing when they are
absent — a skip means *missing capability*, never *the product misbehaved*:

| Capability | Why | Without it |
|---|---|---|
| `STRIPE_SECRET_KEY` in `tests/.env` | closing a test-mode dispute won/lost means submitting evidence, which is a secret-key call — everything else here uses the publishable key like the mobile SDK | the whole flow skips |
| gcloud ADC for staging + `firebase-admin` in the sibling `test-data` repo | `payouts` and `refund_requests` are not exposed by the app gateway at all, so those two ACs can only be read from Firestore (`lib/firestore.mjs`, read-only except one guarded date fast-forward) | the whole flow skips |

```bash
CLOUDSDK_CONFIG=$HOME/.gcloud/corneroom gcloud secrets versions access latest \
  --secret=STRIPE_SECRET_KEY --project=corneroom-82fbb   # -> tests/.env, gitignored
```

The key **must** be `sk_test_…` — `lib/stripe-dispute.mjs` refuses anything else
before sending a byte, and also refuses to run if `GW_URL` looks like production.

It is slow (four real Stripe-sandbox bookings, a Firestore fast-forward and a
real Cloud Scheduler sweep run) and it leaves two COMPLETED bookings behind on
purpose, so treat it as a run-on-demand flow rather than part of the 6-hourly
cadence. Its header explains every one of those choices, including why a payout
assertion cannot currently prove the full release: **no seeded bot host on
staging has a `payout_method`** (checked 2026-09-15 — only three users have one,
all real accounts), and this suite may only book bot hosts.

Three of its cases are **expected red** today against real payout/dispute bugs;
the failure messages carry the observed state. Do not loosen them.

Write flows register throwaway `qa+<digits>@bot.com` accounts, and user-service
rate-limits its auth group (register/confirm/login/refresh/password reset) to
**10 requests per minute per IP**. Each `registerFreshUser` costs two of them,
so `lib/booking-flow.mjs` backs off 30s and retries on a 429 rather than
failing the run — keep new flows frugal with fresh identities anyway.

**Never book a listing hosted by a real account.** Every booking, payment and
cancellation notifies the host for real (messaging-service reacts to
`booking-events`) — the owner was getting push notifications on his phone every
six hours because the old fixture picker took the first `$5` instant-book
listing, which belonged to a genuine signed-in host. Use
`lib/booking-flow.mjs`'s `pickListing` / `pickListings` / `pickFreeListing`:
they build a pool of **bot-hosted USD** listings and pick at random from it.
Note that `host.is_bot` is only present on `GET /listings/{id}`, never on the
`GET /listings` feed, so the pool is built with one detail fetch per candidate
(cached per process). Don't reintroduce a raw feed pick, and don't hardcode
host ids — staging gets reseeded.

**Every booking a write flow creates must be torn down before the file ends**
(`teardownBooking` handles any state). The suite runs every 6 hours against a
handful of shared staging listings; uncancelled bookings accumulate until date
collisions make `POST /bookings/initiate` start 400ing. This has already caused
real scheduled-CI flakiness.

A `services/*.mjs.disabled` file is a finished flow that is deliberately NOT
discovered by `run.mjs` because it is blocked on a **product** bug, not on the
test. Its header must document exactly what, with the staging evidence, and how
to re-enable it (rename back to `.mjs` — nothing else). Today that is:

- `conversation-access-status.mjs.disabled` — chat-service refuses a
  non-participant with **500**, not the documented 403/404, on every
  conversation/message path except the attachment one (which maps the same
  error values correctly). A missing conversation additionally echoes the raw
  Firestore document path. Access control itself is correct and
  `conversation-flow.mjs` asserts that, live; only the status codes are wrong.
(`payment-dispute-flow.mjs.disabled` and `verification-history-read.mjs.disabled`
used to be listed here. The dispute write race was fixed; and verification-service
`a329289` made `document_type` optional on the status response, so a user with a
selfie verification can read their own history again. Both are enabled.)

### Still descoped, with the reason

- **"earnings go UP after a completed stay."** The credit lands at
  auto-completion, after check-out, and every fixture is booked ~300-600 days
  out (`futureDates()` — near dates collide across the 6-hourly runs). Only the
  negative is provable, and `booking-host-flow.mjs` proves it for a real host.
- **A host owning BOTH an instant-book and a request-to-book listing.** Staging
  has none: the 16 bot-hosted USD listings belong to 16 distinct New York seed
  hosts, one each. The cross-host authorization case uses a *second* bot host's
  listing instead. Nothing was toggled in Firestore to work around this.
- **Luggage check-in / release.** Host-only, now unblocked by the host
  credential, but a separate contract (`luggage_contract.md`) with its own
  guest-confirm handshake.
- **A listing being paused, going unbookable, and coming back on resume.** A
  host may not touch the `active` toggle until moderation approves the listing
  (`CanListingBeActivated`, listing-service `internal/service/listing.go:667`;
  refused 409), and approval is a dashboard action, not an app-gateway one.
  `listing-management-flow.mjs` covers the gate itself and proves a *pending*
  listing is neither discoverable nor bookable. Pausing the shared host fixture
  to fake it would break every other flow's fixture.
- **A review on a genuinely completed stay.** review-service gates on the
  check-in DATE, not booking status (`validate_check_in_date`,
  review-service `app/utils/data_helpers.py:128`), and every fixture must be
  booked hundreds of days out. `PATCH /bookings/{id}/complete` does not move
  `check_in`, so it does not help. `review-flow.mjs`'s header has the full
  derivation; it covers the refusals instead.
- **Chat comments, `/community/stories/my`, `/community/reels/my`.** Routed and
  reachable, but they answer **501 "not implemented"** — generated router stubs.
  Covering them would only pin a stub in place.
- **`POST /guides` / `POST /guides/apply`.** There is no gateway call that
  deletes a guide profile, and `apply` has no body validation, so one call
  permanently adds the caller to the public guide directory. `guides-read.mjs`
  is read-only on purpose — its header explains, including the row that had to
  be cleaned out of staging Firestore after an exploratory call.

### Measured endpoint coverage

`gateway/app-swagger.yaml` is 247 distinct (method, path) operations. The suite
hit 75 of them before this batch and **128** after — the jump is conversations
0→11, messages 0→4, community 2→17, reviews 2→8, guides 0→5, listings 7→11,
documents 1→4, reports 0→1, users 14→18. The remaining gaps are mostly
account-management (`/users/me/email|phone|notifications|avatar`, the OTP and
phone login paths), bookings' slot endpoints, hangouts and travel plans, the
`/*/heartbeat` pings (deliberately uncovered — infra probes, not contracts) and
`/ws`, `/health`, `/webhooks`.

## Roadmap
- **Phase 1 (here):** read-only smoke of key endpoints + auth/security guards.
- **Phase 2:** drive cases from `gateway/app-swagger.yaml` to cover every path
  automatically + validate responses against the schema.
- **Phase 3:** write-path flows with setup/teardown.
