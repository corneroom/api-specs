// user-service — the push-token registry: register a device, read it back,
// update it, remove it.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// `/users/me/devices` is where the mobile app parks its FCM token. Every push
// the platform sends — booking accepted, message received, payout paid —
// is delivered to whatever is in this list, so a routing or auth regression
// here is silent: nothing errors, notifications simply stop arriving. It had
// no coverage at all.
//
// ── WHY A THROWAWAY ACCOUNT, NOT THE SHARED ONE ────────────────────────────
//
// This flow writes a FAKE FCM token. Parking one on the shared `TEST_EMAIL`
// account would mean messaging-service attempting (and failing) a push to a
// dead token on every event that account is party to — for as long as the
// token survived a failed cleanup. A freshly registered `qa+<digits>@bot.com`
// contains that blast radius completely: the token only ever exists on an
// account nothing else uses.
//
// ── NOTED, NOT ASSERTED ────────────────────────────────────────────────────
//
// * `GET /users/me/devices` returns Go-PascalCase keys (`DeviceID`,
//   `FCMToken`, `AppVersion`…), not the lower_snake_case the spec documents
//   (user-service docs/api.yaml `/users/me/devices`). Same divergence as
//   `/listings/user`. Asserted as it really is.
// * `PATCH /users/me/devices` REWRITES `CreatedAt` to now — verified on
//   staging, where a device created at :04.855 reported `CreatedAt` :05.451
//   after an update that only changed `app_version` and `language`. So "when
//   did this device first appear" is lost on every token refresh. Reported,
//   not asserted: pinning today's behaviour would cement the bug, and
//   asserting the correct behaviour would leave the suite permanently red.
// * `DELETE /users/me/devices/{id}` is idempotent — a repeat delete answers
//   204, not 404. That IS asserted: a client retrying an unregister must not
//   be handed an error.
import { authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { registerFreshUser } from '../lib/booking-flow.mjs';

const ctx = { user: null, deviceId: null };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function gw(tokens, path, { method = 'GET', body } = {}) {
  const headers = { ...authHeaders(tokens, 'full') };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${config.gwUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, data: json?.data, text };
}

async function listDevices() {
  const res = await gw(ctx.user.tokens, '/users/me/devices');
  assert(res.status === 200, `GET /users/me/devices expected 200, got ${res.status}: ${res.text}`);
  return res.data ?? []; // an empty registry comes back as null
}

const findDevice = (devices) => (devices ?? []).find((d) => d.DeviceID === ctx.deviceId);

export default {
  name: 'user-service (push-token registry: register → read → update → unregister)',
  cases: [
    {
      name: 'POST /users/me/devices — a fresh account starts with no devices, then registers one',
      run: async () => {
        ctx.user = await registerFreshUser('DeviceQA');
        ctx.deviceId = `gateway-suite-${Date.now()}`;

        const before = await listDevices();
        assert(before.length === 0, `a brand new account must have no registered devices, got ${JSON.stringify(before)}`);

        const res = await gw(ctx.user.tokens, '/users/me/devices', {
          method: 'POST',
          body: {
            device_id: ctx.deviceId,
            fcm_token: 'gateway-suite-not-a-real-fcm-token',
            platform: 'ios',
            model: 'GatewaySuite',
            app_version: '0.0.0',
            language: 'en',
            timezone: 'UTC',
          },
        });
        assert(res.status === 200, `POST /users/me/devices expected 200, got ${res.status}: ${res.text}`);
        assert(res.json?.success === true, `device registration did not report success: ${res.text}`);
        console.log(`    · registered device ${ctx.deviceId} on ${ctx.user.email}`);
      },
    },

    {
      name: 'GET /users/me/devices — the registered device reads back with the token that was sent',
      run: async () => {
        assert(ctx.deviceId, 'no device was registered');
        const devices = await listDevices();
        const mine = findDevice(devices);
        assert(mine, `the registered device is missing from the list: ${JSON.stringify(devices)}`);
        assert(mine.FCMToken === 'gateway-suite-not-a-real-fcm-token', `the FCM token did not round-trip: ${mine.FCMToken}`);
        assert(mine.Platform === 'ios', `platform did not round-trip: ${mine.Platform}`);
        assert(mine.AppVersion === '0.0.0', `app_version did not round-trip: ${mine.AppVersion}`);
        assert(mine.LastSeen, 'a device must carry LastSeen — stale-token cleanup keys off it');
      },
    },

    {
      name: 'PATCH /users/me/devices — an app upgrade updates the device in place, it does not add a second one',
      run: async () => {
        assert(ctx.deviceId, 'no device was registered');
        const res = await gw(ctx.user.tokens, '/users/me/devices', {
          method: 'PATCH',
          body: { device_id: ctx.deviceId, app_version: '0.0.1', language: 'fr' },
        });
        assert(res.status === 200, `PATCH /users/me/devices expected 200, got ${res.status}: ${res.text}`);
        assert(res.data?.AppVersion === '0.0.1', `the update was not applied: ${res.text}`);

        const devices = await listDevices();
        assert(devices.length === 1, `an update must not create a second device row, got ${devices.length}`);
        const mine = findDevice(devices);
        assert(mine, 'the device vanished after an update');
        assert(mine.AppVersion === '0.0.1' && mine.Language === 'fr', `the update did not persist: ${JSON.stringify(mine)}`);
        // The token is what the push actually needs — an update that only
        // touches metadata must never drop it.
        assert(mine.FCMToken === 'gateway-suite-not-a-real-fcm-token', `the FCM token was lost on update: ${mine.FCMToken}`);
      },
    },

    {
      name: 'DELETE /users/me/devices/{id} — unregistering removes it, and a repeat unregister is a no-op',
      run: async () => {
        assert(ctx.deviceId, 'no device was registered');
        const del = await gw(ctx.user.tokens, `/users/me/devices/${ctx.deviceId}`, { method: 'DELETE' });
        assert(del.status === 204, `DELETE /users/me/devices/{id} expected 204, got ${del.status}: ${del.text}`);

        const devices = await listDevices();
        assert(!findDevice(devices), `the device is still registered after a delete: ${JSON.stringify(devices)}`);

        // A client that retries an unregister (e.g. logout on a flaky network)
        // must not be handed an error.
        const again = await gw(ctx.user.tokens, `/users/me/devices/${ctx.deviceId}`, { method: 'DELETE' });
        assert(again.status === 204, `a repeat unregister expected 204, got ${again.status}: ${again.text}`);

        ctx.deviceId = null;
      },
    },

    {
      name: 'the device registry rejects anonymous callers on every verb',
      run: async () => {
        const paths = [
          ['GET', '/users/me/devices'],
          ['POST', '/users/me/devices'],
          ['PATCH', '/users/me/devices'],
          ['DELETE', '/users/me/devices/gateway-suite-nobody'],
        ];
        for (const [method, path] of paths) {
          const res = await fetch(`${config.gwUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' || method === 'PATCH' ? '{}' : undefined,
          });
          assert(res.status === 401, `anonymous ${method} ${path} must be 401, got ${res.status}`);
        }
      },
    },

    {
      name: 'cleanup — no fake push token left registered anywhere',
      run: async () => {
        if (!ctx.user) return;
        if (ctx.deviceId) {
          await gw(ctx.user.tokens, `/users/me/devices/${ctx.deviceId}`, { method: 'DELETE' });
          ctx.deviceId = null;
        }
        const devices = await listDevices();
        assert(
          devices.length === 0,
          `cleanup failed: ${ctx.user.email} still has registered device(s): ${JSON.stringify(devices)}`
        );
      },
    },
  ],
};
