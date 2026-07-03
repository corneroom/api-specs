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
    {
      // H1-phone (shipped): phone must not be exposed on a public profile —
      // neither basic_info.phone nor a contacts[] {type:"phone"} entry.
      name: 'GET /users/{me}/profile does not expose phone (H1-phone)',
      path: '/users/{me}/profile',
      expect: 200,
      check: (json) => {
        const d = dataOf(json);
        if (d.basic_info && d.basic_info.phone) return 'basic_info.phone is exposed';
        const phones = (d.contacts || []).filter((c) => c && c.type === 'phone');
        if (phones.length) return 'a phone contact is exposed';
        return null;
      },
    },
  ],
};
