// booking-service — CR-521 regression guard.
//
// CR-521: a guest who signed in via Google/Apple with no name shared could
// still initiate (and complete) a booking, and the confirmation email then
// rendered with a blank guest name. Fixed in booking-service
// internal/service/booking.go (BookingsInitiate path): if the guest's
// Firestore profile has an empty first_name, the service now returns
// ErrGuestProfileIncomplete -> 400 Bad Request.
//
// IMPORTANT — this check reads the AUTHENTICATED guest's stored first_name
// from Firestore; it does NOT trust a first_name in the request body. So it
// can only be exercised end-to-end with a test account whose profile has an
// empty first_name, which the shared tests/.env account does not (it has a
// normal name). We do NOT fake this by asserting on a body field the backend
// ignores — that would test nothing and could mask a real regression.
//
// What actually runs below:
//   1. A real, always-on guard: POST /bookings/initiate requires auth (401
//      with no token) — proves the route exists and is protected.
//   2. A SKIPPED case documenting the CR-521 assertion and its precondition,
//      so the gap is visible in test output rather than silently absent.
// SKIPPED (not run): CR-521's ErrGuestProfileIncomplete check reads the
// authenticated guest's stored first_name from Firestore, so exercising it
// needs a dedicated staging account with an empty first_name — the shared
// tests/.env account (see tests/README.md) has a normal name, so this can't
// be triggered honestly today. To un-skip: provision such an account, point
// a second set of creds at it (e.g. TEST_NAMELESS_EMAIL/PASSWORD), log in
// with it, and assert POST /bookings/initiate with a real listing_id -> 400.
console.log('  ⏭  booking-service: CR-521 nameless-guest case SKIPPED (no nameless test account provisioned)');

export default {
  name: 'booking-service',
  cases: [
    {
      name: 'POST /bookings/initiate (protected — no auth)',
      method: 'POST',
      path: '/bookings/initiate',
      auth: 'none',
      body: { listing_id: 'lst_gw_test_does_not_exist' },
      expect: 401,
    },
  ],
};
