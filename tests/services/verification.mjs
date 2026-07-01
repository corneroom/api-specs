// verification-service. Like payment-service, it requires the Authorization /
// X-Forwarded-Authorization header; X-Corneroom-Access alone is rejected.
export default {
  name: 'verification-service',
  cases: [
    { name: 'GET /verifications (authed)', path: '/verifications?limit=10&offset=0', expect: 200 },
    { name: 'GET /verifications rejects access-only header', path: '/verifications?limit=10&offset=0', auth: 'access-only', expect: 401 },
  ],
};
