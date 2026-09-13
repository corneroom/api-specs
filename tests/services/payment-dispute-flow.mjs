// payment-service × booking-service — CR-612: a card dispute must freeze the
// money, and must NOT disturb the booking's own lifecycle.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE WAS DISABLED 2026-09-12 AND RE-ENABLED 2026-09-13, once the write
// race it exposed was fixed. Kept as history, because it is the reason two of
// the assertions below are shaped the way they are.
//
// WHAT IT CAUGHT: a dispute raised by Stripe's test card races the
// payment-success path, and the loser's write was silently clobbered, because
// both handlers read-modify-WROTE THE WHOLE booking document:
//   - booking-service `ConfirmBooking` set Status=Confirmed, PaymentStatus=paid,
//     then `Collection("bookings").Doc(id).Set(ctx, booking)`
//   - booking-service `updateBookingStatusOnDispute` set the dispute flags on
//     ITS OWN snapshot, then Set()s the whole doc
// The two arrive as separate Pub/Sub deliveries (`payment_succeeded` and
// `payment_dispute_created`) within a second or two of each other, because
// Stripe raises the dispute as soon as the charge is captured and capture is
// what triggers the success path. Whichever landed second overwrote the other's
// fields with its stale read.
//
// Observed on staging, 2026-09-12 19:03-19:04Z, booking `tts1EgWyp4ssKROAYZDw`
// (listing maclmSLlYYdkbcY9WDsI, guest a throwaway qa+ bot): created 19:03:58,
// last updated 19:04:06 by the dispute handler, and left permanently at
// `status=Accepted, payment_status=pending, has_dispute=true`. The guest's card
// was captured and disputed, yet the booking never reached Confirmed — it would
// never auto-complete, no payout would ever be created, and the app showed an
// unpaid booking for a charge that was taken. Five other runs the same hour
// landed in the other order and were fine. A coin flip.
//
// THE FIX (booking-service, `confirmedPaymentUpdate` / `disputeCreatedUpdate`
// in internal/service/booking.go): each handler now persists ONLY the fields it
// owns, via a partial update, and appends lifecycle events with ArrayUnion
// instead of rewriting the array. The two field sets are disjoint, so they
// commute and both delivery orders converge on the same document. The setup
// case below polling for `status=confirmed` while the dispute is in flight is
// precisely the regression guard for that.
//
// Same root shape, lower stakes, in payment-service: `charge.dispute.created`
// writes the charge row's `status=disputed` (payment_dispute.go:84) while
// `payment_intent.succeeded` wrote `status=completed` whenever it wasn't
// already (payment.go:4073), with no guard either way — one run ended
// `status=completed, dispute_status=needs_response` (the "Disputed" badge lost
// from history), the next ended `status=disputed`. `completed` now yields to an
// already-`disputed` row, via the single `shouldCompleteTransaction` rule every
// success path goes through (Stripe, both PayPal paths, standalone charges), so
// the charge row's `status` is deterministic while the dispute is open and the
// case below asserts it alongside `dispute_status`. Note `recordDisputeClosed`
// legitimately moves `status` back to `completed` once the dispute RESOLVES —
// only assert `disputed` while it is still open.
//
// If this flow ever goes red on 'Accepted with payment pending' again, that is
// the race returning — do NOT loosen these assertions to tolerate it.
// ─────────────────────────────────────────────────────────────────────────────
//
// Disputes are never initiated in the app or the portal: they are chargebacks
// that arrive as Stripe webhooks (`charge.dispute.created`). Three real bugs
// have been fixed in this exact path, and each one was invisible to unit tests
// because it only shows up once a real webhook lands:
//   1. the handler keyed the payout lookup on the dispute id (dp_…) instead of
//      Dispute.payment_intent, so nothing ever matched;
//   2. a dispute raised BEFORE completion had no payout to block and was
//      dropped on the floor — it is now recorded on the transaction;
//   3. `payment_dispute_created` was never published, and booking-service's
//      handler set an undefined lowercase "disputed" STATUS on the booking —
//      which silently dropped it out of auto-complete, so no payout was ever
//      created. The booking status must stay untouched; only the dispute
//      flags change.
// PayPal parity (CUSTOMER.DISPUTE.*) followed the same shape and found two
// more money bugs. What this file guards is the Stripe half, end to end.
//
// The money rule, agreed with the owner on 2026-08-27 and unchanged since: a
// cancellation while a dispute is open must HOLD the refund, never send it —
// Stripe refuses refunds on a disputed charge, and the dispute may yet pay the
// guest, so refunding too would pay them twice. The hold surfaces to the guest
// as a ledger row `type=refund, status=on_hold`.
//
// What this flow proves against staging, with real Stripe sandbox objects:
//   1. pay with Stripe's dispute-triggering test token (tok_createDispute,
//      card 4000 0000 0000 0259 — succeeds, then Stripe disputes it as
//      fraudulent within seconds of capture)
//   2. the booking gets has_dispute and KEEPS status=confirmed  (bug 3)
//   3. the charge row carries an open dispute_status (bug 2)
//   4. cancelling during the open dispute produces a refund row `on_hold` for
//      the full policy amount, and NOTHING is actually refunded
//
// SCOPE — dispute RESOLUTION is deliberately not covered even when this file
// is enabled. Forcing a test-mode dispute to close won or lost requires
// submitting evidence (`evidence[uncategorized_text]=winning_evidence|
// losing_evidence`) or POST /v1/disputes/{id}/close, and both are SECRET-key
// calls. This suite only ever holds a publishable key (it confirms intents
// exactly like the mobile SDK does), so `charge.dispute.closed` cannot be
// driven from here without putting a Stripe secret key in CI. Resolution
// outcomes stay covered by the manual QA recipe (Stripe Dashboard test-mode
// dispute simulation; CR-679 for Stripe, CR-678 for PayPal).
//
// LEAK DISCIPLINE (see rewards-referral-flow.mjs's header): the booking id is
// captured the moment it is initiated, and the trailing cleanup case tears it
// down whatever state the flow reached — including when an earlier case threw
// (lib/runner.mjs keeps going past a failure precisely so cleanup still runs).
// Two residues are unavoidable and deliberate: the Stripe sandbox keeps one
// open disputed charge per run (it cannot be closed without a secret key), and
// staging keeps one `refund_requests` row in `held_dispute` — that row IS the
// behaviour under test. Both belong to a throwaway qa+<digits>@bot.com guest.
//
// Fixture: a bot-hosted USD listing whose cancellation policy is
// `full_refund_24h`, booked ~a year out, so the policy refund is the FULL
// total. That makes "the refund was held" a statement about real money — on a
// `no_refund` listing the held amount would be 0 and the assertion would be
// vacuous. Bot-hosted matters independently: this flow pays, disputes AND
// cancels, and a real host would be notified for each (see the fixture note in
// lib/booking-flow.mjs). Nothing here asserts an absolute amount — every
// money assertion is relative to the fixture's own `calcPricing` total — so
// the pool may hand back any qualifying price.
import {
  registerFreshUser,
  pickListing,
  futureDates,
  initiateBooking,
  calcPricing,
  createPaymentIntent,
  payWithTestCard,
  finalizeBooking,
  getBooking,
  cancelBooking,
  deleteDraftBooking,
} from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export default {
  name: 'payment-service × booking-service (CR-612 card dispute holds the money)',
  cases: [
    {
      name: 'setup: a fresh guest pays for a fully-refundable stay with the dispute-triggering test card',
      run: async () => {
        ctx.guest = await registerFreshUser('DisputeGuest');
        const listing = await pickListing(ctx.guest.tokens, { minPrice: 1, policy: 'full_refund_24h' });

        // Spelled out rather than using bookAndConfirm(), so the booking id is
        // in ctx before anything can throw and the cleanup case can always
        // find it.
        const dates = futureDates();
        const draft = await initiateBooking(ctx.guest.tokens, listing.id, dates);
        ctx.bookingId = draft.id;
        const pricing = await calcPricing(ctx.guest.tokens, listing.price);
        ctx.total = pricing.total;
        const intent = await createPaymentIntent(ctx.guest.tokens, {
          bookingId: draft.id,
          guestId: ctx.guest.id,
          hostId: listing.host.id,
          listingId: listing.id,
          amount: pricing.total,
          currency: listing.currency,
        });
        await payWithTestCard(intent, 'tok_createDispute');
        await finalizeBooking(ctx.guest.tokens, draft.id, { dates, paymentReference: intent.id, amount: pricing.total });
        const status = await poll(
          async () => {
            const b = await getBooking(ctx.guest.tokens, draft.id);
            return { done: b.status === 'confirmed', value: b.status };
          },
          { timeoutMs: 90000, intervalMs: 4000, desc: `booking ${draft.id} to reach status=confirmed` }
        );
        assert(status === 'confirmed', `expected the paid booking confirmed, got ${status}`);
      },
    },
    {
      // Bug 3's regression guard: the dispute must be recorded WITHOUT
      // touching booking.status. A status change here drops the booking out of
      // auto-complete, and the host is never paid at all.
      name: "THE GUARD: the dispute lands on the booking as has_dispute, and the booking's status stays confirmed",
      run: async () => {
        const booking = await poll(
          async () => {
            const b = await getBooking(ctx.guest.tokens, ctx.bookingId);
            return { done: b.has_dispute === true, value: b };
          },
          { timeoutMs: 180000, intervalMs: 5000, desc: `booking ${ctx.bookingId} to be flagged has_dispute` }
        );
        assert(booking.has_dispute === true, `expected has_dispute=true, got ${JSON.stringify(booking.has_dispute)}`);
        assert(
          booking.status === 'confirmed',
          `CR-612 regression: a dispute must not change the booking status (it would drop the stay out of ` +
            `auto-complete and the host would never be paid) — expected 'confirmed', got '${booking.status}'`
        );
      },
    },
    {
      // Bug 2's regression guard: a dispute arriving before completion (there
      // is no payout row yet) must still be recorded on the charge itself.
      name: 'the charge row carries an open dispute_status (a pre-completion dispute is not dropped)',
      run: async () => {
        const charge = await poll(
          async () => {
            const txns = await getBookingTransactions(ctx.guest.tokens, ctx.bookingId);
            const row = txns.find((t) => t.type === 'booking');
            return { done: !!row?.dispute_status, value: row };
          },
          { timeoutMs: 90000, intervalMs: 5000, desc: 'the charge ledger row to carry the dispute' }
        );
        // `charge.status` IS asserted now: with the completed-yields-to-disputed
        // guard (payment-service `shouldCompleteTransaction`, applied on every
        // success path — Stripe payment_intent.succeeded, the PayPal confirm and
        // PAYMENT.CAPTURE.COMPLETED paths, and standalone charges) the charge row
        // stays `disputed` for as long as the dispute is open, in BOTH delivery
        // orders. If this goes red with `completed`, a success path has stopped
        // honouring that guard — do not loosen it back.
        assert(
          charge.status === 'disputed',
          `expected the charge row to stay 'disputed' while the dispute is open, got '${charge.status}'`
        );
        assert(
          ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'].includes(charge.dispute_status),
          `expected an OPEN dispute_status on the charge row, got '${charge.dispute_status}'`
        );
      },
    },
    {
      // The money assertion. Without the CR-612 hold this cancellation would
      // refund the full total on top of whatever the dispute later pays out.
      name: 'THE GUARD: cancelling during the open dispute HOLDS the full refund (on_hold) instead of sending it',
      run: async () => {
        await cancelBooking(ctx.guest.tokens, ctx.bookingId);
        ctx.cancelled = true;
        const txns = await poll(
          async () => {
            const rows = await getBookingTransactions(ctx.guest.tokens, ctx.bookingId);
            return { done: rows.some((t) => t.type === 'refund'), value: rows };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: 'the cancellation to produce a refund ledger row' }
        );
        const refunds = txns.filter((t) => t.type === 'refund');
        assert(refunds.length === 1, `expected exactly one refund row, got ${JSON.stringify(refunds)}`);
        const [refund] = refunds;
        assert(
          refund.status === 'on_hold',
          `CR-612 regression: a refund must be HELD while a dispute is open (Stripe refuses refunds on a disputed ` +
            `charge, and the dispute may pay the guest anyway) — expected status='on_hold', got '${refund.status}'`
        );
        assert(
          Math.abs(refund.amount - ctx.total) < 0.005,
          `expected the full ${ctx.total} policy refund to be held (full_refund_24h, cancelled ~a year out), got ${refund.amount}`
        );
        // Belt and braces: the cancellation didn't spawn a second charge, and
        // the charge still shows the open dispute (its `status` field is the
        // racy one — see the note at the top of this file).
        const charges = txns.filter((t) => t.type === 'booking');
        assert(charges.length === 1, `expected exactly one charge row, got ${JSON.stringify(charges)}`);
        assert(!!charges[0].dispute_status, `expected the charge to still carry the dispute, got ${JSON.stringify(charges[0])}`);
      },
    },
    {
      // Cleanup, deliberately tolerant about the state it finds: whatever the
      // flow reached (draft that never paid, paid-but-unconfirmed, confirmed,
      // or already cancelled by the case above), the booking must not be left
      // occupying its listing's dates.
      //
      // It is NOT tolerant about the state it leaves. This runs on the failure
      // path too (lib/runner.mjs keeps going past a failed case precisely so
      // cleanup still runs), which is exactly when a leak would otherwise slip
      // through unnoticed and silently block those dates on a staging listing
      // for every later run. So the teardown is verified, not assumed.
      name: 'cleanup: tear down the booking, and prove it ended cancelled',
      run: async () => {
        if (!ctx.bookingId) return;
        const booking = await getBooking(ctx.guest.tokens, ctx.bookingId);
        if (booking.status === 'draft') {
          await deleteDraftBooking(ctx.guest.tokens, ctx.bookingId);
          return; // deleted outright — nothing left to read back
        }
        if (booking.status !== 'cancelled') await cancelBooking(ctx.guest.tokens, ctx.bookingId);

        const final = await getBooking(ctx.guest.tokens, ctx.bookingId);
        assert(
          final.status === 'cancelled',
          `LEAK: booking ${ctx.bookingId} was left at status='${final.status}' instead of 'cancelled' — ` +
            `it is still holding its listing's dates on staging`
        );
      },
    },
  ],
};
