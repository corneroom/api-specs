import { requirePresent, dataOf } from '../lib/assert.mjs';

// H1 shape guard for GET /users/{id}/profile (the app's public-profile endpoint,
// served by user-service GetUserByIdHandler).
//
// The regression guard is `requirePresent`: the app parses this into
// EnhancedProfileDto and RENDERS these fields, so they must survive any PII-trimming
// fix — if a change drops one of them the app's public profile breaks. Run this
// before AND after the H1 change to prove the app contract still holds.
//
// After the H1 fix ships (and mobile makes email nullable), add a `requireAbsent`
// case here for the sensitive fields being removed (e.g. basic_info.email,
// basic_info.phone) to assert the leak is actually gone.
export default {
  name: 'profile (H1 shape guard)',
  cases: [
    {
      name: 'GET /users/{me}/profile keeps app-critical fields',
      path: '/users/{me}/profile',
      expect: 200,
      check: (json) =>
        requirePresent(dataOf(json), [
          'id',
          'basic_info',
          'basic_info.first_name',
          'email_verified',
          'phone_verified',
          'verifications',
        ]),
    },
  ],
};
