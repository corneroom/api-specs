// user-service — add authenticated + public user endpoints here.
export default {
  name: 'user-service',
  cases: [
    { name: 'GET /users/heartbeat (public)', path: '/users/heartbeat', auth: 'none', expect: 200 },
    { name: 'GET /users/me (authed)', path: '/users/me', expect: 200 },
    { name: 'POST /users/refresh (rotate token)', method: 'POST', path: '/users/refresh', expect: 200 },
  ],
};
