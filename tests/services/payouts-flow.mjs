// payment-service — the host-money surfaces: Stripe Connect payout status and
// the earnings summary.
//
// These are the screens a host looks at to answer "will I get paid, and how
// much have I made", and until now the suite only proved they reject anonymous
// callers (services/payouts.mjs). This file proves what they actually SAY for a
// user who has never hosted and never connected a payout method, and that a
// guest paying for a stay does not accidentally look like a host to either
// query.
//
// ── WHAT IS DELIBERATELY NOT COVERED, AND WHY ─────────────────────────────
//
// 1. `POST /payouts/connect/onboarding` (happy path) — DESCOPED, leak discipline.
//    It is not a link generator, it is a WRITE: it creates a real Stripe Connect
//    Express account and persists `stripe_account_id` + `stripe_connect_status`
//    on the user (payment-service internal/service/payout_service.go:1058-1080).
//    Deleting a Connect account needs a Stripe SECRET key, and this suite only
//    ever holds a publishable one (it confirms intents exactly like the mobile
//    SDK does). Running it on the 6-hourly CI cadence would accumulate ~1,500
//    undeletable sandbox Connect accounts a year. The rest of the flow behind it
//    — the Stripe-hosted onboarding form — cannot be driven headless anyway.
//    The auth guard on the endpoint stays in services/payouts.mjs.
//
// 2. "earnings go up after a stay, and back down after a cancellation" —
//    NOT DRIVABLE, and for a second reason worth writing down before someone
//    tries again:
//      a) Earnings are the HOST's. Every bookable fixture on staging is hosted
//         by a seeded bot whose credentials this suite does not have (same
//         blocker as host accept/decline — see booking-lifecycle-flow.mjs's
//         header), so there is no identity to read them as.
//      b) Even with that identity it still would not move. `GET /payments/earnings`
//         reads the Firestore `earnings/{userId}` document (payment-service
//         internal/service/firebase.go:330) and NOTHING in the backend writes
//         that collection — it is the only reference to it in any service. The
//         live host-earnings surface is `users/{id}.stats.earnings.<line>`,
//         credited by booking-service at COMPLETION, not confirmation
//         (internal/service/booking_completion.go:358 `creditHostSpaceEarnings`
//         -> a `user_stats_update` event consumed by user-service
//         internal/repository/user_repository_firestore.go:100), and completion
//         only happens after check-out — which for this suite's fixtures is
//         ~a year out.
//    So the assertions below pin the SHAPE and the always-zero contract of
//    `/payments/earnings` rather than pretending to watch a total change. If
//    that endpoint is ever wired to a real ledger, this file is where the
//    "it moved" case belongs.
//
// LEAK DISCIPLINE (see rewards-referral-flow.mjs's header): this file creates
// one real paid booking on a bot-hosted fixture and cancels it in the trailing
// cleanup, verified. It creates NOTHING on Stripe's side beyond that booking's
// own charge — see descope 1. Residue: the throwaway qa+<digits>@bot.com guest.
import { registerFreshUser, pickListing, bookAndConfirm, getBooking, teardownBooking } from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { config } from '../lib/env.mjs';
import { authHeaders } from '../lib/auth.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function gw(tokens, path, init = {}) {
  const res = await fetch(`${config.gwUrl}${path}`, { ...init, headers: authHeaders(tokens, 'full') });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, data: json?.data, text };
}

const connectStatus = (tokens) => gw(tokens, '/payouts/connect/status');
const earnings = (tokens) => gw(tokens, '/payments/earnings');

// The documented no-method state, field for field
// (payment-service internal/service/payout_service.go:1186-1192 ->
// data.ConnectStatusResult). `provider` exists because the app previously had
// no way to tell which payout method a status response was even about and
// defaulted every host to a "Stripe" badge — so its presence is the assertion,
// not decoration.
function assertNotConnected(where, d) {
  assert(d, `${where}: no data in the connect-status response`);
  assert(d.connected === false, `${where}: expected connected=false, got ${JSON.stringify(d.connected)}`);
  assert(d.status === 'not_connected', `${where}: expected status='not_connected', got '${d.status}'`);
  assert(d.provider === 'stripe', `${where}: expected provider='stripe' (the app labels the badge from this), got '${d.provider}'`);
  assert(d.account_id === '', `${where}: a host with no payout method must have no account id, got '${d.account_id}'`);
}

function assertZeroEarnings(where, d) {
  assert(d, `${where}: no data in the earnings response`);
  // Every field of rest.EarningsResponse — a missing one means the app renders
  // a blank tile rather than a zero.
  for (const k of ['total_earnings', 'monthly_earnings', 'yearly_earnings', 'average_per_night']) {
    assert(d[k] === 0, `${where}: expected ${k}=0 for a user who has never hosted, got ${JSON.stringify(d[k])}`);
  }
  for (const k of ['active_bookings', 'completed_bookings']) {
    assert(d[k] === 0, `${where}: expected ${k}=0, got ${JSON.stringify(d[k])}`);
  }
  assert(d.currency === 'usd', `${where}: expected the default currency 'usd', got '${d.currency}'`);
}

export default {
  name: 'payment-service (payout status + earnings for a host who has neither)',
  cases: [
    {
      name: 'setup: a fresh user who has never hosted and never connected a payout method',
      run: async () => {
        ctx.user = await registerFreshUser('PayoutUser');
      },
    },
    {
      name: "GET /payouts/connect/status reports the documented 'not_connected' shape",
      run: async () => {
        const { status, data, text } = await connectStatus(ctx.user.tokens);
        assert(status === 200, `expected 200, got ${status}: ${text.slice(0, 200)}`);
        assertNotConnected('fresh user', data);
      },
    },
    {
      // A host with no Connect account has no Express dashboard to log into
      // (payout_service.go:1290 returns "user has no connected Stripe account"),
      // and the endpoint must say so rather than hand back a link to nothing.
      // This is read-only — it fails before any Stripe call, so nothing is created.
      name: 'POST /payouts/connect/dashboard-link is refused for a user with no Connect account — and returns no URL',
      run: async () => {
        const { status, data, text } = await gw(ctx.user.tokens, '/payouts/connect/dashboard-link', { method: 'POST' });
        assert(
          ![404, 405].includes(status),
          `POST /payouts/connect/dashboard-link is not routed on the app gateway (${status}) — ` +
            're-run `make gateway ENV=staging`; this case cannot prove anything until it is'
        );
        assert(status >= 400, `expected a refusal for a user with no Connect account, got ${status}: ${text.slice(0, 200)}`);
        assert(!data?.url, `a refused dashboard-link request must not return a URL, got ${JSON.stringify(data)}`);
      },
    },
    {
      name: 'GET /payments/earnings returns the full earnings shape, all zero',
      run: async () => {
        const { status, data, text } = await earnings(ctx.user.tokens);
        assert(status === 200, `expected 200, got ${status}: ${text.slice(0, 200)}`);
        assertZeroEarnings('fresh user', data);
      },
    },
    {
      // THE GUARD. Both queries are keyed on the caller's user id, and both
      // have a "the other party" version one join away: earnings belong to the
      // transaction's host_id, the payout account to the host. If either ever
      // starts matching on the GUEST, a guest who has only ever SPENT money
      // would be shown earnings and a payout setup prompt.
      //
      // The charge assertion is what stops this being a test of a dead system:
      // it proves real money moved on this very user before the zeros are read.
      name: 'THE GUARD: paying for a stay as a GUEST credits no earnings and creates no payout account',
      run: async () => {
        const listing = await pickListing(ctx.user.tokens, { minPrice: 1 });
        const booked = await bookAndConfirm(ctx.user.tokens, listing, {
          guestId: ctx.user.id,
          hostId: listing.host.id,
          onDraft: (id) => {
            ctx.bookingId = id;
          },
        });
        ctx.bookingId = booked.bookingId;

        const charges = (await getBookingTransactions(ctx.user.tokens, booked.bookingId)).filter((t) => t.type === 'booking');
        assert(
          charges.length === 1,
          `expected the guest's own charge in their ledger (otherwise the zeros below prove nothing), got ${JSON.stringify(charges)}`
        );

        const { data: earningsAfter } = await earnings(ctx.user.tokens);
        assertZeroEarnings('guest after paying for a stay', earningsAfter);

        const { data: connectAfter } = await connectStatus(ctx.user.tokens);
        assertNotConnected('guest after paying for a stay', connectAfter);
      },
    },
    {
      // Cleanup only — see the LEAK DISCIPLINE note up top. Tolerant of any
      // state (including a mid-flow throw), but the teardown is verified: an
      // uncancelled booking squats on a shared staging fixture's dates.
      name: 'cleanup: cancel the booking, and prove it ended cancelled',
      run: async () => {
        if (!ctx.bookingId) return;
        await teardownBooking(ctx.user.tokens, ctx.bookingId);
        const final = await getBooking(ctx.user.tokens, ctx.bookingId).catch(() => null);
        assert(
          !final || final.status === 'cancelled',
          `LEAK: booking ${ctx.bookingId} was left at status='${final?.status}' — it is still holding its listing's dates`
        );
      },
    },
  ],
};
