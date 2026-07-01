// payment-service. NOTE: paths are /payments/* (plural) — /payment-methods 404s.
// payment-service requires the Authorization / X-Forwarded-Authorization header;
// X-Corneroom-Access alone is rejected (see the negative cases below).
export default {
  name: 'payment-service',
  cases: [
    { name: 'GET /payments/methods (authed)', path: '/payments/methods', expect: 200 },
    { name: 'GET /payments/history (authed)', path: '/payments/history?page=1&limit=5', expect: 200 },
    // Auth-header regression guards (the gotcha that cost us a debugging round):
    { name: 'GET /payments/methods rejects access-only header', path: '/payments/methods', auth: 'access-only', expect: 401 },
    { name: 'GET /payments/methods rejects missing auth', path: '/payments/methods', auth: 'none', expect: 401 },
  ],
};
