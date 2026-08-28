import { dataOf } from '../lib/assert.mjs';

// payment-service. NOTE: paths are /payments/* (plural) — /payment-methods 404s.
// payment-service requires the Authorization / X-Forwarded-Authorization header;
// X-Corneroom-Access alone is rejected (see the negative cases below).
export default {
  name: 'payment-service',
  cases: [
    // Shape: { payment_methods[], default_method } — NOT a bare array.
    {
      name: 'GET /payments/methods (authed)',
      path: '/payments/methods',
      expect: 200,
      check: (json) =>
        Array.isArray(dataOf(json).payment_methods) ? null : 'expected data.payment_methods[]',
    },
    // Shape: { transactions[], pagination }.
    {
      name: 'GET /payments/history (authed)',
      path: '/payments/history?page=1&limit=5',
      expect: 200,
      check: (json) => {
        const d = dataOf(json);
        if (!Array.isArray(d.transactions)) return 'expected data.transactions[]';
        if (!d.pagination) return 'expected data.pagination';
        return null;
      },
    },
    // Auth-header regression guards (the gotcha that cost us a debugging round):
    { name: 'GET /payments/methods rejects access-only header', path: '/payments/methods', auth: 'access-only', expect: 401 },
    { name: 'GET /payments/methods rejects missing auth', path: '/payments/methods', auth: 'none', expect: 401 },
    // Same auth group as /payments/methods (internal/server.go's JWT-guarded
    // /api/v1 route tree) — same header requirement applies. No positive case:
    // creating an intent/charge is a real write against the payment provider.
    { name: 'POST /payments/intents rejects missing auth', method: 'POST', path: '/payments/intents', auth: 'none', body: { booking_id: 'gw-test-does-not-exist' }, expect: 401 },
    { name: 'POST /payments/charges rejects missing auth', method: 'POST', path: '/payments/charges', auth: 'none', body: { type: 'experience', reference: 'gw-test-does-not-exist' }, expect: 401 },
  ],
};
