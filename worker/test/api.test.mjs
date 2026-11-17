// End-to-end API test against a local `wrangler dev` (port 8787) using the fake
// BOT_TOKEN from .dev.vars. Run: node test/api.test.mjs
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.API || 'http://localhost:8787';
const TOKEN = '123456:TEST_LOCAL_ONLY';

export function makeInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({auth_date: String(authDate), query_id: 'q' + user.id, user: JSON.stringify(user)});
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

const athlete = {id: 1001, first_name: 'Константин'};
const coach = {id: 2002, first_name: 'Тренер'};
const stranger = {id: 3003, first_name: 'Чужой'};

async function call(user, method, path, body, raw) {
  const r = await fetch(BASE + path, {
    method,
    headers: {'Content-Type': 'application/json', ...(user ? {'X-Init-Data': raw || makeInitData(user)} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  return {status: r.status, body: await r.json().catch(() => null)};
}

let r;
// auth
r = await call(null, 'GET', '/api/me'); assert.equal(r.status, 401, 'no initData');
r = await call(athlete, 'GET', '/api/me', null, makeInitData(athlete).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64))); assert.equal(r.status, 401, 'bad hash');
r = await call(athlete, 'GET', '/api/me', null, makeInitData(athlete, 1000)); assert.equal(r.status, 401, 'expired');
r = await call(athlete, 'GET', '/api/me'); assert.equal(r.status, 200); assert.equal(r.body.me.id, athlete.id);

// own state, versioning
r = await call(athlete, 'GET', '/api/state'); assert.equal(r.body.version, 0);
r = await call(athlete, 'PUT', '/api/state', {baseVersion: 0, data: {hello: 1}}); assert.equal(r.status, 200); assert.equal(r.body.version, 1);
r = await call(athlete, 'PUT', '/api/state', {baseVersion: 0, data: {hello: 2}}); assert.equal(r.status, 409, 'second create conflicts');
assert.equal(r.body.data.hello, 1);
r = await call(athlete, 'PUT', '/api/state', {baseVersion: 1, data: {hello: 3}}); assert.equal(r.body.version, 2);
r = await call(athlete, 'PUT', '/api/state', {baseVersion: 1, data: {hello: 4}}); assert.equal(r.status, 409, 'stale write conflicts');
r = await call(athlete, 'GET', '/api/state?since=2'); assert.equal(r.body.unchanged, true);
r = await call(athlete, 'GET', '/api/state?since=1'); assert.equal(r.body.data.hello, 3);

// coach cannot read before invite
r = await call(coach, 'GET', `/api/state?uid=${athlete.id}`); assert.equal(r.status, 403);

// invite + accept
r = await call(athlete, 'POST', '/api/invite'); assert.equal(r.status, 200); const code = r.body.code; assert.ok(code);
r = await call(athlete, 'POST', '/api/accept', {code}); assert.equal(r.status, 400, 'own invite');
r = await call(coach, 'POST', '/api/accept', {code: 'nope'}); assert.equal(r.status, 404);
r = await call(coach, 'POST', '/api/accept', {code}); assert.equal(r.status, 200); assert.equal(r.body.client.id, athlete.id);
r = await call(stranger, 'POST', '/api/accept', {code}); assert.equal(r.status, 404, 'invite single-use');

// coach reads and writes athlete state
r = await call(coach, 'GET', '/api/me'); assert.equal(r.body.clients.length, 1); assert.equal(r.body.clients[0].first_name, 'Константин');
r = await call(athlete, 'GET', '/api/me'); assert.equal(r.body.coaches[0].id, coach.id);
r = await call(coach, 'GET', `/api/state?uid=${athlete.id}`); assert.equal(r.body.data.hello, 3);
r = await call(coach, 'PUT', `/api/state?uid=${athlete.id}`, {baseVersion: 2, data: {hello: 'coach'}, notify: {summary: 'test', whoop: 'w'}}); assert.equal(r.status, 200);
r = await call(athlete, 'GET', '/api/state'); assert.equal(r.body.data.hello, 'coach'); assert.equal(r.body.version, 3);

// stranger blocked
r = await call(stranger, 'GET', `/api/state?uid=${athlete.id}`); assert.equal(r.status, 403);
r = await call(stranger, 'PUT', `/api/state?uid=${athlete.id}`, {baseVersion: 3, data: {x: 1}}); assert.equal(r.status, 403);

// athlete removes coach
r = await call(athlete, 'DELETE', `/api/link?coach=${coach.id}`); assert.equal(r.status, 200);
r = await call(coach, 'GET', `/api/state?uid=${athlete.id}`); assert.equal(r.status, 403, 'access revoked');

// bot webhook rejects missing secret
const wr = await fetch(BASE + '/bot', {method: 'POST', body: '{}'}); assert.equal(wr.status, 403);

// CORS
const pre = await fetch(BASE + '/api/me', {method: 'OPTIONS', headers: {Origin: 'http://localhost:8765'}});
assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:8765');
const bad = await fetch(BASE + '/api/me', {method: 'OPTIONS', headers: {Origin: 'https://evil.example'}});
assert.equal(bad.headers.get('access-control-allow-origin'), null);

console.log('ALL API TESTS PASSED');
