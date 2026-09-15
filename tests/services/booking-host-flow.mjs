// booking-service × payment-service × user-service — the HOST side of a
// request-to-book stay: who may decide it, what ACCEPT does to the money, and
// what DECLINE does to the money.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// services/booking-lifecycle-flow.mjs pins the half of the request-to-book
// state machine a guest can reach on their own: the card is authorized and
// never captured while the request waits, and the guest cannot approve their
// own booking. Its header records why the other half was descoped — there was
// no host identity. `tests/.env`'s account hosts nothing (`has_listing:false`),
// and both transitions require `booking.Host.ID == userID` (booking-service
// internal/service/booking.go:1060 for accept, :930 for reject).
//
// That gap is now closed by a SECOND credential: TEST_HOST_EMAIL /
// TEST_HOST_PASSWORD (lib/auth.mjs `loginHost()`), pointed at a seeded bot host
// from the New York city seed. It has to be a BOT host for exactly the reason
// the fixture pool is bot-only (see lib/booking-flow.mjs): this flow books,
// accepts, declines and cancels for real, and a genuine host is pushed a
// notification for every one of those.
//
// Nothing here is hardcoded to that host. The flow reads its own id from
// `GET /users/me` and asks lib/booking-flow.mjs for the bot-pool listing that
// host owns, so a staging reseed is survivable.
//
// ── WHAT ACCEPT AND DECLINE ACTUALLY DO TO THE MONEY ───────────────────────
//
// ACCEPT (booking.go:1044 AcceptBooking)
//   status Pending -> Accepted, then publishes `booking_accepted` AND
//   `awaiting_payment`. Only `awaiting_payment` captures — payment-service
//   deliberately acks `booking_accepted` without touching the intent
//   (payment-service internal/service/payment.go:210-221; capturing on both
//   raced for the same PaymentIntent in prod on 2026-08-24). The capture's
//   `payment_succeeded` then moves the booking Accepted -> Confirmed
//   (booking.go:211 `canConfirmOnPaymentSuccess`).
//   So accept is the moment the guest's card is really charged, and this file
//   proves it from three independent reads: our booking, Stripe's own intent,
//   and the guest's ledger.
//
// DECLINE (booking.go:914 RejectBooking)
//   status Pending -> Rejected, publishes `booking_rejected`; payment-service
//   CANCELS the intent (payment.go:1749-1796), releasing the authorization.
//   Stripe's `payment_intent.canceled` webhook then settles the ledger row to
//   `cancelled` (payment.go:4541). Nothing is ever captured, so there is
//   nothing to refund — and a refund row appearing here would mean money moved
//   through a stay no host agreed to.
//
// EARNINGS ARE NOT CREDITED AT ACCEPT. `earnings.spaces` is written only by
// `creditHostSpaceEarnings` at COMPLETION (booking-service
// internal/service/booking_completion.go:295, :349, :358) — "matching payout
// timing so cancelled/refunded bookings are never counted". This file holds a
// real host identity, so it asserts that directly on the host's own
// `GET /users/me/stats`: the ledger must not move on accept, and must not move
// on the cancellation that follows. services/payouts-flow.mjs could only
// assert the guest-side negative of this; see its descope 2.
//
// ── WHAT IS STILL NOT COVERED, AND WHY ─────────────────────────────────────
//
// 1. "earnings go UP after a completed stay" — still not drivable. The credit
//    happens at auto-completion, after check-out, and every fixture here is
//    booked ~300-600 days out by `futureDates()` (it has to be: the suite runs
//    every 6 hours against a handful of shared listings and near dates collide).
//    Only the NEGATIVE — not credited before completion — is provable, and is.
//
// 2. A host who owns BOTH an instant-book and a request-to-book listing.
//    Staging has none: all 16 bot-hosted USD listings belong to 16 distinct
//    New York seed hosts, one each. The cross-host authorization case below
//    therefore uses a SECOND bot host's listing rather than a second listing of
//    our own. Nothing was toggled to work around this — flipping a listing's
//    `instant_book` in Firestore would be editing fixture data to suit a test.
//
// 3. Luggage check-in / release. Host-only, and now unblocked by this
//    credential, but a different contract (luggage_contract.md) with its own
//    guest-confirm handshake. Out of scope here rather than half-asserted;
//    booking-lifecycle-flow.mjs's header still records the descope.
//
// ── LEAK DISCIPLINE (see rewards-referral-flow.mjs's header) ───────────────
// Three bookings on bot-hosted fixtures: one accepted-then-cancelled, one
// declined, one throwaway DRAFT that is never paid (the cross-host case — the
// authorization check runs BEFORE the status check, booking.go:1060 vs :1065,
// so proving it costs no money at all). Every id is recorded the instant it
// exists, before anything that can throw, and the trailing cleanup tears down
// whatever state the flow reached and VERIFIES each one ended terminal.
// NOTE `rejected` is terminal and NOT cancellable (booking.go:758
// `isCancellableStatus`), so lib/booking-flow.mjs's `teardownBooking` — which
// cancels anything that isn't already `cancelled` — would throw on the declined
// booking. This file uses its own teardown that treats `rejected` as done.
// Residue: two throwaway qa+<digits>@bot.com guests and the settled Stripe
// sandbox objects, same as every other money flow here.
import {
  registerFreshUser,
  pickListingHostedBy,
  pickListingNotHostedBy,
  futureDates,
  initiateBooking,
  calcPricing,
  createPaymentIntent,
  getStripeIntent,
  payWithTestCard,
  finalizeBooking,
  getBooking,
  cancelBooking,
  deleteDraftBooking,
} from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { config } from '../lib/env.mjs';
import { loginHost, authHeaders } from '../lib/auth.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = { created: [] };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Records a booking id + the identity that can tear it down, the instant it
// exists. Called before payment, before finalize, before anything throwable.
function track(bookingId, tokens) {
  if (bookingId && !ctx.created.some((b) => b.id === bookingId)) ctx.created.push({ id: bookingId, tokens });
}

async function gw(tokens, path, { method = 'GET', body } = {}) {
  const headers = { ...authHeaders(tokens, 'full') };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${config.gwUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, data: json?.data, text };
}

// The two host-only transitions. Bodies are what the spec REQUIRES — accept
// needs `message`, reject needs `message` AND `reason` from a fixed enum
// (booking-service docs/api.yaml /bookings/{id}/accept, /reject) — because the
// controller 400s on a body it cannot decode before the service ever runs
// (internal/rest/controller.go:622, :653), and a 400 would look like a refusal.
const hostAccept = (tokens, id) => gw(tokens, `/bookings/${id}/accept`, { method: 'PATCH', body: { message: 'gateway test: accepted' } });
const hostReject = (tokens, id) =>
  gw(tokens, `/bookings/${id}/reject`, { method: 'PATCH', body: { reason: 'Other', message: 'gateway test: declined' } });

// A refusal must be a real one. `>= 400` alone would also be satisfied by a 404
// from an UNROUTED endpoint, which would quietly turn these into tests of
// nothing the day the gateway drops the route — so 404/405 is called out
// separately as "not routed", not "refused". Deliberately not pinning the exact
// status: booking-service surfaces these service-layer errors as 500
// (controller.go:630, :674) and that may later be tightened to a 403.
function assertRefused(what, r, mustMention) {
  assert(
    ![404, 405].includes(r.status),
    `PATCH /bookings/{id}/${what} is not routed on the app gateway (${r.status}) — this case can no longer prove ` +
      'anything; re-run `make gateway ENV=staging`'
  );
  assert(r.status >= 400, `${what} should have been refused — got ${r.status}: ${r.text.slice(0, 200)}`);
  if (mustMention) {
    assert(
      r.text.toLowerCase().includes(mustMention),
      `${what} was refused, but for the wrong reason: the response must mention "${mustMention}" or this case ` +
        `proves nothing about WHY. Got: ${r.text.slice(0, 300)}`
    );
  }
}

// `stats.earnings` is `omitempty` all the way down (user-service
// internal/data/user.go:403, :408-420), so a host credited nothing has no
// `earnings` key at all. Comparing a fingerprint rather than asserting zero
// means this stays honest even if the seeded host is credited by some unrelated
// future run: the claim is "THIS booking moved it", not "it is empty".
async function hostEarningsFingerprint() {
  const { status, data, text } = await gw(ctx.host.tokens, '/users/me/stats');
  assert(status === 200, `GET /users/me/stats (host) expected 200, got ${status}: ${text.slice(0, 200)}`);
  return JSON.stringify(data?.earnings ?? null);
}

// Proof the host's stats document is genuinely live before a negative is read
// from it — otherwise "earnings did not move" would also pass on a document
// nothing ever reaches. RejectBooking publishes `booking.rejected.by.host`
// targeting the HOST over the SAME `user_stats_update` topic and the same
// user-service writer an earnings credit would take (booking.go:940-952).
const hostRejectedCount = (stats) => stats?.bookings?.as_host?.rejected ?? 0;

// Pays for a request-to-book stay end to end, WITHOUT bookAndConfirm(): that
// helper polls for status=confirmed, and a request-to-book stay must NOT reach
// confirmed until the host accepts. Returns { bookingId, total, intent }.
async function requestToBook(guest, listing) {
  const dates = futureDates();
  const draft = await initiateBooking(guest.tokens, listing.id, dates);
  track(draft.id, guest.tokens);
  const pricing = await calcPricing(guest.tokens, listing.price);
  const intent = await createPaymentIntent(guest.tokens, {
    bookingId: draft.id,
    guestId: guest.id,
    hostId: listing.host.id,
    listingId: listing.id,
    amount: pricing.total,
    currency: listing.currency,
  });
  await payWithTestCard(intent);
  await finalizeBooking(guest.tokens, draft.id, { dates, paymentReference: intent.id, amount: pricing.total });

  const booking = await getBooking(guest.tokens, draft.id);
  assert(
    booking.status === 'pending',
    `a request-to-book stay must wait for the host at 'pending' — got '${booking.status}' (booking.go:2559/:2646)`
  );
  const stripeIntent = await getStripeIntent(intent);
  assert(
    stripeIntent.status === 'requires_capture',
    `the card must be an uncaptured authorization while the request is pending — Stripe says '${stripeIntent.status}'`
  );
  const charge = await poll(
    async () => {
      const rows = await getBookingTransactions(guest.tokens, draft.id);
      return { done: rows.some((t) => t.type === 'booking'), value: rows.find((t) => t.type === 'booking') };
    },
    { timeoutMs: 90000, intervalMs: 5000, desc: 'the authorized hold to reach the guest ledger' }
  );
  assert(charge.status === 'pending', `the hold must show as 'pending' in the guest's history — got '${charge.status}'`);

  return { bookingId: draft.id, total: pricing.total, intent };
}

// How long to wait before concluding a cancellation produced NO refund — same
// calibration as booking-lifecycle-flow.mjs's NO_REFUND_GRACE_MS, and only
// reached if this host's fixture happens to carry the `no_refund` policy.
const NO_REFUND_GRACE_MS = 60000;

// What the listing's own policy says a guest cancellation ~a year out is worth
// (payment-service internal/service/cancellation_policy.go:41 — every tier is
// in its ">= 24h" branch at these dates). Derived from the fixture rather than
// assumed, so this flow stays correct whichever bot host TEST_HOST_EMAIL names.
function expectedRefundFraction(policy) {
  switch (policy) {
    case 'full_refund_24h':
      return 1;
    case 'fifty_percent_24h':
      return 0.5;
    case 'no_refund':
      return 0;
    default:
      throw new Error(`unknown cancellation_policy '${policy}' on the host fixture — teach this flow what it refunds`);
  }
}

export default {
  name: 'booking-service × payment-service × user-service (a HOST accepts and declines a request-to-book stay)',
  cases: [
    {
      name: 'setup: log in as the seeded bot HOST and find the request-to-book listing it owns',
      run: async () => {
        ctx.host = { tokens: await loginHost() };
        const { status, data, text } = await gw(ctx.host.tokens, '/users/me');
        assert(status === 200, `GET /users/me (host) expected 200, got ${status}: ${text.slice(0, 200)}`);
        ctx.host.id = data?.id;
        assert(ctx.host.id, `could not resolve the host's own user id from GET /users/me: ${text.slice(0, 200)}`);
        assert(
          data?.has_listing === true,
          `TEST_HOST_EMAIL must name an account that actually HOSTS — GET /users/me reports has_listing=` +
            `${JSON.stringify(data?.has_listing)}. Nothing in this flow is drivable without a listing to receive requests on`
        );

        ctx.listing = await pickListingHostedBy(ctx.host.tokens, ctx.host.id, { instantBook: false });
        assert(
          ctx.listing.instant_book === false,
          `this flow needs a REQUEST-to-book listing (an instant-book one is accepted at finalize and never reaches ` +
            `the host) — got instant_book=${JSON.stringify(ctx.listing.instant_book)} for ${ctx.listing.id}`
        );
        // Belt and braces on the "never book a real host" rule: the pool is
        // already bot-only, and this is the listing we are about to drive
        // bookings, captures and refunds through.
        assert(ctx.listing.host?.is_bot === true, `fixture ${ctx.listing.id} is not bot-hosted — refusing to drive it`);

        ctx.earningsBefore = await hostEarningsFingerprint();
      },
    },
    {
      name: 'a fresh guest REQUESTS the host listing and pays — authorized, pending, nothing captured',
      run: async () => {
        ctx.guest = await registerFreshUser('HostFlowGuest');
        const booked = await requestToBook(ctx.guest, ctx.listing);
        ctx.bookingId = booked.bookingId;
        ctx.total = booked.total;
        ctx.intent = booked.intent;
      },
    },
    {
      // The host's inbox. Without this, "the host accepted it" would be true of
      // an id the host could never have found in the first place.
      name: "GET /bookings/host shows the pending request in the HOST's own list",
      run: async () => {
        const { status, data, text } = await gw(ctx.host.tokens, '/bookings/host?limit=100');
        assert(status === 200, `GET /bookings/host expected 200, got ${status}: ${text.slice(0, 200)}`);
        const all = [...(data?.current ?? []), ...(data?.upcoming ?? []), ...(data?.past ?? [])];
        const mine = all.find((b) => b.id === ctx.bookingId);
        assert(
          mine,
          `the pending request ${ctx.bookingId} is not in the host's list — the host has no way to act on it. ` +
            `Buckets held ${data?.current?.length ?? 0}/${data?.upcoming?.length ?? 0}/${data?.past?.length ?? 0} ` +
            `(current/upcoming/past)`
        );
        assert(mine.status === 'pending', `the host must see it as 'pending' — got '${mine.status}'`);
      },
    },
    {
      // NEW here, and only reachable with a real host identity: owning a
      // listing is not a licence over OTHER hosts' bookings. Deliberately run
      // against an unpaid DRAFT — AcceptBooking checks ownership (booking.go:1060)
      // BEFORE it checks status (:1065), so this costs nothing and still proves
      // the ownership gate rather than the state machine. The message assertion
      // is what keeps those two apart.
      //
      // The guest-side twin ("a guest cannot accept their own booking") is
      // already asserted in services/booking-lifecycle-flow.mjs — not duplicated.
      name: "THE GUARD: a host cannot accept or decline a booking on ANOTHER host's listing",
      run: async () => {
        const other = await pickListingNotHostedBy(ctx.host.tokens, ctx.host.id, { instantBook: false });
        const dates = futureDates();
        const draft = await initiateBooking(ctx.guest.tokens, other.id, dates);
        track(draft.id, ctx.guest.tokens);

        assertRefused('accept', await hostAccept(ctx.host.tokens, draft.id), 'only host');
        assertRefused('reject', await hostReject(ctx.host.tokens, draft.id), 'only host');

        const after = await getBooking(ctx.guest.tokens, draft.id);
        assert(after.status === 'draft', `a refused host action must leave the booking alone — status is now '${after.status}'`);
      },
    },
    {
      // THE money guard for accept. Capture is the point of no return for the
      // guest's card, and it must happen exactly once, only on the host's word.
      name: 'THE HOST ACCEPTS: the booking confirms, the hold is CAPTURED, and the ledger settles to completed',
      run: async () => {
        const res = await hostAccept(ctx.host.tokens, ctx.bookingId);
        assert(
          [200, 202].includes(res.status),
          `the host accepting their own pending request must succeed — got ${res.status}: ${res.text.slice(0, 300)}`
        );

        // Accepted -> Confirmed is driven by the capture's payment_succeeded
        // (booking.go:211), so reaching 'confirmed' IS the proof the capture
        // came back, not just that the status was flipped locally.
        const finalStatus = await poll(
          async () => {
            const b = await getBooking(ctx.guest.tokens, ctx.bookingId);
            return { done: b.status === 'confirmed', value: b.status };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: `booking ${ctx.bookingId} to reach 'confirmed' after host accept` }
        );
        assert(finalStatus === 'confirmed', `expected 'confirmed', got '${finalStatus}'`);

        const stripeIntent = await getStripeIntent(ctx.intent);
        assert(
          stripeIntent.status === 'succeeded',
          `the authorization must be CAPTURED on Stripe once the host accepts — got '${stripeIntent.status}'`
        );

        const rows = await poll(
          async () => {
            const r = await getBookingTransactions(ctx.guest.tokens, ctx.bookingId);
            const charge = r.find((t) => t.type === 'booking');
            return { done: charge?.status === 'completed', value: r };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: "the guest's hold row to settle to 'completed'" }
        );
        assert(
          rows.filter((t) => t.type === 'booking').length === 1,
          `exactly one charge row must exist for an accepted booking — got ${JSON.stringify(rows.filter((t) => t.type === 'booking'))}`
        );
        assert(
          rows.filter((t) => t.type === 'refund').length === 0,
          `an accepted booking must not have produced a refund — got ${JSON.stringify(rows.filter((t) => t.type === 'refund'))}`
        );
      },
    },
    {
      // Accept is not idempotent-by-retry, it is REFUSED on replay
      // (booking.go:1065: only Pending can be accepted). Either shape is
      // acceptable for the app; what is NOT acceptable is a second capture.
      name: 'THE GUARD: accepting AGAIN does not capture a second time',
      run: async () => {
        const res = await hostAccept(ctx.host.tokens, ctx.bookingId);
        assert(
          ![404, 405].includes(res.status),
          `PATCH /bookings/{id}/accept is not routed (${res.status}) — re-run \`make gateway ENV=staging\``
        );

        const stripeIntent = await getStripeIntent(ctx.intent);
        assert(
          stripeIntent.status === 'succeeded',
          `a replayed accept must leave the captured intent alone — Stripe now says '${stripeIntent.status}'`
        );
        const rows = await getBookingTransactions(ctx.guest.tokens, ctx.bookingId);
        assert(
          rows.filter((t) => t.type === 'booking').length === 1,
          `a replayed accept must not add a second charge row — got ${JSON.stringify(rows.filter((t) => t.type === 'booking'))}`
        );
        const booking = await getBooking(ctx.guest.tokens, ctx.bookingId);
        assert(booking.status === 'confirmed', `a replayed accept must leave the booking confirmed — got '${booking.status}'`);
      },
    },
    {
      // The host-side negative that only a host identity can make: accepting a
      // stay is not being paid for it. `creditHostSpaceEarnings` runs at
      // completion (booking_completion.go:295/:349), and this booking's
      // check-out is ~a year away.
      name: "THE GUARD: the HOST's earnings ledger is NOT credited at accept — only at completion",
      run: async () => {
        const after = await hostEarningsFingerprint();
        assert(
          after === ctx.earningsBefore,
          `stats.earnings moved when the host merely ACCEPTED a stay that has not happened yet. ` +
            `Before: ${ctx.earningsBefore} · after: ${after}. Earnings are credited at completion so cancelled and ` +
            `refunded bookings are never counted (booking_completion.go:293-295) — crediting at accept would pay a ` +
            `host for a stay the guest can still cancel`
        );
      },
    },
    {
      // PATCH /bookings/{id}/complete is the guest's own "I've checked out",
      // and it is the ONLY way a completion can happen early — the cron that
      // otherwise completes bookings only ever looks at stays whose check-out
      // has passed. Completing this stay would open its review window, credit
      // the host's earnings and hand payment-service a payout for a stay that
      // hasn't happened, so both refusals below are money guards, not
      // ergonomics.
      //
      // The POSITIVE (a guest completing AFTER check-out) is not drivable here
      // and deliberately isn't faked: every fixture is booked 300+ days out by
      // futureDates(), for the reason its own header gives — the suite runs
      // every 6 hours against a handful of shared listings and near dates
      // collide. Backdating check_out in Firestore would be editing fixture
      // data to suit a test. That path is covered by booking-service's
      // internal/service/booking_complete_manual_test.go, which also pins that
      // it writes exactly what the cron writes.
      name: 'THE GUARD: the guest cannot complete a stay that has not ended yet',
      run: async () => {
        const res = await gw(ctx.guest.tokens, `/bookings/${ctx.bookingId}/complete`, { method: 'PATCH' });
        assertRefused('complete', res, "hasn't ended");
        assert(
          res.status === 400,
          `a stay that hasn't ended is a 400, not ${res.status} — a 403 would say the guest isn't allowed at all, ` +
            `and a 500 would hide it: ${res.text.slice(0, 200)}`
        );

        const after = await getBooking(ctx.guest.tokens, ctx.bookingId);
        assert(after.status === 'confirmed', `a refused completion must leave the booking alone — status is now '${after.status}'`);
      },
    },
    {
      // The host has no manual completion at all: theirs is the auto-complete
      // cron. A host completing on the guest's behalf would credit their OWN
      // earnings and open the guest's review window early, which is why this
      // is checked before anything about dates — hence 403 here on the very
      // same booking the guest was told was too early.
      name: 'THE GUARD: the HOST cannot complete the guest\'s stay',
      run: async () => {
        const res = await gw(ctx.host.tokens, `/bookings/${ctx.bookingId}/complete`, { method: 'PATCH' });
        assertRefused('complete', res, 'only the guest');
        assert(
          res.status === 403,
          `the host is not merely early, they are not permitted — expected 403, got ${res.status}: ${res.text.slice(0, 200)}`
        );

        const after = await getBooking(ctx.guest.tokens, ctx.bookingId);
        assert(after.status === 'confirmed', `a refused completion must leave the booking alone — status is now '${after.status}'`);
      },
    },
    {
      name: "the guest cancels the ACCEPTED stay: refunded exactly the listing's policy tier, and the host is still credited nothing",
      run: async () => {
        const fraction = expectedRefundFraction(ctx.listing.cancellation_policy);
        await cancelBooking(ctx.guest.tokens, ctx.bookingId);

        let refunds;
        if (fraction > 0) {
          const rows = await poll(
            async () => {
              const r = await getBookingTransactions(ctx.guest.tokens, ctx.bookingId);
              return { done: r.some((t) => t.type === 'refund'), value: r };
            },
            { timeoutMs: 120000, intervalMs: 5000, desc: `a refund row for the ${ctx.listing.cancellation_policy} cancellation` }
          );
          refunds = rows.filter((t) => t.type === 'refund');
          assert(refunds.length === 1, `expected exactly one refund row, got ${JSON.stringify(refunds)}`);
          const expected = ctx.total * fraction;
          // 1c of slack: refunds are issued in minor units, so an odd total
          // rounds (payment-service currency.ToStripeAmount).
          assert(
            Math.abs(refunds[0].amount - expected) <= 0.01,
            `${ctx.listing.cancellation_policy} cancelled ~a year out must return ${expected} of ${ctx.total} — got ${refunds[0].amount}`
          );
        } else {
          await new Promise((r) => setTimeout(r, NO_REFUND_GRACE_MS));
          refunds = (await getBookingTransactions(ctx.guest.tokens, ctx.bookingId)).filter((t) => t.type === 'refund');
          assert(refunds.length === 0, `a no_refund listing must refund nothing — got ${JSON.stringify(refunds)}`);
        }

        const after = await hostEarningsFingerprint();
        assert(
          after === ctx.earningsBefore,
          `stats.earnings moved across an accept-then-cancel cycle. Before: ${ctx.earningsBefore} · after: ${after}. ` +
            `A cancelled stay must never reach the host's earnings ledger`
        );
      },
    },
    {
      // THE money guard for decline: the mirror image of accept. Nothing is
      // captured, so nothing is refunded — and "no refund row" here is a
      // stronger statement than it looks, because a refund row would mean the
      // guest's card had been charged for a stay the host turned down.
      name: 'THE HOST DECLINES a second request: the hold is VOIDED on Stripe — no capture, no refund',
      run: async () => {
        ctx.guest2 = await registerFreshUser('HostFlowGuest2');
        const booked = await requestToBook(ctx.guest2, ctx.listing);
        ctx.declinedId = booked.bookingId;
        ctx.declinedIntent = booked.intent;

        const statsBefore = (await gw(ctx.host.tokens, '/users/me/stats')).data;

        const res = await hostReject(ctx.host.tokens, ctx.declinedId);
        assert(
          [200, 202].includes(res.status),
          `the host declining their own pending request must succeed — got ${res.status}: ${res.text.slice(0, 300)}`
        );

        const booking = await getBooking(ctx.guest2.tokens, ctx.declinedId);
        assert(booking.status === 'rejected', `a declined request must land at 'rejected' — got '${booking.status}'`);

        const stripeIntent = await poll(
          async () => {
            const i = await getStripeIntent(ctx.declinedIntent);
            return { done: i.status === 'canceled', value: i };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: `Stripe intent ${ctx.declinedIntent.id} to be voided after the decline` }
        );
        // `canceled` IS the "nothing was captured" proof: a captured intent
        // would be `succeeded` and could never reach `canceled`.
        assert(stripeIntent.status === 'canceled', `the authorization must be voided, not captured — got '${stripeIntent.status}'`);

        const rows = await poll(
          async () => {
            const r = await getBookingTransactions(ctx.guest2.tokens, ctx.declinedId);
            const charge = r.find((t) => t.type === 'booking');
            return { done: charge?.status === 'cancelled', value: r };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: "the declined guest's hold row to settle to 'cancelled'" }
        );
        assert(
          rows.filter((t) => t.type === 'refund').length === 0,
          `a declined request must not produce a refund row — there was never a charge to refund. ` +
            `Got ${JSON.stringify(rows.filter((t) => t.type === 'refund'))}`
        );

        // The host's stats document is demonstrably live (see hostRejectedCount)
        // — which is what licenses the "earnings did not move" negatives above.
        const rejected = await poll(
          async () => {
            const s = (await gw(ctx.host.tokens, '/users/me/stats')).data;
            const n = hostRejectedCount(s);
            return { done: n > hostRejectedCount(statsBefore), value: n };
          },
          { timeoutMs: 90000, intervalMs: 5000, desc: "the host's booking.rejected.by.host stat to increment" }
        );
        assert(
          rejected > hostRejectedCount(statsBefore),
          `stats.bookings.as_host.rejected did not move (${hostRejectedCount(statsBefore)} -> ${rejected})`
        );

        const afterEarnings = await hostEarningsFingerprint();
        assert(
          afterEarnings === ctx.earningsBefore,
          `stats.earnings moved on a DECLINED request. Before: ${ctx.earningsBefore} · after: ${afterEarnings}`
        );
      },
    },
    {
      name: 'THE GUARD: a declined request cannot be declined again, and cannot be accepted afterwards',
      run: async () => {
        assertRefused('reject', await hostReject(ctx.host.tokens, ctx.declinedId), 'rejected');
        assertRefused('accept', await hostAccept(ctx.host.tokens, ctx.declinedId), 'rejected');

        const booking = await getBooking(ctx.guest2.tokens, ctx.declinedId);
        assert(booking.status === 'rejected', `the booking must stay 'rejected' — got '${booking.status}'`);
        const stripeIntent = await getStripeIntent(ctx.declinedIntent);
        assert(
          stripeIntent.status === 'canceled',
          `a replayed decision on a declined booking must not touch the voided intent — Stripe says '${stripeIntent.status}'`
        );
      },
    },
    {
      // Cleanup, tolerant of whatever state the flow reached (including a
      // mid-flow throw) but NOT of what it leaves: an un-terminated booking
      // squats on this bot host's only request-to-book listing and eventually
      // makes POST /bookings/initiate 400 for every later run.
      //
      // Deliberately NOT lib/booking-flow.mjs's teardownBooking: that cancels
      // anything that is not already `cancelled`, and `rejected` is terminal
      // but not cancellable (booking.go:758), so it would throw here.
      name: 'cleanup: tear down every booking this flow created, and prove each ended terminal',
      run: async () => {
        const TERMINAL = ['cancelled', 'rejected', 'completed'];
        const leaked = [];
        for (const { id, tokens } of ctx.created) {
          const before = await getBooking(tokens, id).catch(() => null);
          if (!before) continue; // already gone
          if (before.status === 'draft') await deleteDraftBooking(tokens, id);
          else if (!TERMINAL.includes(before.status)) await cancelBooking(tokens, id);

          const after = await getBooking(tokens, id).catch(() => null);
          // A deleted draft reads back as missing, which is a clean outcome.
          if (after && !TERMINAL.includes(after.status)) leaked.push(`${id}=${after.status}`);
        }
        assert(
          leaked.length === 0,
          `LEAK: these bookings were left holding the host fixture's dates on staging: ${leaked.join(', ')}`
        );
      },
    },
  ],
};
