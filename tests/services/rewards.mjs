// reward-service — referral rewards ($5-both, first-paid, platform-funded).
// No shape assertions beyond auth/routing: the exact wallet/referral response
// fields weren't confirmed against the current reward-service code for this
// pass, so a wrong assumption here would be a flaky test pretending to be
// coverage. Tighten with `check:` once the shape is verified from the service.
export default {
  name: 'reward-service',
  cases: [
    { name: 'GET /rewards/me/wallet (authed)', path: '/rewards/me/wallet', expect: 200 },
    { name: 'GET /rewards/me/wallet rejects missing auth', path: '/rewards/me/wallet', auth: 'none', expect: 401 },
    { name: 'GET /rewards/me/referral (authed)', path: '/rewards/me/referral', expect: 200 },
    { name: 'GET /rewards/me/referrals (authed)', path: '/rewards/me/referrals', expect: 200 },
    // Applying a referral code is a write with real coupon side effects — no
    // real code exercised here. Only the auth guard.
    { name: 'POST /rewards/referral/apply rejects missing auth', method: 'POST', path: '/rewards/referral/apply', auth: 'none', body: { code: 'GW-TEST-DOES-NOT-EXIST' }, expect: 401 },
    // CR-654: the pre-signup invite-code check is PUBLIC (the account does not
    // exist yet). Guards the spec's `security: []` on this one route — a regen
    // that drops it would 401 and break invite-code sign-up.
    { name: 'GET /rewards/referral/codes/{code} unknown code is 404 without auth', path: '/rewards/referral/codes/GWTE-0000', auth: 'none', expect: 404 },
  ],
};
