// reward-service — CR-588 regression: cancelling a referral's qualifying
// booking must RESET the referral to `pending` (so a genuine next paid
// booking still earns the reward), not permanently kill it — UNLESS the
// reward was already spent, in which case it must go permanently `void` to
// prevent a cancel/rebook farming cycle. See reward-service
// internal/service/completion.go `VoidReferralForCancelledBooking`.
//
// This is a deliberate WRITE-path flow (tests/README.md: "Mutating flows
// need fixtures + cleanup — add those deliberately per flow, not
// table-driven"), and a heavy one: it registers fresh throwaway accounts,
// drives real bookings through real Stripe-sandbox payments, and polls for
// Pub/Sub-driven side effects. Each `run` case is one step of the flow,
// executed in order, sharing state via closures — see lib/runner.mjs's
// `run:` case type. Expect this file alone to take 1-2 real minutes; it's
// no more expensive to run on staging than any other real booking, and
// test-gateway already runs on a slower cadence than the read-only smoke
// suite (every 6h in CI vs. every 30m) specifically to absorb write-flow
// files like this one.
//
// A referral code can only ever be applied ONCE per referred user (reward-
// service returns 409 on a second attempt), so every scenario below needs a
// genuinely fresh (never-referred) account — there is no way to "reset" this
// server-side, so we register new qa+<digits>@bot.com throwaways per pair
// rather than reusing tests/.env's shared account. See
// lib/booking-flow.mjs's `registerFreshUser`.
import { registerFreshUser, pickListing, bookAndConfirm, cancelBooking } from '../lib/booking-flow.mjs';
import { getWallet, getMyReferral, applyReferralCode } from '../lib/reward-helpers.mjs';
import { poll } from '../lib/poll.mjs';

// Shared across a pair's cases via closure.
let pairA = {}; // scenarios 1-3: baseline -> cancel-and-reset -> re-completion
let pairB = {}; // scenario 4: abuse guard (spend-then-cancel is terminal)
let pairC = {}; // scenario 5: free-stay exclusion

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export default {
  name: 'reward-service (CR-588 referral cancel/reset flow)',
  cases: [
    // ---------------------------------------------------------------
    // Pair A: baseline completion -> cancel-and-reset -> re-completion
    // ---------------------------------------------------------------
    {
      name: 'pair A: register referrer + referred, apply referral code',
      run: async () => {
        pairA.referrer = await registerFreshUser('ReferrerA');
        pairA.referred = await registerFreshUser('ReferredA');
        const code = (await getMyReferral(pairA.referrer.tokens)).code;
        assert(code, 'referrer has no referral code');
        const applied = await applyReferralCode(pairA.referred.tokens, code);
        assert(applied.status === 'pending', `expected fresh referral status=pending, got ${applied.status}`);
        pairA.listing = await pickListing(pairA.referred.tokens, { price: 5 });
        assert(pairA.listing, 'no $5 instant-book listing found on staging to seed a booking with');
      },
    },
    {
      name: 'scenario 1 (baseline): first paid booking issues a $5 coupon to BOTH parties and completes the referral',
      run: async () => {
        const { referrer, referred, listing } = pairA;
        pairA.booking1 = await bookAndConfirm(referred.tokens, listing, { guestId: referred.id, hostId: listing.host.id });

        const referrerWallet = await poll(
          async () => {
            const w = await getWallet(referrer.tokens);
            return { done: w.length > 0, value: w };
          },
          { desc: 'referrer wallet to receive the referral coupon' }
        );
        const referredWallet = await getWallet(referred.tokens);
        assert(referrerWallet.length === 1, `expected exactly 1 coupon in referrer wallet, got ${referrerWallet.length}`);
        assert(referredWallet.length === 1, `expected exactly 1 coupon in referred wallet, got ${referredWallet.length}`);
        assert(referrerWallet[0].value_cents === 500, `expected referrer coupon = 500 cents, got ${referrerWallet[0].value_cents}`);
        assert(referredWallet[0].value_cents === 500, `expected referred coupon = 500 cents, got ${referredWallet[0].value_cents}`);
        pairA.coupon1Referrer = referrerWallet[0].code;
        pairA.coupon1Referred = referredWallet[0].code;

        const referral = (await getMyReferral(referred.tokens)).referred_by;
        assert(referral?.status === 'completed', `expected referral status=completed, got ${JSON.stringify(referral)}`);
      },
    },
    {
      // The actual CR-588 fix — the most important assertion in this file.
      name: 'scenario 2 (THE FIX): cancelling the qualifying booking claws back BOTH coupons and RESETS the referral to pending (not void, not stuck completed)',
      run: async () => {
        const { referrer, referred, booking1 } = pairA;
        await cancelBooking(referred.tokens, booking1.bookingId);

        const referral = await poll(
          async () => {
            const r = await getMyReferral(referred.tokens);
            return { done: r.referred_by?.status !== 'completed', value: r.referred_by };
          },
          { desc: 'referral to move off completed after cancellation' }
        );
        assert(
          referral?.status === 'pending',
          `CR-588 regression: expected referral reset to 'pending' after cancelling its qualifying booking, got ${JSON.stringify(referral)} (must NOT be 'void' or still 'completed')`
        );

        const referrerWallet = await poll(
          async () => {
            const w = await getWallet(referrer.tokens);
            return { done: w.length === 0, value: w };
          },
          { desc: 'referrer coupon to be clawed back' }
        );
        const referredWallet = await getWallet(referred.tokens);
        assert(referrerWallet.length === 0, `referrer wallet should be empty after claw-back, got ${JSON.stringify(referrerWallet)}`);
        assert(referredWallet.length === 0, `referred wallet should be empty after claw-back, got ${JSON.stringify(referredWallet)}`);
      },
    },
    {
      name: 'scenario 3 (re-completion): a genuinely new paid booking by the same referred user issues FRESH coupons and completes the reset referral again',
      run: async () => {
        const { referrer, referred, listing } = pairA;
        pairA.booking2 = await bookAndConfirm(referred.tokens, listing, { guestId: referred.id, hostId: listing.host.id });

        const referrerWallet = await poll(
          async () => {
            const w = await getWallet(referrer.tokens);
            return { done: w.length > 0, value: w };
          },
          { desc: 'referrer wallet to receive the SECOND referral coupon' }
        );
        const referredWallet = await getWallet(referred.tokens);
        assert(referrerWallet.length === 1 && referredWallet.length === 1, 'expected exactly 1 fresh coupon per party');
        assert(
          referrerWallet[0].code !== pairA.coupon1Referrer,
          `expected a FRESH coupon code for referrer, got the same code twice: ${referrerWallet[0].code}`
        );
        assert(
          referredWallet[0].code !== pairA.coupon1Referred,
          `expected a FRESH coupon code for referred user, got the same code twice: ${referredWallet[0].code}`
        );

        const referral = (await getMyReferral(referred.tokens)).referred_by;
        assert(referral?.status === 'completed', `expected referral status=completed again, got ${JSON.stringify(referral)}`);
      },
    },

    // ---------------------------------------------------------------
    // Pair B: abuse guard — coupon already spent before the cancellation
    // ---------------------------------------------------------------
    {
      name: 'pair B: register referrer + referred, apply referral code (abuse-guard case)',
      run: async () => {
        pairB.referrer = await registerFreshUser('ReferrerB');
        pairB.referred = await registerFreshUser('ReferredB');
        const code = (await getMyReferral(pairB.referrer.tokens)).code;
        await applyReferralCode(pairB.referred.tokens, code);
        pairB.listing = await pickListing(pairB.referred.tokens, { price: 5 });
        assert(pairB.listing, 'no $5 instant-book listing found on staging to seed a booking with');
      },
    },
    {
      name: 'scenario 4a (abuse-guard setup): qualifying booking issues coupons; referred user then REDEEMS theirs on a second booking',
      run: async () => {
        const { referrer, referred, listing } = pairB;
        pairB.qualifyingBooking = await bookAndConfirm(referred.tokens, listing, { guestId: referred.id, hostId: listing.host.id });

        const referredWallet = await poll(
          async () => {
            const w = await getWallet(referred.tokens);
            return { done: w.length > 0, value: w };
          },
          { desc: 'referred wallet to receive the referral coupon (pair B)' }
        );
        assert(referredWallet.length === 1, `expected 1 coupon, got ${JSON.stringify(referredWallet)}`);
        const couponCode = referredWallet[0].code;

        // Spend it for real: apply it to a second, independent paid booking.
        await bookAndConfirm(referred.tokens, listing, { guestId: referred.id, hostId: listing.host.id, couponCode });

        const referredWalletAfterSpend = await poll(
          async () => {
            const w = await getWallet(referred.tokens);
            return { done: w.length === 0, value: w };
          },
          { desc: 'referred coupon to move to redeemed (leave the active wallet)' }
        );
        assert(referredWalletAfterSpend.length === 0, 'expected the spent coupon to no longer appear in the active wallet');

        // Sanity: referrer's coupon is untouched by the referred user's spend.
        const referrerWallet = await getWallet(referrer.tokens);
        assert(referrerWallet.length === 1, `expected referrer's coupon still active/unspent, got ${JSON.stringify(referrerWallet)}`);
      },
    },
    {
      name: "scenario 4b (THE GUARD): cancelling the qualifying booking AFTER its coupon was spent voids the referral PERMANENTLY (does not reset to pending)",
      run: async () => {
        const { referrer, referred, qualifyingBooking } = pairB;
        await cancelBooking(referred.tokens, qualifyingBooking.bookingId);

        const referral = await poll(
          async () => {
            const r = await getMyReferral(referred.tokens);
            return { done: r.referred_by?.status === 'void', value: r.referred_by };
          },
          { desc: 'referral to go permanently void after spend-then-cancel' }
        );
        assert(
          referral?.status === 'void',
          `abuse guard regression: expected referral to go permanently 'void' (a coupon was already spent), got ${JSON.stringify(referral)}`
        );

        // The referrer's still-active coupon IS still clawed back independently
        // (each party's coupon is voided on its own merits) — only the referral
        // record itself stays terminal instead of resetting.
        const referrerWallet = await poll(
          async () => {
            const w = await getWallet(referrer.tokens);
            return { done: w.length === 0, value: w };
          },
          { desc: "referrer's still-active coupon to be clawed back" }
        );
        assert(referrerWallet.length === 0, `expected referrer wallet clawed back too, got ${JSON.stringify(referrerWallet)}`);
      },
    },
    {
      name: 'scenario 4c: a further paid booking by the same referred user issues NO new coupons to either party (referral stays void)',
      run: async () => {
        const { referrer, referred, listing } = pairB;
        await bookAndConfirm(referred.tokens, listing, { guestId: referred.id, hostId: listing.host.id });
        // No event to poll FOR here (we're proving something does NOT
        // happen) — give the async completion path a fair chance to
        // (wrongly) fire before asserting the negative.
        await new Promise((r) => setTimeout(r, 8000));

        const referrerWallet = await getWallet(referrer.tokens);
        const referredWallet = await getWallet(referred.tokens);
        assert(referrerWallet.length === 0, `expected no new coupon for referrer, got ${JSON.stringify(referrerWallet)}`);
        assert(referredWallet.length === 0, `expected no new coupon for referred user, got ${JSON.stringify(referredWallet)}`);

        const referral = (await getMyReferral(referred.tokens)).referred_by;
        assert(referral?.status === 'void', `expected referral to remain void, got ${JSON.stringify(referral)}`);
      },
    },

    // ---------------------------------------------------------------
    // Pair C: free-stay exclusion regression
    // ---------------------------------------------------------------
    {
      name: 'scenario 5: a $0 booking issues no coupons and never touches referral status (free stays never qualify)',
      run: async () => {
        pairC.referrer = await registerFreshUser('ReferrerC');
        pairC.referred = await registerFreshUser('ReferredC');
        const code = (await getMyReferral(pairC.referrer.tokens)).code;
        await applyReferralCode(pairC.referred.tokens, code);
        pairC.listing = await pickListing(pairC.referred.tokens, { price: 0 });
        assert(pairC.listing, 'no $0 instant-book listing found on staging to seed a free-stay booking with');

        await bookAndConfirm(pairC.referred.tokens, pairC.listing, { guestId: pairC.referred.id, hostId: pairC.listing.host.id });
        await new Promise((r) => setTimeout(r, 8000)); // give the async completion path a fair chance to (wrongly) fire

        const referrerWallet = await getWallet(pairC.referrer.tokens);
        const referredWallet = await getWallet(pairC.referred.tokens);
        assert(referrerWallet.length === 0, `free stay must not issue a referrer coupon, got ${JSON.stringify(referrerWallet)}`);
        assert(referredWallet.length === 0, `free stay must not issue a referred-user coupon, got ${JSON.stringify(referredWallet)}`);

        const referral = (await getMyReferral(pairC.referred.tokens)).referred_by;
        assert(referral?.status === 'pending', `free stay must leave the referral at 'pending', got ${JSON.stringify(referral)}`);
      },
    },
  ],
};
