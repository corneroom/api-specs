import { dataOf, requirePresent } from '../lib/assert.mjs';

// user-service — add authenticated + public user endpoints here.
export default {
  name: 'user-service',
  cases: [
    { name: 'GET /users/heartbeat (public)', path: '/users/heartbeat', auth: 'none', expect: 200 },
    {
      name: 'GET /users/me (authed)',
      path: '/users/me',
      expect: 200,
      check: (json) =>
        requirePresent(dataOf(json), [
          'id',
          'basic_info',
          'email_verified',
          'phone_verified',
          'verifications',
        ]),
    },
    { name: 'POST /users/refresh (rotate token)', method: 'POST', path: '/users/refresh', expect: 200 },

    // CR-681 regression guard: the spec used to nest changeCurrentUserPassword
    // under /users/me/avatar's POST instead of its own path, so the gateway
    // never routed /users/me/password/change at all (404, not 401/400) and
    // every change-password attempt failed before reaching user-service.
    {
      name: 'POST /users/me/password/change unauth -> 401 (routing guard)',
      method: 'POST',
      path: '/users/me/password/change',
      body: { old_password: 'x', password: 'x', verify_password: 'x' },
      auth: 'none',
      expect: 401,
    },
    {
      name: 'POST /users/me/password/change wrong old_password -> 401 with specific reason (authed, does not touch the real password)',
      method: 'POST',
      path: '/users/me/password/change',
      body: {
        old_password: 'definitely-wrong-old-password',
        password: 'NewValidPass123!',
        verify_password: 'NewValidPass123!',
      },
      expect: 401,
      check: (json) =>
        json.error === 'incorrect old password'
          ? null
          : `expected error 'incorrect old password', got: ${JSON.stringify(json)}`,
    },
  ],
};
