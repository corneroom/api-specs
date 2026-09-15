// payment-service — the host-money surfaces: Stripe Connect payout status and
// the earnings summary.
//
// These are the screens a host looks at to answer "will I get paid, and how
// much have I made", and until now the suite only proved they reject anonymous
// callers (services/payouts.mjs). This file proves what they actually SAY for a
// user who has never hosted and never connected a payout method, and that a
// guest paying for a stay never looks like a host to the payout account or to
// the earnings ledger the product really keeps (`/users/me/stats` —
// see descope 3; `/payments/earnings` is a dead read).
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
// 2. "earnings go UP after a completed stay" — STILL NOT DRIVABLE, but no
//    longer for want of a host. The suite now holds a seeded bot HOST
//    credential (TEST_HOST_EMAIL — see tests/README.md), and
//    services/booking-host-flow.mjs asserts the HOST-side negative directly:
//    accepting a stay, and then having it cancelled, credits
//    `stats.earnings` nothing. The positive stays out of reach because the
//    credit only happens at COMPLETION, after check-out, which for this suite's
//    fixtures is ~a year out. The other negative half — "a guest is credited
//    nothing" — is drivable and is asserted below, on the live surface.
//
// 3. `GET /payments/earnings` IS NOT THE EARNINGS LEDGER, so nothing here
//    treats it as one. It reads the Firestore `earnings/{userId}` document
//    (payment-service internal/service/firebase.go:330) and NOTHING in the
//    backend writes that collection — it is the only reference to it in any
//    service, so it returns all-zeros for every user unconditionally. Asserting
//    "the guest has zero earnings" there would be a tautology: it would pass
//    even if the guest had genuinely been credited. Its case below therefore
//    claims only what it can prove — the response SHAPE the app renders — and
//    the real money claim is made against the ledger the product actually uses:
//    `GET /users/me/stats` -> `stats.earnings.<line>`, written by booking-service
//    (internal/service/booking_completion.go:358 `creditHostSpaceEarnings` -> a
//    `user_stats_update` event consumed by user-service internal/service/user.go:2400
//    `creditEarnings` -> internal/repository/user_repository_firestore.go:100-102).
//    If `/payments/earnings` is ever wired to a real ledger, this file is where
//    the "it moved" case belongs.
//
// LEAK DISCIPLINE (see rewards-referral-flow.mjs's header): this file creates
// one real paid booking on a bot-hosted fixture and cancels it in the trailing
// cleanup, verified. It creates NOTHING on Stripe's side beyond that booking's
// own charge — see descope 1. Residue: the throwaway qa+<digits>@bot.com guest.
import {
  registerFreshUser,
  pickListing,
  bookAndConfirm,
  getBooking,
  cancelBooking,
  teardownBooking,
} from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { config } from '../lib/env.mjs';
import { authHeaders } from '../lib/auth.mjs';
import { poll } from '../lib/poll.mjs';

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
// The LIVE earnings ledger — see descope 3. `data` is the whole UserStats
// (user-service internal/rest/profile_handler.go:345-365).
const myStats = (tokens) => gw(tokens, '/users/me/stats');

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

// SHAPE ONLY — deliberately not a claim about anyone's money. `/payments/earnings`
// reads a collection nothing writes (descope 3), so these zeros are
// unconditional: every field being 0 proves the endpoint answers with a complete
// rest.EarningsResponse (a missing field renders a blank tile in the app rather
// than a zero), and nothing more.
function assertEarningsResponseShape(where, d) {
  assert(d, `${where}: no data in the earnings response`);
  for (const k of ['total_earnings', 'monthly_earnings', 'yearly_earnings', 'average_per_night']) {
    assert(d[k] === 0, `${where}: expected ${k}=0 (this endpoint reads a collection nothing writes), got ${JSON.stringify(d[k])}`);
  }
  for (const k of ['active_bookings', 'completed_bookings']) {
    assert(d[k] === 0, `${where}: expected ${k}=0, got ${JSON.stringify(d[k])}`);
  }
  assert(d.currency === 'usd', `${where}: expected the default currency 'usd', got '${d.currency}'`);
}

// THE REAL NEGATIVE. `stats.earnings.<line>` is what the product credits and
// what the app shows a host; `EarningsStats`/`EarningsLedger` are `omitempty`
// all the way down (user-service internal/data/user.go:403, :408-420), so a user
// who has been credited nothing has NO `earnings` key at all. Absent and
// all-zero are both "nothing was credited" — any positive lifetime, or any
// positive month bucket, is a real credit landing on the wrong party.
function assertNoEarningsCredited(where, stats) {
  const e = stats?.earnings;
  if (e === undefined || e === null) return; // the normal shape for a non-host
  for (const line of ['spaces', 'experiences']) {
    const ledger = e[line];
    if (ledger === undefined || ledger === null) continue;
    assert(
      !(ledger.lifetime > 0),
      `${where}: stats.earnings.${line}.lifetime is ${JSON.stringify(ledger.lifetime)} — this user has only ever SPENT ` +
        `money, so a credit here means the host-earnings ledger was written for the guest`
    );
    for (const [month, amount] of Object.entries(ledger.by_month ?? {})) {
      assert(
        !(amount > 0),
        `${where}: stats.earnings.${line}.by_month.${month} is ${JSON.stringify(amount)} — see above`
      );
    }
  }
}

// Proof that this user's stats document is genuinely live before the negative
// above is read from it. A guest cancellation publishes
// `booking.cancelled.by.guest` targeting the GUEST, which user-service maps to
// `stats.bookings.as_guest.cancelled` (internal/service/user.go:2426). It
// travels the same `user_stats_update` topic and the same writer as an earnings
// credit would, so seeing it arrive rules out "the zeros are just a stats
// document nothing ever reaches".
const guestCancelledCount = (stats) => stats?.bookings?.as_guest?.cancelled ?? 0;

export default {
  name: 'payment-service × user-service (payout status, and the earnings ledger of a guest who hosts nothing)',
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
      // SHAPE ONLY — this endpoint is all-zero for everyone (descope 3), so it
      // cannot carry a claim about anybody's money. The money claim lives in
      // the two guards below, against `/users/me/stats`.
      name: 'GET /payments/earnings returns the full documented response SHAPE (unconditionally zero — not a money assertion)',
      run: async () => {
        const { status, data, text } = await earnings(ctx.user.tokens);
        assert(status === 200, `expected 200, got ${status}: ${text.slice(0, 200)}`);
        assertEarningsResponseShape('fresh user', data);

        // The ledger the product actually uses, for the same fresh user: a
        // brand-new account has never hosted, so it must carry no earnings.
        const stats = await myStats(ctx.user.tokens);
        assert(stats.status === 200, `expected 200 from /users/me/stats, got ${stats.status}: ${stats.text.slice(0, 200)}`);
        assertNoEarningsCredited('fresh user', stats.data);
      },
    },
    {
      // THE GUARD. Both reads are keyed on the caller's user id, and both have
      // a "the other party" version one join away: an earnings credit belongs
      // to the booking's host_id, the payout account to the host. If either
      // ever starts matching on the GUEST, a guest who has only ever SPENT
      // money would be shown earnings and a payout setup prompt.
      //
      // The charge assertion is what stops this being a test of a dead system:
      // it proves real money moved on this very user before the ledger is read.
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

        const statsAfter = await myStats(ctx.user.tokens);
        assert(
          statsAfter.status === 200,
          `expected 200 from /users/me/stats, got ${statsAfter.status}: ${statsAfter.text.slice(0, 200)} — ` +
            'an unreadable ledger is not a proof of an empty one'
        );
        assertNoEarningsCredited('guest after paying for a confirmed stay', statsAfter.data);
        // Shape check only, for the same reason as the case above.
        const { data: earningsAfter } = await earnings(ctx.user.tokens);
        assertEarningsResponseShape('guest after paying for a stay', earningsAfter);

        const { data: connectAfter } = await connectStatus(ctx.user.tokens);
        assertNotConnected('guest after paying for a stay', connectAfter);
      },
    },
    {
      // The second half of the same guard, and the one that proves the ledger
      // is being watched rather than merely being empty: cancelling publishes a
      // `user_stats_update` that DOES land on this guest
      // (`stats.bookings.as_guest.cancelled`), down the same topic and through
      // the same writer an earnings credit would use. So when it arrives and
      // `stats.earnings` is still absent, that absence means something.
      name: "THE GUARD: the cancellation reaches the guest's stats — and still credits them no earnings",
      run: async () => {
        assert(ctx.bookingId, 'no booking to cancel — the guard above did not get far enough');
        await cancelBooking(ctx.user.tokens, ctx.bookingId);

        const stats = await poll(
          async () => {
            const { data } = await myStats(ctx.user.tokens);
            return { done: guestCancelledCount(data) >= 1, value: data };
          },
          {
            timeoutMs: 120000,
            intervalMs: 5000,
            desc: "the guest's own cancellation counter to reach stats.bookings.as_guest.cancelled",
          }
        );
        assertNoEarningsCredited('guest after cancelling their stay', stats);
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
