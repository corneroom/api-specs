// Cross-cutting security guards on the app gateway (not tied to one service).
export default {
  name: 'security guards',
  cases: [
    // C1 regression: the internal KYC-status write must NOT be exposed on the
    // app gateway. It was an unauthenticated, internet-reachable verification
    // bypass; it must stay 404 here (internal callers use the Cloud Run URL + OIDC).
    {
      name: 'PATCH /internal/.../verifications is NOT exposed (C1)',
      method: 'PATCH',
      path: '/internal/users/testuser/verifications/facematch',
      body: { status: 'approved' },
      auth: 'none',
      expect: 404,
    },
  ],
};
