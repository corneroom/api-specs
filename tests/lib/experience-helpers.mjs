// Experience (guide-led) fixtures + reservation mechanics, shared by
// tests/services/experience-reservations-flow.mjs. Mirrors the split in
// lib/booking-flow.mjs (fixture selection + the write steps), for the other
// product: three services own one reservation.
//
//   listing-service   the experience + guide catalogue — GET /experiences
//   booking-service   sessions, reserve, cancel — POST /experiences/{id}/sessions/{sid}/reserve,
//                     POST /experience-reservations/{id}/cancel
//   payment-service   the money — POST /payments/charges (NOT /payments/intents:
//                     a charge carries {type, reference} and no booking fields,
//                     so booking-service's booking consumer never sees it)
//
// STAGING ONLY, and bot-guide fixtures only — see pickBotGuidedExperience.
import { config } from './env.mjs';
import { authHeaders } from './auth.mjs';

async function gw(tokens, path, init = {}) {
  const res = await fetch(`${config.gwUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(tokens, 'full'),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

// ─── Fixture selection: BOT GUIDES ONLY ─────────────────────────────────────
//
// The same rule as lib/booking-flow.mjs's listing pickers, for the same reason:
// reserving and cancelling notifies the guide for real (messaging-service
// reacts to the experience events booking-service publishes). Staging's
// experience catalogue contains REAL people — `Park Tour` is guided by Zoey
// (zoeylin333@gmail.com) and several `exp_sample_*` are guided by the owner's
// own account (prince@inspiredtech.ca, "Tiger"). Neither may ever be reserved
// by CI.
//
// HOW "is this guide a bot?" IS DERIVED — this is the fiddly part, and it is
// NOT the same trick the listing pool uses:
//   - listing-service DOES store the flag (data.Experience.GuideIsBot, which
//     booking-service's reservation gate reads), but it is tagged `json:"-"`
//     (listing-service internal/data/experience.go:48) — it is never
//     serialized, on any endpoint, so the gateway cannot see it at all.
//   - What IS reachable is the guide's user profile: GET /users/{id}/profile
//     returns `basic_info.email`, and every seeded bot is `<name>@bot.com`
//     (test-data/scripts/generate-user-listing.js; the same convention
//     tests/.env itself documents).
// That proxy was cross-checked against the authoritative flag on the one
// surface that does expose it: for all 13 bot-hosted USD instant-book listings
// on staging, `GET /listings/{id}`'s `host.is_bot` and "host email ends in
// @bot.com" agreed 13/13 (2026-09-13). Re-derived every run — do not hardcode
// guide or experience ids, staging gets reseeded.
const BOT_EMAIL_SUFFIX = '@bot.com';

let botGuideCache; // userId -> boolean
async function guideIsBot(tokens, userId) {
  if (!botGuideCache) botGuideCache = new Map();
  if (botGuideCache.has(userId)) return botGuideCache.get(userId);
  const { status, json } = await gw(tokens, `/users/${userId}/profile`);
  // Unknown = NOT a bot. An unreadable profile must never be treated as safe
  // to reserve; the whole point is that a real person's phone buzzes.
  const email = status === 200 ? json?.data?.basic_info?.email ?? '' : '';
  const isBot = typeof email === 'string' && email.toLowerCase().endsWith(BOT_EMAIL_SUFFIX);
  botGuideCache.set(userId, isBot);
  return isBot;
}

export async function listExperiences(tokens, limit = 50) {
  const { status, json, text } = await gw(tokens, `/experiences?limit=${limit}`);
  if (status !== 200) throw new Error(`GET /experiences failed ${status}: ${text}`);
  return json?.data?.experiences ?? [];
}

export async function listSessions(tokens, experienceId) {
  const { status, json, text } = await gw(tokens, `/experiences/${experienceId}/sessions`);
  if (status !== 200) throw new Error(`GET /experiences/${experienceId}/sessions failed ${status}: ${text}`);
  return json?.data?.sessions ?? [];
}

// Picks a PAID, bot-guided experience with a bookable session at least
// `minHoursOut` away, plus that session.
//
// `minHoursOut` is a money constraint, not a convenience: the refund a
// cancellation earns is decided by hours-until-session
// (booking-service internal/service/experience_reservation.go:704
// `suggestedExperienceRefund`), so a fixture too close to its session silently
// changes which branch the test is asserting. `policy` pins the tier outright.
//
// Throws with the constraint that failed rather than returning null — staging
// not having a bookable bot-guided experience is an environment fact worth
// reading in the failure message, not a null dereference three lines later.
export async function pickBotGuidedExperience(tokens, { policy = 'flexible', minHoursOut = 25 } = {}) {
  const all = await listExperiences(tokens);
  const paid = all.filter(
    (e) => e.pricing_mode === 'paid' && typeof e.price === 'number' && e.price > 0 && e.status === 'published' && e.available
  );
  const wrongPolicy = [];
  const realGuides = [];
  for (const exp of paid) {
    if (policy && exp.cancellation_policy !== policy) {
      wrongPolicy.push(exp.id);
      continue;
    }
    if (!(await guideIsBot(tokens, exp.user_id))) {
      realGuides.push(exp.id);
      continue;
    }
    const cutoff = Date.now() + minHoursOut * 3600000;
    const session = (await listSessions(tokens, exp.id))
      .filter(
        (s) =>
          (s.status === '' || s.status === 'scheduled' || s.status == null) &&
          new Date(s.start_time).getTime() > cutoff &&
          (s.booked_count ?? 0) < (s.capacity ?? 0)
      )
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
    if (!session) continue;
    console.log(
      `    · experience fixture ${exp.id} "${exp.title}" — ${exp.price} ${exp.currency}, ${exp.cancellation_policy}, ` +
        `bot guide ${exp.user_id}, session ${session.id} @ ${session.start_time} (${session.booked_count}/${session.capacity})`
    );
    return { experience: exp, session };
  }
  throw new Error(
    `no bot-guided PAID experience with cancellation_policy=${policy} and a scheduled session > ${minHoursOut}h out ` +
      `(checked ${paid.length} paid experiences; ${wrongPolicy.length} had another policy, ${realGuides.length} are guided ` +
      `by REAL people and must never be reserved by this suite). Seed a bot-guided experience on staging.`
  );
}

// ─── Reservation mechanics ──────────────────────────────────────────────────

// POST /experiences/{id}/sessions/{sessionId}/reserve — holds a seat.
// Paid reservations come back `status=reserved, payment_status=pending,
// requires_payment=true` and the hold EXPIRES if it isn't paid
// (experience_reservation.go:372 `experienceHoldWindow`), so pay promptly.
// Returned raw so a case can assert on a refusal (e.g. the bot-guide gate's
// 409) without this throwing first.
export async function reserveSessionRaw(tokens, experienceId, sessionId, participants = 1) {
  const { status, json, text } = await gw(tokens, `/experiences/${experienceId}/sessions/${sessionId}/reserve`, {
    method: 'POST',
    body: JSON.stringify({ participants }),
  });
  return { status, data: json?.data, text };
}

export async function reserveSession(tokens, experienceId, sessionId, participants = 1) {
  const { status, data, text } = await reserveSessionRaw(tokens, experienceId, sessionId, participants);
  if (status !== 201) throw new Error(`POST reserve failed ${status}: ${text}`);
  return data;
}

// The charge reference the mobile app builds, verbatim
// (app/mobile lib/features/experiences/presentation/pages/experiences_reserve_page.dart
// `_buildRequestFor`). booking-service parses the reservation id back out of it
// (experience_reservation.go:1042 `reservationIDFromReference`) and
// payment-service keys the ledger row's booking_id on the same thing
// (payment.go:3838), so the shape is load-bearing on both sides.
export const chargeReference = (experienceId, reservationId) =>
  `experience:${experienceId}/reservation:${reservationId}`;

// POST /payments/charges — the standalone charge surface. Unlike a booking
// intent this is IMMEDIATE capture (payment-service internal/service/
// stripe_service.go:256), so confirming it succeeds outright; there is no
// requires_capture stage and no host acceptance.
export async function createExperienceCharge(tokens, { reference, amount, currency, description }) {
  const { status, json, text } = await gw(tokens, '/payments/charges', {
    method: 'POST',
    body: JSON.stringify({ reference, type: 'experience', amount, currency, description }),
  });
  if (status !== 201) throw new Error(`POST /payments/charges failed ${status}: ${text}`);
  return json.data;
}

export async function getMyReservations(tokens) {
  const { status, json, text } = await gw(tokens, '/experience-reservations/mine');
  if (status !== 200) throw new Error(`GET /experience-reservations/mine failed ${status}: ${text}`);
  return json?.data?.reservations ?? [];
}

export async function getMyReservation(tokens, reservationId) {
  return (await getMyReservations(tokens)).find((r) => r.id === reservationId) ?? null;
}

// POST /experience-reservations/{id}/cancel. Returns the raw status so the
// idempotency case can assert that a REPEAT cancel is still a 200 no-op
// (experience_reservation.go:556 returns nil for an already-terminal
// reservation) rather than a 409.
export async function cancelReservationRaw(tokens, reservationId) {
  const { status, json, text } = await gw(tokens, `/experience-reservations/${reservationId}/cancel`, { method: 'POST' });
  return { status, data: json?.data, text };
}

export async function cancelReservation(tokens, reservationId) {
  const { status, text } = await cancelReservationRaw(tokens, reservationId);
  if (status !== 200) throw new Error(`POST /experience-reservations/${reservationId}/cancel failed ${status}: ${text}`);
}

// Leak-safe teardown: cancel unless already terminal. Safe on any state and on
// a reservation that never existed.
export async function teardownReservation(tokens, reservationId) {
  if (!reservationId) return;
  const r = await getMyReservation(tokens, reservationId);
  if (!r || r.status === 'cancelled') return;
  await cancelReservationRaw(tokens, reservationId);
}
