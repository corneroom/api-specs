// listing-service — browse/detail/host endpoints.
export default {
  name: 'listing-service',
  cases: [
    { name: 'GET /listings (browse)', path: '/listings?limit=3', expect: 200 },
  ],
};
