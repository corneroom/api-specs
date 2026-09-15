// Staging Firestore access for the dispute-RESOLUTION flow — read-only, plus
// exactly one guarded write.
//
// ── WHY A BLACK-BOX SUITE TOUCHES THE DATABASE AT ALL ──────────────────────
// It normally must not, and nothing else here does. Two of CR-650's acceptance
// criteria are about state the app gateway simply does not expose:
//   - `payouts` — there is no guest- or host-facing endpoint that returns a
//     payout row's `status` / `has_dispute`. The host sees Connect status and a
//     (dead) earnings summary; the payout ledger is dashboard/internal only.
//   - `refund_requests` — the admin refund queue. The guest only ever sees the
//     derived `transactions` row via /payments/history.
// Everything the gateway CAN answer is still asserted through the gateway; the
// Firestore reads below are used only for those two collections, and the
// one write is a clock change, not a money or state change.
//
// ── THE ONE WRITE ──────────────────────────────────────────────────────────
// `fastForwardBookingToCompletion` mirrors test-data/scripts/fast-forward-bookings.js
// exactly — same three fields (check_in, check_out, updated_at), same targeted
// `update()` (never a document overwrite), same "only a Confirmed booking"
// precondition. It exists because the completion sweep selects
// `status == "Confirmed" AND check_out <= now - 24h` (booking-service
// internal/service/booking_completion.go:81) and every fixture this suite books
// is ~a year out, so completion — and therefore the payout row CR-650 is about —
// is otherwise unreachable.
//
// PROJECT GUARD: every entry point here hard-fails unless the project is
// staging. There is no flag, no env override, no "prod if you really mean it".
//
// DEPENDENCY: firebase-admin is NOT a dependency of api-specs, and this suite
// is deliberately dependency-free. Rather than adding a ~100MB module to a spec
// repo for one flow, it is resolved from the sibling test-data repo, which
// already depends on it and is the place Firestore scripting lives. If it is
// not installed there, the flow SKIPS (lib/skip.mjs) — it is a missing
// capability, not a failure.
//
// AUTH: firebase-admin's applicationDefault() IGNORES CLOUDSDK_CONFIG — it
// reads GOOGLE_APPLICATION_CREDENTIALS, then ~/.config/gcloud. The corneroom
// workspace exports GOOGLE_APPLICATION_CREDENTIALS next to CLOUDSDK_CONFIG (see
// projects/GCP_AUTH_ISOLATION.md) precisely so Node scripts resolve the same
// identity gcloud does. If ADC is missing the flow SKIPS.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { skip } from './skip.mjs';

export const STAGING_PROJECT = 'corneroom-82fbb';

const here = dirname(fileURLToPath(import.meta.url));
// tests/lib -> tests -> api-specs -> gateways -> infra -> corneroom
const TEST_DATA_ADMIN = resolve(here, '../../../../../test-data/node_modules/firebase-admin');

let db;
let adminNs;

function loadAdmin() {
  if (!existsSync(TEST_DATA_ADMIN)) {
    skip(
      `firebase-admin not found at ${TEST_DATA_ADMIN} — run \`npm install\` in the test-data repo ` +
        '(this flow reads the payouts/refund_requests collections the gateway does not expose)'
    );
  }
  const require = createRequire(import.meta.url);
  return require(TEST_DATA_ADMIN);
}

// Lazily initialised so a run without ADC skips rather than crashing at import.
export function firestore() {
  if (db) return db;
  const admin = loadAdmin();
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (adcPath && !existsSync(adcPath)) {
    skip(`GOOGLE_APPLICATION_CREDENTIALS points at a missing file (${adcPath}) — run \`gcloud auth application-default login\``);
  }
  if (!adcPath && !existsSync(join(process.env.HOME || '', '.config/gcloud/application_default_credentials.json'))) {
    skip('no Application Default Credentials — run `gcloud auth application-default login` (staging reads only)');
  }
  const app = admin.apps?.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: STAGING_PROJECT });
  const projectId = app.options.projectId;
  if (projectId !== STAGING_PROJECT) {
    throw new Error(`REFUSING TO RUN: Firestore project is "${projectId}", not ${STAGING_PROJECT}. This suite is staging-only.`);
  }
  adminNs = admin;
  db = admin.firestore();
  return db;
}

// The firebase-admin namespace itself, for the few callers that need
// `admin.firestore.Timestamp`. Exported rather than hung off the db handle so
// there is no monkey-patched property to trip over.
export function firestoreAdmin() {
  firestore();
  return adminNs;
}

// An EXPIRED credential is a missing capability, not a product failure.
//
// ADC dies mid-session routinely (Google's reauth window), and firebase-admin
// reports it as `2 UNKNOWN: Getting metadata from plugin failed with error:
// {"error":"invalid_grant","error_description":"reauth related error
// (invalid_rapt)"}` on the FIRST QUERY, not at initialisation — so it cannot be
// caught in `firestore()` above. Left unhandled it surfaces as a ✗ on a money
// case, which reads exactly like a real regression; it bit this suite on
// 2026-09-15. Every Firestore call therefore goes through this wrapper, which
// converts an auth failure into a SKIP naming the fix.
//
// Only credential errors are converted. A genuine Firestore error (missing
// index, permission denied on a specific path) still fails loudly.
const ADC_FAILURE = /invalid_grant|invalid_rapt|reauth|Could not load the default credentials|UNAUTHENTICATED|Getting metadata from plugin failed/i;

async function withAdcSkip(what, fn) {
  try {
    return await fn();
  } catch (e) {
    if (ADC_FAILURE.test(e.message || '')) {
      skip(
        `staging Firestore credentials are not usable (${what}) — run \`gcloud auth application-default login\` ` +
          `(and \`gcloud auth login\`) and re-run. Underlying error: ${String(e.message).slice(0, 160)}`
      );
    }
    throw e;
  }
}

// ─── read-only helpers ──────────────────────────────────────────────────────

export async function getBookingDoc(bookingId) {
  return withAdcSkip(`reading booking ${bookingId}`, async () => {
    const snap = await firestore().collection('bookings').doc(bookingId).get();
    return snap.exists ? { ...snap.data(), id: snap.id } : null;
  });
}

// The Firestore document id always wins over any `id` field inside the
// document: payout rows carry an empty `id` (payment-service sets it after
// creation only on some paths), and a blank id in a failure message is
// useless for investigation.
//
// payouts are one-per-booking (unique by booking_id, payment-service
// internal/data/payout.go:46), but the query shape is kept plural so a
// duplicate would be visible rather than silently hidden behind .limit(1).
export async function getPayoutsByBookingId(bookingId) {
  return withAdcSkip(`reading payouts for booking ${bookingId}`, async () => {
    const snap = await firestore().collection('payouts').where('booking_id', '==', bookingId).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  });
}

export async function getPayoutsByPaymentIntentId(paymentIntentId) {
  return withAdcSkip(`reading payouts for intent ${paymentIntentId}`, async () => {
    const snap = await firestore().collection('payouts').where('payment_intent_id', '==', paymentIntentId).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  });
}

export async function getRefundRequestsByBookingId(bookingId) {
  return withAdcSkip(`reading refund_requests for booking ${bookingId}`, async () => {
    const snap = await firestore().collection('refund_requests').where('booking_id', '==', bookingId).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  });
}

export async function getTransactionsByBookingId(bookingId) {
  return withAdcSkip(`reading transactions for booking ${bookingId}`, async () => {
    const snap = await firestore().collection('transactions').where('booking_id', '==', bookingId).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  });
}

// Resolve a booking from either its Firestore document id or its human-facing
// `CR-XXXXXX` code. A human handing over a booking from the app will normally
// have the CODE (it is what the app and the emails show), while every internal
// reference is the doc id — so accept both rather than making the operator
// translate.
export async function resolveBooking(idOrCode) {
  return withAdcSkip(`resolving booking ${idOrCode}`, () => resolveBookingInner(idOrCode));
}

async function resolveBookingInner(idOrCode) {
  const direct = await getBookingDoc(idOrCode);
  if (direct) return direct;
  const snap = await firestore()
    .collection('bookings')
    .where('booking_code', '==', String(idOrCode).trim().toUpperCase())
    .limit(2)
    .get();
  if (snap.empty) return null;
  if (snap.size > 1) {
    throw new Error(`booking_code ${idOrCode} matches ${snap.size} bookings — pass the document id instead`);
  }
  const d = snap.docs[0];
  return { ...d.data(), id: d.id };
}

// The host's payout method as booking-service reads it when it publishes
// booking_completed (`readHostPayoutInfo`, booking-service
// internal/service/booking.go:463). Empty / "not_specified" means
// payment-service takes the unconfigured-host branch and records a payout
// BLOCKED for `host_payout_method_not_configured`.
export async function getUserPayoutMethod(userId) {
  return withAdcSkip(`reading payout_method of user ${userId}`, async () => {
    const snap = await firestore().collection('users').doc(userId).get();
    if (!snap.exists) return '';
    return snap.data().payout_method || '';
  });
}

// Bot hosts that have a payout method configured — the fixture that makes
// "the payout is blocked BY THE DISPUTE" and "a won dispute releases it"
// provable at all. Without one, every payout the suite can create is blocked
// for `host_payout_method_not_configured` and both claims are vacuous.
// Seed one with test-data's `make seed-bot-host-payout-method apply=1`.
export async function findBotHostsWithPayoutMethod() {
  return withAdcSkip('listing bot hosts with a payout method', async () => {
    const out = [];
    for (const method of ['paypal', 'stripe', 'manual']) {
      const snap = await firestore().collection('users').where('payout_method', '==', method).get();
      for (const d of snap.docs) {
        const u = d.data();
        // Bot only: the suite must never book a real host (they are notified
        // for every booking, payment and cancellation).
        if (u.bot !== true) continue;
        out.push({ id: d.id, email: u.email, payoutMethod: method, payoutEmail: u.payout_email || '' });
      }
    }
    return out;
  });
}

// ─── the one write ──────────────────────────────────────────────────────────

// Shift a Confirmed booking's stay into the past so the auto-complete sweep
// picks it up. Mirrors test-data/scripts/fast-forward-bookings.js field for
// field. Returns { checkIn, checkOut } as written, or throws.
export async function fastForwardBookingToCompletion(bookingId, opts = {}) {
  return withAdcSkip(`fast-forwarding booking ${bookingId}`, () => fastForwardInner(bookingId, opts));
}

async function fastForwardInner(bookingId, { hoursPast = 48 } = {}) {
  const dbi = firestore();
  const admin = firestoreAdmin();
  const ref = dbi.collection('bookings').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`booking ${bookingId} not found in ${STAGING_PROJECT}`);
  const b = snap.data();
  if (b.status !== 'Confirmed') {
    throw new Error(
      `booking ${bookingId} is "${b.status}", not "Confirmed" — the completion sweep only selects Confirmed ` +
        '(booking-service internal/service/booking_completion.go:81), so fast-forwarding it would do nothing'
    );
  }
  const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null);
  const checkIn = toDate(b.check_in);
  const checkOut = toDate(b.check_out);
  if (!checkIn || !checkOut) throw new Error(`booking ${bookingId} has no Timestamp check_in/check_out`);

  const newCheckOut = new Date(Date.now() - hoursPast * 3600 * 1000);
  const newCheckIn = new Date(newCheckOut.getTime() - (checkOut.getTime() - checkIn.getTime()));

  // Targeted field update only — never a full-document overwrite, and written
  // as Firestore Timestamps because booking-service maps these to time.Time
  // (a string makes the service skip the document silently).
  await ref.update({
    check_in: admin.firestore.Timestamp.fromDate(newCheckIn),
    check_out: admin.firestore.Timestamp.fromDate(newCheckOut),
    updated_at: admin.firestore.Timestamp.now(),
  });
  return { checkIn: newCheckIn, checkOut: newCheckOut };
}
