// payment-service — Stripe Connect payout onboarding. No positive read case:
// /payouts/connect/onboarding is a WRITE (creates a real Stripe Connect Express
// account) and /payouts/connect/status's 200 body depends on the test account
// already having a connected account, which the shared tests/.env account does
// not. Auth guards only for now — real coverage needs a dedicated payout-linked
// staging host account (same gap class as booking.mjs's CR-521 case).
export default {
  name: 'payment-service (payouts)',
  cases: [
    { name: 'GET /payouts/connect/status rejects missing auth', path: '/payouts/connect/status', auth: 'none', expect: 401 },
    { name: 'GET /payouts/connect/status rejects access-only header', path: '/payouts/connect/status', auth: 'access-only', expect: 401 },
    { name: 'POST /payouts/connect/onboarding rejects missing auth', method: 'POST', path: '/payouts/connect/onboarding', auth: 'none', expect: 401 },
    // The Express dashboard login link. Negative-only here for the same reason
    // as the rest of this file; its behaviour for a host with no Connect
    // account is asserted in services/payouts-flow.mjs.
    { name: 'POST /payouts/connect/dashboard-link rejects missing auth', method: 'POST', path: '/payouts/connect/dashboard-link', auth: 'none', expect: 401 },
    { name: 'POST /payouts/connect/dashboard-link rejects access-only header', method: 'POST', path: '/payouts/connect/dashboard-link', auth: 'access-only', expect: 401 },
  ],
};
