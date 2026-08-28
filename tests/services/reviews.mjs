import { dataOf } from '../lib/assert.mjs';

// review-service. GET /reviews requires at least one filter param (author,
// target, type, category, booking_id, or guide) — a bare GET without one 400s
// by design (confirmed against app/routers/review.py list_reviews). Auth is
// enforced upstream of the FastAPI handler (the gateway's JWT check), so an
// unauthenticated request 401s before the filter check ever runs — confirmed
// against the live gateway, not assumed from the backend code alone.
export default {
  name: 'review-service',
  cases: [
    {
      name: 'GET /reviews?target={me} (authed, filtered)',
      path: '/reviews?target={me}',
      expect: 200,
      check: (json) => (Array.isArray(dataOf(json)) || Array.isArray(dataOf(json)?.reviews) ? null : 'expected an array of reviews'),
    },
    {
      name: 'GET /reviews with no filter, authed (400, not an unfiltered dump)',
      path: '/reviews',
      expect: 400,
    },
    { name: 'GET /reviews rejects missing auth', path: '/reviews', auth: 'none', expect: 401 },
  ],
};
