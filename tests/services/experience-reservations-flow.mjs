// listing-service × booking-service × payment-service — a guide-led Experience
// reservation, end to end, with real money.
//
// Experiences had ZERO gateway coverage before this file, and they are the
// product's second money path: a different reservation collection, a different
// charge surface, a different refund policy table, and a capacity hold that can
// oversell a session if the seat accounting drifts. None of that is exercised
// by the space-booking flows.
//
// OWNERSHIP (see the aggregator CLAUDE.md — this moved out of community-service
// in 2026-06 and nothing experience-shaped may go back there):
//   listing-service   catalogue        GET /experiences, GET /guides
//   booking-service   seats + lifecycle POST /experiences/{id}/sessions/{sid}/reserve,
//                                       POST /experience-reservations/{id}/cancel,
//                                       GET  /experience-reservations/mine
//   payment-service   money            POST /payments/charges, GET /payments/history
//
// WHAT THIS PROVES, against staging with real Stripe sandbox objects:
//   1. reserve holds a seat and asks for payment — `reserved` / `pending`, with
//      a BACKEND-authoritative fee breakdown (gross = subtotal + fee + tax)
//   2. re-tapping Reserve reuses the same hold instead of taking a second seat
//   3. paying the standalone charge confirms the reservation and writes ONE
//      `experience` ledger row keyed on the reservation id
//   4. cancelling >24h out under `flexible` refunds the FULL gross (fees and
//      tax included — the partial tiers keep the platform fee, the full tier
//      does not: booking-service internal/service/experience_reservation.go:704)
//   5. the refund releases the seat, and a repeat cancel is a silent no-op
//      rather than a second refund
//
// THE CHARGE IS NOT A BOOKING INTENT. `POST /payments/charges` is the
// standalone surface: `{type, reference}` and no booking fields, immediate
// capture (payment-service internal/service/stripe_service.go:256), so there is
// no `requires_capture` stage and no host-acceptance step — unlike a stay. The
// `experience:<expId>/reservation:<resId>` reference shape is load-bearing on
// both sides (booking-service parses the reservation id back out of it at
// experience_reservation.go:1042; payment-service keys the ledger row's
// booking_id on the same parse at payment.go:3838), which is why it is built by
// a helper rather than inline.
//
// FIXTURES ARE BOT-GUIDED ONLY, and deriving that is the fiddly part — the
// authoritative `guide_is_bot` flag is `json:"-"` and never leaves the service.
// See lib/experience-helpers.mjs's `pickBotGuidedExperience` for the proxy used
// instead and the cross-check behind it. Staging's catalogue genuinely contains
// real people (Zoey guides "Park Tour"; the owner's own account guides several
// `exp_sample_*`), and reserving one pushes them a notification for real.
//
// LEAK DISCIPLINE (see rewards-referral-flow.mjs's header): a reservation holds
// a SEAT on a shared staging session, so leaking one permanently shrinks the
// fixture. The reservation id is captured the moment it exists and the trailing
// cleanup cancels it whatever state the flow reached (lib/runner.mjs keeps
// going past a failure precisely so cleanup runs), then the seat count is
// asserted back to where it started. Unavoidable residue: the throwaway
// qa+<digits>@bot.com guest and the settled Stripe sandbox charge/refund.
//
// FIXTURE RUNWAY: sessions are seeded a few days out and this picker takes the
// earliest one >25h away. Cancelled reservations return their seat, so runs do
// not consume capacity — but the seeded sessions do eventually fall into the
// past. When `pickBotGuidedExperience` starts throwing "no bot-guided PAID
// experience ... with a scheduled session", that is a seeding task, not a
// product regression; the message says so.
import { registerFreshUser, payWithTestCard } from '../lib/booking-flow.mjs';
import {
  pickBotGuidedExperience,
  listSessions,
  reserveSession,
  reserveSessionRaw,
  chargeReference,
  createExperienceCharge,
  getMyReservation,
  cancelReservation,
  cancelReservationRaw,
  teardownReservation,
} from '../lib/experience-helpers.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// How long to wait before concluding a repeat cancel refunded nothing further.
// Nothing arrives, so there is nothing to poll for. Calibrated against the
// FIRST refund in this same file, which logs its own latency — it was ~6s on
// staging 2026-09-13, so this is a ~7x margin. Raise it if that log ever
// creeps up; a window that is too short turns the case into a false pass.
const NO_SECOND_REFUND_GRACE_MS = 40000;

// booked_count on the shared staging session. Every assertion on it here is a
// DELTA from a snapshot taken at setup, not an absolute — but it still assumes
// nothing else is reserving the same session mid-run. That is already the
// suite's contract (tests/README.md: never run two invocations concurrently);
// if this ever fails by exactly one seat, suspect a second runner before
// suspecting the seat accounting.
async function seatCount(tokens, experienceId, sessionId) {
  const s = (await listSessions(tokens, experienceId)).find((x) => x.id === sessionId);
  assert(s, `session ${sessionId} vanished from experience ${experienceId}`);
  return s.booked_count ?? 0;
}

export default {
  name: 'experiences (reserve → pay → confirm → cancel → refund, guide-led)',
  cases: [
    {
      name: 'setup: a fresh guest holds a seat on a bot-guided paid experience',
      run: async () => {
        ctx.guest = await registerFreshUser('ExpGuest');
        // `flexible` + a session >25h out pins the refund tier deterministically:
        // `flexible` with >= 24h to go is the FULL-refund branch
        // (experience_reservation.go:704). Any other combination silently
        // changes what the cancellation case below is asserting.
        const { experience, session } = await pickBotGuidedExperience(ctx.guest.tokens, {
          policy: 'flexible',
          minHoursOut: 25,
        });
        ctx.experience = experience;
        ctx.session = session;
        ctx.seatsBefore = await seatCount(ctx.guest.tokens, experience.id, session.id);

        const reservation = await reserveSession(ctx.guest.tokens, experience.id, session.id, 1);
        ctx.reservationId = reservation.id;
        ctx.reservation = reservation;

        assert(reservation.status === 'reserved', `expected a payment-pending hold, got status='${reservation.status}'`);
        assert(
          reservation.payment_status === 'pending',
          `expected payment_status='pending' on a paid hold, got '${reservation.payment_status}'`
        );
        assert(reservation.requires_payment === true, 'a paid experience must report requires_payment=true');
        assert(
          reservation.booking_code?.startsWith('EX-'),
          `experience reservations carry an EX- code (spaces use CR-), got '${reservation.booking_code}'`
        );
        // The breakdown is backend-authoritative — the app charges exactly what
        // this says (experiences_reserve_page.dart `_buildRequestFor`), so it
        // must be internally consistent or the guest is charged the wrong total.
        const expectedGross = reservation.total_amount + reservation.service_fee + reservation.tax;
        assert(
          Math.abs(reservation.gross_amount - expectedGross) < 0.005,
          `gross_amount must equal subtotal + service_fee + tax — got ${reservation.gross_amount} vs ${expectedGross}`
        );
        assert(
          Math.abs(reservation.total_amount - ctx.experience.price) < 0.005,
          `1 participant must be charged the experience price ${ctx.experience.price}, got subtotal ${reservation.total_amount}`
        );

        const seatsAfter = await seatCount(ctx.guest.tokens, experience.id, session.id);
        assert(
          seatsAfter === ctx.seatsBefore + 1,
          `reserving one seat must take exactly one — booked_count went ${ctx.seatsBefore} -> ${seatsAfter}`
        );
      },
    },
    {
      // The oversell guard. The app re-issues Reserve whenever the guest backs
      // out of the payment sheet and taps again; each one must land on the SAME
      // hold (experience_reservation.go:317-328), not take another seat and
      // another pending charge.
      name: 'THE GUARD: re-tapping Reserve reuses the same hold — it does not take a second seat',
      run: async () => {
        const { status, data } = await reserveSessionRaw(ctx.guest.tokens, ctx.experience.id, ctx.session.id, 1);
        assert(status === 201, `expected the repeat reserve to succeed, got ${status}`);
        assert(
          data.id === ctx.reservationId,
          `a repeat reserve minted a SECOND reservation ${data.id} instead of reusing ${ctx.reservationId} — ` +
            `the session is now oversold by one and the guest has two pending holds`
        );
        const seats = await seatCount(ctx.guest.tokens, ctx.experience.id, ctx.session.id);
        assert(
          seats === ctx.seatsBefore + 1,
          `a reused hold must not take another seat — booked_count is ${seats}, expected ${ctx.seatsBefore + 1}`
        );
      },
    },
    {
      name: 'paying the standalone charge confirms the reservation and writes ONE experience ledger row',
      run: async () => {
        const reference = chargeReference(ctx.experience.id, ctx.reservationId);
        ctx.charged = ctx.reservation.gross_amount;
        const intent = await createExperienceCharge(ctx.guest.tokens, {
          reference,
          amount: ctx.charged,
          currency: ctx.experience.currency,
          description: ctx.experience.title,
        });
        assert(intent.id?.startsWith('pi_'), `expected a Stripe PaymentIntent, got ${JSON.stringify(intent)}`);
        ctx.intent = intent;
        await payWithTestCard(intent);

        const confirmed = await poll(
          async () => {
            const r = await getMyReservation(ctx.guest.tokens, ctx.reservationId);
            return { done: r?.status === 'confirmed', value: r };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: `reservation ${ctx.reservationId} to confirm from its payment` }
        );
        assert(
          confirmed.payment_status === 'paid',
          `a confirmed reservation must be marked paid, got payment_status='${confirmed.payment_status}'`
        );

        // payment-service records standalone charges under the BARE reservation
        // id (payment.go:3836-3838), which is what makes them join with their
        // refund row and show up in the guest's own history.
        const rows = await poll(
          async () => {
            const r = await getBookingTransactions(ctx.guest.tokens, ctx.reservationId);
            return { done: r.some((t) => t.type === 'experience'), value: r };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: 'the experience charge to reach the guest ledger' }
        );
        const charges = rows.filter((t) => t.type === 'experience');
        assert(charges.length === 1, `expected exactly one experience charge row, got ${JSON.stringify(charges)}`);
        assert(
          charges[0].status === 'completed',
          `an experience charge is captured immediately — expected 'completed', got '${charges[0].status}'`
        );
        assert(
          Math.abs(charges[0].amount - ctx.charged) < 0.01,
          `the ledger must show what was actually charged (${ctx.charged}), got ${charges[0].amount}`
        );
        assert(
          charges[0].currency?.toLowerCase() === ctx.experience.currency.toLowerCase(),
          `expected the experience's own currency ${ctx.experience.currency}, got ${charges[0].currency}`
        );
      },
    },
    {
      // The money assertion. `flexible` cancelled >24h out is the FULL branch,
      // and "full" here means gross — subtotal + service fee + tax. The partial
      // branches deliberately keep the platform fee; if this ever comes back
      // short by the fee, the full/partial branches have been conflated.
      name: 'THE GUARD: cancelling >24h out under `flexible` refunds the FULL gross, fees and tax included',
      run: async () => {
        await cancelReservation(ctx.guest.tokens, ctx.reservationId);
        const startedAt = Date.now();

        const rows = await poll(
          async () => {
            const r = await getBookingTransactions(ctx.guest.tokens, ctx.reservationId);
            return { done: r.some((t) => t.type === 'refund'), value: r };
          },
          { timeoutMs: 150000, intervalMs: 5000, desc: 'the experience cancellation to produce a refund ledger row' }
        );
        // Calibration for NO_SECOND_REFUND_GRACE_MS — see its comment.
        console.log(`    · experience refund row landed ${Date.now() - startedAt}ms after cancel`);
        const refunds = rows.filter((t) => t.type === 'refund');
        assert(refunds.length === 1, `expected exactly one refund row, got ${JSON.stringify(refunds)}`);
        assert(
          Math.abs(refunds[0].amount - ctx.charged) < 0.01,
          `a full-refund policy must return the whole ${ctx.charged} charged (fees + tax included) — got ${refunds[0].amount}. ` +
            `Short by the service fee means the partial-tier fee-keep rule leaked into the full branch`
        );

        const settled = await poll(
          async () => {
            const r = await getMyReservation(ctx.guest.tokens, ctx.reservationId);
            return { done: r?.payment_status === 'refunded', value: r };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: `reservation ${ctx.reservationId} to settle as refunded` }
        );
        assert(settled.status === 'cancelled', `expected the reservation cancelled, got '${settled.status}'`);

        // The seat only comes back when the refund finalizes
        // (experience_reservation.go:1005 `FinalizeRefunded` -> releaseSeat).
        // If it doesn't, every CI run permanently shrinks a shared session.
        const seats = await seatCount(ctx.guest.tokens, ctx.experience.id, ctx.session.id);
        assert(
          seats === ctx.seatsBefore,
          `the refunded reservation must give its seat back — booked_count is ${seats}, expected ${ctx.seatsBefore}`
        );
      },
    },
    {
      // Idempotency, and specifically that it is a SILENT no-op: the service
      // returns nil for an already-terminal reservation (experience_reservation.go:556),
      // so the app's retry must not 409, and — the part that costs money — must
      // not queue a second refund against a charge that was already fully
      // returned.
      name: 'THE GUARD: cancelling an already-cancelled reservation is a no-op, not a second refund',
      run: async () => {
        const { status } = await cancelReservationRaw(ctx.guest.tokens, ctx.reservationId);
        assert(status === 200, `a repeat cancel must be an idempotent 200, got ${status}`);

        // Nothing is expected to happen, so there is nothing to poll for — give
        // a second refund a fair chance to (wrongly) appear before asserting
        // the negative (same pattern as rewards-referral-flow.mjs scenario 4c).
        await new Promise((r) => setTimeout(r, NO_SECOND_REFUND_GRACE_MS));
        const rows = await getBookingTransactions(ctx.guest.tokens, ctx.reservationId);
        const refunds = rows.filter((t) => t.type === 'refund');
        assert(
          refunds.length === 1,
          `a repeat cancel refunded the guest AGAIN — ${refunds.length} refund rows for one charge: ${JSON.stringify(refunds)}`
        );
        const after = await getMyReservation(ctx.guest.tokens, ctx.reservationId);
        assert(after?.status === 'cancelled', `expected the reservation to stay cancelled, got '${after?.status}'`);
      },
    },
    {
      // Cleanup only — the cancellation cases above already cancelled it; this
      // is what covers a mid-flow failure, which is exactly when a held seat
      // would otherwise sit on a shared staging session forever.
      name: "cleanup: release the reservation's seat, and prove it ended cancelled",
      run: async () => {
        await teardownReservation(ctx.guest.tokens, ctx.reservationId);
        if (!ctx.reservationId) return;
        const final = await getMyReservation(ctx.guest.tokens, ctx.reservationId);
        assert(
          !final || final.status === 'cancelled',
          `LEAK: reservation ${ctx.reservationId} was left at status='${final?.status}' — it is still holding a seat ` +
            `on session ${ctx.session?.id} of experience ${ctx.experience?.id} on staging`
        );
      },
    },
  ],
};
