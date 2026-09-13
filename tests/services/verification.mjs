// verification-service. Like payment-service, it requires the Authorization /
// X-Forwarded-Authorization header; X-Corneroom-Access alone is rejected.
export default {
  name: 'verification-service',
  cases: [
    // `expect: 200` alone is not enough on this service: its routers catch every
    // exception and re-wrap it as 200 + `success:false`, so a broken read looks
    // healthy from the status code. That is exactly how the document_type schema
    // bug went unseen — see services/verification-history-read.mjs.disabled.
    {
      name: 'GET /verifications (authed)',
      path: '/verifications?limit=10&offset=0',
      expect: 200,
      check: (json) =>
        json?.success === true ? null : `200 but success:false — the read failed inside the envelope: ${JSON.stringify(json)}`,
    },
    { name: 'GET /verifications rejects access-only header', path: '/verifications?limit=10&offset=0', auth: 'access-only', expect: 401 },
    // Submission is a KYC write — negative-only here. The positive path (submit
    // -> auto-decide -> land on the user's profile) is services/verification-flow.mjs.
    { name: 'POST /verifications/selfie rejects missing auth', method: 'POST', path: '/verifications/selfie', auth: 'none', body: { selfie_image_url: 'https://example.com/x.jpg' }, expect: 401 },
    { name: 'POST /verifications/selfie rejects access-only header', method: 'POST', path: '/verifications/selfie', auth: 'access-only', body: { selfie_image_url: 'https://example.com/x.jpg' }, expect: 401 },
  ],
};
