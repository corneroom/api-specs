// booking-service × payment-service — the two halves of a stay's lifecycle that
// decide whether money moves: WHEN a card is captured, and HOW MUCH comes back
// when the guest cancels.
//
// ── PART A: request-to-book is authorized, not charged ──────────────────────
//
// A listing is either instant-book or request-to-book, and the difference is
// entirely about capture timing:
//
//   instant_book=true   finalize sets status=Accepted and CreateBooking
//                       publishes `awaiting_payment` immediately
//                       (booking-service internal/service/booking.go:2556 and
//                       :2633) → payment-service captures the hold.
//   instant_book=false  finalize sets status=Pending and NOTHING publishes
//                       `awaiting_payment` (booking.go:2559, :2646). The only
//                       other publisher is AcceptBooking (booking.go:1119),
//                       which the HOST triggers.
//
// So while a request sits pending, the guest's card carries an authorization
// (Stripe `requires_capture`) and not a charge. If that ever regresses — if
// some path starts publishing `awaiting_payment` for a pending booking — real
// guests get charged for stays a host has not agreed to, and the money is only
// clawed back later by a refund. That is what Part A pins, from outside, with
// real Stripe sandbox objects.
//
// WHAT IS NOT COVERED, AND WHY — host accept / decline.
// `PATCH /bookings/{id}/accept` and `/reject` both require
// `booking.Host.ID == userID` (booking-service internal/service/booking.go:931
// and :1057). Every bookable fixture on staging is hosted by a seeded bot whose
// password this suite does not have and must not hardcode (tests/.env is the
// only credential, and it hosts nothing — `GET /users/me` reports
// `has_listing:false`). Standing up our own host is not a way out either: a
// listing is only bookable when BOTH `verified` and `host.facematch_verified`
// are true on the listing document (booking-service booking.go:39-47
// `listingBookableByGuest`), and both are set by moderation/KYC, not by any
// gateway call a test can make. So the accept/decline HAPPY paths are genuinely
// undrivable headless and are deliberately absent rather than faked.
// What IS drivable, and is asserted below, is the half that protects money:
//   - a pending request is authorized and never captured (the state a decline
//     would void, and the reason a decline costs the guest nothing), and
//   - the guest cannot accept or decline their own request — the authorization
//     check itself.
//
// ── PART B: guest cancellation refunds exactly the policy tier ─────────────
//
// payment-service `ApplyCancellationPolicy` (internal/service/cancellation_policy.go:41)
// decides the refund for a GUEST cancellation from the listing's policy and the
// hours until check-in. Bookings here are made ~300-600 days out
// (`futureDates()`), so every tier is in its "early" branch:
//
//   full_refund_24h    (>= 24h)  -> refund the FULL captured total
//   fifty_percent_24h  (>= 24h)  -> refund exactly HALF
//   no_refund          (always)  -> refund NOTHING, and no refund row is even
//                                   written (payment.go:1983 breaks out before
//                                   creating one)
//
// The bot-hosted USD fixture pool carries all three policies today, so each tier
// is exercised against its own real listing and its own real Stripe charge. The
// assertion is on the guest-facing ledger (`GET /payments/history`) — the only
// view the app has of what actually moved — not on our own echo of the request.
//
// ── LUGGAGE / BAG CHECK-IN: descoped, with the same evidence ───────────────
// `POST /bookings/{id}/luggage/checkin` and `/luggage/release` are HOST actions
// (403 "not the host" per the gateway spec; booking-service internal/service/
// luggage.go enforces it), and the guest-side `/luggage/confirm` requires the
// luggage sub-document to already be in `checked_in` — which only a host
// check-in can create. Same blocker as accept/decline: no host identity. It is
// omitted rather than half-asserted.
//
// ── LEAK DISCIPLINE (see rewards-referral-flow.mjs's header) ───────────────
// This file creates FOUR bookings on four distinct bot-hosted fixtures. Every
// booking id is recorded the instant it exists, before anything that can throw,
// and the trailing cleanup case tears down whatever state the flow reached and
// VERIFIES each one ended `cancelled` — lib/runner.mjs keeps running cases past
// a failure precisely so that still happens. Three of the four are already
// cancelled by their own assertions; the cleanup is what covers a mid-flow
// failure. Residue that cannot be cleaned: the throwaway qa+<digits>@bot.com
// guest, and the settled Stripe sandbox charges/refunds. Both are inherent to
// testing real money movement and match what the existing money flows leave.
//
// Fixtures are bot-hosted throughout (lib/booking-flow.mjs's pickers) — this
// file pays, cancels and refunds, and a real host would be pushed a
// notification for every one of those.
import {
  registerFreshUser,
  pickListing,
  futureDates,
  initiateBooking,
  calcPricing,
  createPaymentIntent,
  getStripeIntent,
  payWithTestCard,
  finalizeBooking,
  getBooking,
  cancelBooking,
  bookAndConfirm,
  teardownBooking,
} from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { config } from '../lib/env.mjs';
import { authHeaders } from '../lib/auth.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = { tiers: {} };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Host-only lifecycle transitions, called here by the GUEST on their own
// booking. booking-service surfaces the service-layer "unauthorized: only host
// can ..." error as a 500 (internal/rest/controller.go:630 / :674) — this
// returns the raw status so the case can assert "refused" without pinning a
// status code the controller may later tighten to a 403.
async function hostAction(tokens, bookingId, action, body) {
  const res = await fetch(`${config.gwUrl}/bookings/${bookingId}/${action}`, {
    method: 'PATCH',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// How long to wait before concluding that a cancellation produced NO refund.
//
// Proving a negative has nothing to poll for. The booking's own lifecycle
// events would be the causal signal (payment-service publishes payment_cancelled
// only AFTER the refund decision, payment.go:2183-2196) but `api.Booking` does
// not expose `events`, so it is not readable over the gateway. Instead this is
// calibrated against the two POSITIVE tiers in this same file: each logs how
// long its refund row actually took, so the log tells you whether this window
// is still comfortably clear of reality. Measured on staging 2026-09-13: both
// refund rows landed ~5.6s after the cancel, so this is a >10x margin. If a
// refund ever starts landing slower than this, the no_refund case turns into a
// false pass — raise it, don't delete it.
const NO_REFUND_GRACE_MS = 60000;

// Books a bot-hosted fixture with the given cancellation policy, cancels it,
// and returns { total, refunds, charges } read back from the guest's ledger.
async function cancelAndReadLedger(policyKey, expectRefund) {
  const listing = await pickListing(ctx.guest.tokens, { minPrice: 1, policy: policyKey });
  const booked = await bookAndConfirm(ctx.guest.tokens, listing, {
    guestId: ctx.guest.id,
    hostId: listing.host.id,
    onDraft: (id) => {
      ctx.tiers[policyKey] = id;
    },
  });
  ctx.tiers[policyKey] = booked.bookingId;

  await cancelBooking(ctx.guest.tokens, booked.bookingId);

  let rows;
  if (expectRefund) {
    const startedAt = Date.now();
    rows = await poll(
      async () => {
        const r = await getBookingTransactions(ctx.guest.tokens, booked.bookingId);
        return { done: r.some((t) => t.type === 'refund'), value: r };
      },
      { timeoutMs: 120000, intervalMs: 5000, desc: `a refund ledger row for the ${policyKey} cancellation` }
    );
    // Calibration for NO_REFUND_GRACE_MS — see its comment.
    console.log(`    · ${policyKey}: refund row landed ${Date.now() - startedAt}ms after cancel`);
  } else {
    await new Promise((r) => setTimeout(r, NO_REFUND_GRACE_MS));
    rows = await getBookingTransactions(ctx.guest.tokens, booked.bookingId);
  }
  return {
    total: booked.total,
    refunds: rows.filter((t) => t.type === 'refund'),
    charges: rows.filter((t) => t.type === 'booking'),
  };
}

export default {
  name: 'booking-service × payment-service (request-to-book holds the card; cancellation refunds the policy tier)',
  cases: [
    // ───────────────────────────────────────────────────────────────────
    // Part A — request-to-book
    // ───────────────────────────────────────────────────────────────────
    {
      name: 'setup: a fresh guest pays for a REQUEST-TO-BOOK (non-instant) stay',
      run: async () => {
        ctx.guest = await registerFreshUser('LifecycleGuest');
        const listing = await pickListing(ctx.guest.tokens, { minPrice: 1, instantBook: false });
        assert(
          listing.instant_book === false,
          `fixture picker returned an instant-book listing for the request-to-book pool: ${JSON.stringify(listing.id)}`
        );
        ctx.rtbListing = listing;

        // Spelled out rather than using bookAndConfirm(), which polls for
        // status=confirmed — a request-to-book stay must NOT reach confirmed
        // without a host, and the booking id has to be in ctx before anything
        // that can throw so cleanup can always find it.
        const dates = futureDates();
        const draft = await initiateBooking(ctx.guest.tokens, listing.id, dates);
        ctx.rtbBookingId = draft.id;
        const pricing = await calcPricing(ctx.guest.tokens, listing.price);
        ctx.rtbTotal = pricing.total;
        ctx.rtbIntent = await createPaymentIntent(ctx.guest.tokens, {
          bookingId: draft.id,
          guestId: ctx.guest.id,
          hostId: listing.host.id,
          listingId: listing.id,
          amount: pricing.total,
          currency: listing.currency,
        });
        await payWithTestCard(ctx.rtbIntent);
        await finalizeBooking(ctx.guest.tokens, draft.id, {
          dates,
          paymentReference: ctx.rtbIntent.id,
          amount: pricing.total,
        });
      },
    },
    {
      // THE money guard for Part A. Three independent reads have to agree that
      // the card was authorized and not charged: our booking, Stripe's own
      // intent, and the guest-facing ledger.
      name: "THE GUARD: the request sits at 'pending' and the card is AUTHORIZED, never captured",
      run: async () => {
        const booking = await getBooking(ctx.guest.tokens, ctx.rtbBookingId);
        assert(
          booking.status === 'pending',
          `a request-to-book stay must wait for the host at 'pending' — got '${booking.status}'. ` +
            `'confirmed'/'accepted' here means something published awaiting_payment without a host decision, ` +
            `i.e. the guest was charged for a stay nobody agreed to (booking-service booking.go:2559/:2646)`
        );

        const stripeIntent = await getStripeIntent(ctx.rtbIntent);
        assert(
          stripeIntent.status === 'requires_capture',
          `Stripe's own intent must still be an uncaptured authorization while the request is pending — got '${stripeIntent.status}'`
        );

        // payment-service writes the hold into the ledger as a PENDING row on
        // payment_intent.amount_capturable_updated (payment.go:4484-4520);
        // payment_intent.succeeded is what would flip it to completed.
        const charge = await poll(
          async () => {
            const rows = await getBookingTransactions(ctx.guest.tokens, ctx.rtbBookingId);
            return { done: rows.some((t) => t.type === 'booking'), value: rows.find((t) => t.type === 'booking') };
          },
          { timeoutMs: 90000, intervalMs: 5000, desc: 'the authorized hold to reach the guest ledger' }
        );
        assert(
          charge.status === 'pending',
          `the hold must show as 'pending' in the guest's history while the host has not accepted — got '${charge.status}'`
        );
      },
    },
    {
      // The authorization check on the host-only transitions. This is the
      // drivable half of accept/decline (see the header): the guest owns the
      // booking, but owning it must not let them approve it.
      name: 'THE GUARD: the GUEST cannot accept or decline their own request — only the host may',
      run: async () => {
        // Both halves matter. `>= 400` alone would also be satisfied by a 404
        // from an UNROUTED endpoint, which would quietly turn this into a test
        // of nothing the day the gateway drops the route — so 404/405 is called
        // out separately as "not routed", not "refused".
        const refused = (name, r) => {
          assert(
            ![404, 405].includes(r.status),
            `PATCH /bookings/{id}/${name} is not routed on the app gateway (${r.status}) — this case can no longer ` +
              `prove anything about authorization; re-run \`make gateway ENV=staging\``
          );
          assert(
            r.status >= 400,
            `a guest ${name === 'accept' ? 'accepting' : 'declining'} their own booking must be refused — ` +
              `got ${r.status}: ${r.text.slice(0, 200)}`
          );
        };
        refused('accept', await hostAction(ctx.guest.tokens, ctx.rtbBookingId, 'accept', { message: 'gateway test' }));
        refused(
          'reject',
          await hostAction(ctx.guest.tokens, ctx.rtbBookingId, 'reject', { reason: 'Other', message: 'gateway test' })
        );

        // And neither refusal may have half-applied: the booking is untouched.
        const booking = await getBooking(ctx.guest.tokens, ctx.rtbBookingId);
        assert(
          booking.status === 'pending',
          `a refused host action must leave the booking alone — status is now '${booking.status}'`
        );
      },
    },
    {
      // The counterpart of the "never captured" guard: because nothing was
      // captured, walking away costs nothing and there is nothing to refund.
      // This is also exactly the money outcome a host DECLINE produces
      // (booking_rejected reaches the same requires_capture branch in
      // payment-service payment.go:1878-1893), which is why the header treats
      // the pending-hold assertions as the drivable half of "a declined
      // request never charges".
      name: 'THE GUARD: cancelling the pending request VOIDS the hold — no capture, no refund, nothing charged',
      run: async () => {
        await cancelBooking(ctx.guest.tokens, ctx.rtbBookingId);

        const stripeIntent = await poll(
          async () => {
            const i = await getStripeIntent(ctx.rtbIntent);
            return { done: i.status === 'canceled', value: i };
          },
          { timeoutMs: 90000, intervalMs: 5000, desc: `Stripe intent ${ctx.rtbIntent.id} to be voided` }
        );
        // `canceled` IS the "nothing was captured" proof: a PaymentIntent that
        // had been captured would be `succeeded` and could never reach
        // `canceled`. (Deliberately not also asserting `amount_received === 0` —
        // the client-scoped Stripe read may omit that field, which would make
        // the assertion pass without ever checking anything.)
        assert(
          stripeIntent.status === 'canceled',
          `the authorization must be voided on Stripe, not captured — got '${stripeIntent.status}'`
        );

        const rows = await poll(
          async () => {
            const r = await getBookingTransactions(ctx.guest.tokens, ctx.rtbBookingId);
            const charge = r.find((t) => t.type === 'booking');
            return { done: charge?.status === 'cancelled', value: r };
          },
          { timeoutMs: 90000, intervalMs: 5000, desc: "the guest's hold row to settle to 'cancelled'" }
        );
        const refunds = rows.filter((t) => t.type === 'refund');
        assert(
          refunds.length === 0,
          `a voided authorization must not produce a refund row — there was never a charge to refund. Got ${JSON.stringify(refunds)}`
        );
      },
    },

    // ───────────────────────────────────────────────────────────────────
    // Part B — refund tiers on a confirmed (instant-book) stay
    // ───────────────────────────────────────────────────────────────────
    {
      name: 'tier full_refund_24h: cancelling ~a year out refunds the FULL captured total',
      run: async () => {
        const { total, refunds, charges } = await cancelAndReadLedger('full_refund_24h', true);
        assert(refunds.length === 1, `expected exactly one refund row, got ${JSON.stringify(refunds)}`);
        assert(
          Math.abs(refunds[0].amount - total) < 0.01,
          `full_refund_24h cancelled ~a year out must return the whole ${total} — got ${refunds[0].amount}`
        );
        assert(charges.length === 1, `expected exactly one charge row, got ${JSON.stringify(charges)}`);
      },
    },
    {
      name: 'tier fifty_percent_24h: cancelling ~a year out refunds exactly HALF',
      run: async () => {
        const { total, refunds } = await cancelAndReadLedger('fifty_percent_24h', true);
        assert(refunds.length === 1, `expected exactly one refund row, got ${JSON.stringify(refunds)}`);
        const expected = total * 0.5;
        // 1c of slack: the refund is issued in minor units, so an odd total
        // rounds (payment-service currency.ToStripeAmount).
        assert(
          Math.abs(refunds[0].amount - expected) <= 0.01,
          `fifty_percent_24h must return half of ${total} (= ${expected}) — got ${refunds[0].amount}. ` +
            `A full refund here means the tier was ignored and the host's forfeit was handed back`
        );
      },
    },
    {
      // The tier that is only provable by a negative, and the one where a
      // regression costs the HOST rather than the guest: payment-service breaks
      // out before creating any refund request at all when the policy decides 0
      // (payment.go:1983). Nothing arrives, so nothing can be polled for — the
      // helper waits a fixed grace period instead.
      name: 'tier no_refund: cancelling produces NO refund at all, and the charge stays completed',
      run: async () => {
        const { refunds, charges } = await cancelAndReadLedger('no_refund', false);
        assert(
          refunds.length === 0,
          `a no_refund listing must refund nothing when the guest cancels — got ${JSON.stringify(refunds)}`
        );
        assert(charges.length === 1, `expected exactly one charge row, got ${JSON.stringify(charges)}`);
        assert(
          charges[0].status === 'completed',
          `the guest's captured charge must stay 'completed' under no_refund — got '${charges[0].status}'`
        );
      },
    },

    {
      // Cleanup, tolerant of whatever state the flow reached (including a
      // mid-flow throw) but NOT tolerant of what it leaves: an uncancelled
      // booking squats on a shared staging fixture's dates and eventually makes
      // POST /bookings/initiate start 400ing for every later run.
      name: 'cleanup: tear down every booking this flow created, and prove each ended cancelled',
      run: async () => {
        const ids = [ctx.rtbBookingId, ...Object.values(ctx.tiers)].filter(Boolean);
        const leaked = [];
        for (const id of ids) {
          await teardownBooking(ctx.guest.tokens, id);
          const after = await getBooking(ctx.guest.tokens, id).catch(() => null);
          // teardownBooking DELETES a draft, so a 404/missing read is a clean
          // outcome; anything still readable must be cancelled.
          if (after && after.status !== 'cancelled') leaked.push(`${id}=${after.status}`);
        }
        assert(
          leaked.length === 0,
          `LEAK: these bookings were left holding their listings' dates on staging: ${leaked.join(', ')}`
        );
      },
    },
  ],
};
