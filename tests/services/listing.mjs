// listing-service — browse/detail/host endpoints.
//
// Geo-query cases below guard against the missing-composite-index regression
// that 400'd map→grid and filtered search: the coordinate branch of GetListings
// filters by `country` (and optionally `category`) but NOT `city`, so it needs
// `listings` composite indexes keyed on country/geohash (and category/country/
// geohash) that must exist in firestore.indexes.json. These mirror the exact
// query the Flutter map/grid sends (infinite_scroll_provider.dart:
// country + category + guests + latitude/longitude + offset). A 200 on an empty
// result still proves the index exists — coordinates need not match seeded data.
const LAT = '43.90792414274335';
const LNG = '-79.50215343385935';

export default {
  name: 'listing-service',
  cases: [
    { name: 'GET /listings (browse)', path: '/listings?limit=3', expect: 200 },
    // Map "search this area": geo + country, no category (needs the
    // active/deleted/country/status/geohash index).
    {
      name: 'GET /listings (geo + country)',
      path: `/listings?limit=10&country=CA&latitude=${LAT}&longitude=${LNG}`,
      expect: 200,
    },
    // Grid with filters: geo + country + category + guests + offset (needs the
    // active/category.code/deleted/country/status/geohash index; guests is
    // filtered in-memory). This is the exact query that broke the demo.
    {
      name: 'GET /listings (geo + country + category + guests)',
      path: `/listings?limit=10&country=CA&category=couchsurf&guests=2&latitude=${LAT}&longitude=${LNG}&offset=0`,
      expect: 200,
    },
  ],
};
