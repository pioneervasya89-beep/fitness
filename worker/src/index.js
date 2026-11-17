// Fitness sync server: stores each athlete's app state, lets linked coaches
// read and write it, and talks to the Telegram bot (invites, notifications).
// Auth: every API call carries Telegram Mini App initData, verified with BOT_TOKEN.

const MAX_STATE_BYTES = 900_000;
const INIT_DATA_MAX_AGE = 7 * 24 * 3600; // seconds
const INVITE_TTL = 7 * 24 * 3600 * 1000; // ms

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hex = buf => [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))); }

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyInitData(initData, botToken, now = Math.floor(Date.now() / 1000)) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const calc = hex(await hmac(secret, dcs));
  if (!safeEqual(calc, hash)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || now - authDate > INIT_DATA_MAX_AGE) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch {
    return null;
  }
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {status: status || 200, headers: {'Content-Type': 'application/json; charset=utf-8', ...cors}});
}

const escHtml = s => String(s).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
const displayName = u => (u ? u.first_name || (u.username ? '@' + u.username : 'Без имени') : 'Без имени');

async function tgCall(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ok: false}));
}

let botUsername = null;
async function getBotUsername(env) {
  if (botUsername) return botUsername;
  const r = await tgCall(env, 'getMe', {});
  if (r.ok) botUsername = r.result.username;
  return botUsername;
}

async function upsertUser(env, u) {
  await env.DB.prepare(
    `INSERT INTO users (id, first_name, username, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET first_name = ?2, username = ?3, updated_at = ?4`
  ).bind(u.id, u.first_name || null, u.username || null, Date.now()).run();
}

async function isCoachOf(env, coachId, clientId) {
  const r = await env.DB.prepare('SELECT 1 FROM links WHERE coach_id = ?1 AND client_id = ?2').bind(coachId, clientId).first();
  return !!r;
}

async function canAccess(env, me, uid) {
  return uid === me.id || (await isCoachOf(env, me.id, uid));
}

function randomCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

async function notify(env, ownerId, actor, payload) {
  if (!payload || typeof payload !== 'object') return;
  const owner = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(ownerId).first();
  const coaches = (await env.DB.prepare('SELECT u.* FROM links l JOIN users u ON u.id = l.coach_id WHERE l.client_id = ?1').bind(ownerId).all()).results || [];
  const summary = String(payload.summary || '').slice(0, 3000);
  const whoop = String(payload.whoop || '').slice(0, 3500);
  const byCoach = actor.id !== ownerId;
  const send = async (chatId, intro) => {
    await tgCall(env, 'sendMessage', {chat_id: chatId, parse_mode: 'HTML', text: `${intro}\n\n${escHtml(summary)}`});
    if (whoop) await tgCall(env, 'sendMessage', {chat_id: chatId, parse_mode: 'HTML', text: `Текст для WHOOP (нажми, чтобы скопировать):\n<pre>${escHtml(whoop)}</pre>`});
  };
  await send(ownerId, byCoach ? `🏋️ Тренер ${escHtml(displayName(actor))} записал твою тренировку` : '🏋️ Тренировка записана');
  for (const c of coaches) if (c.id !== actor.id) await send(c.id, `🏋️ ${escHtml(displayName(owner))} завершил тренировку`);
}

async function handleApi(req, env, url, cors) {
  const me = await verifyInitData(req.headers.get('X-Init-Data'), env.BOT_TOKEN);
  if (!me) return json({error: 'unauthorized'}, 401, cors);
  await upsertUser(env, me);
  const path = url.pathname.replace(/^\/api/, '');
  const uidParam = url.searchParams.get('uid');
  const uid = uidParam ? Number(uidParam) : me.id;

  if (path === '/me' && req.method === 'GET') {
    const clients = (await env.DB.prepare(
      `SELECT u.id, u.first_name, u.username, s.updated_at AS state_updated
       FROM links l JOIN users u ON u.id = l.client_id LEFT JOIN states s ON s.user_id = u.id
       WHERE l.coach_id = ?1 ORDER BY u.first_name`
    ).bind(me.id).all()).results || [];
    const coaches = (await env.DB.prepare(
      'SELECT u.id, u.first_name, u.username FROM links l JOIN users u ON u.id = l.coach_id WHERE l.client_id = ?1'
    ).bind(me.id).all()).results || [];
    return json({me: {id: me.id, first_name: me.first_name, username: me.username}, clients, coaches}, 200, cors);
  }

  if (path === '/state' && req.method === 'GET') {
    if (!(await canAccess(env, me, uid))) return json({error: 'forbidden'}, 403, cors);
    const row = await env.DB.prepare('SELECT data, version, updated_at FROM states WHERE user_id = ?1').bind(uid).first();
    if (!row) return json({version: 0, data: null}, 200, cors);
    const since = Number(url.searchParams.get('since') || -1);
    if (since === row.version) return json({version: row.version, unchanged: true}, 200, cors);
    return json({version: row.version, updated_at: row.updated_at, data: JSON.parse(row.data)}, 200, cors);
  }

  if (path === '/state' && req.method === 'PUT') {
    if (!(await canAccess(env, me, uid))) return json({error: 'forbidden'}, 403, cors);
    const raw = await req.text();
    if (raw.length > MAX_STATE_BYTES) return json({error: 'too_large'}, 413, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json({error: 'bad_json'}, 400, cors); }
    if (!body || typeof body.data !== 'object' || body.data === null) return json({error: 'bad_body'}, 400, cors);
    const base = Number(body.baseVersion || 0);
    const data = JSON.stringify(body.data);
    const now = Date.now();
    let res;
    if (base === 0) {
      res = await env.DB.prepare('INSERT INTO states (user_id, data, version, updated_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(user_id) DO NOTHING').bind(uid, data, now).run();
    } else {
      res = await env.DB.prepare('UPDATE states SET data = ?2, version = version + 1, updated_at = ?3 WHERE user_id = ?1 AND version = ?4').bind(uid, data, now, base).run();
    }
    if (!res.meta.changes) {
      const row = await env.DB.prepare('SELECT data, version FROM states WHERE user_id = ?1').bind(uid).first();
      return json({error: 'conflict', version: row ? row.version : 0, data: row ? JSON.parse(row.data) : null}, 409, cors);
    }
    if (body.notify) {
      try { await notify(env, uid, me, body.notify); } catch (e) { /* notification failure must not fail the save */ }
    }
    return json({version: base + 1}, 200, cors);
  }

  if (path === '/invite' && req.method === 'POST') {
    const code = randomCode();
    await env.DB.prepare('DELETE FROM invites WHERE client_id = ?1 OR created_at < ?2').bind(me.id, Date.now() - INVITE_TTL).run();
    await env.DB.prepare('INSERT INTO invites (code, client_id, created_at) VALUES (?1, ?2, ?3)').bind(code, me.id, Date.now()).run();
    const bot = await getBotUsername(env);
    return json({code, link: bot ? `https://t.me/${bot}?start=inv_${code}` : null}, 200, cors);
  }

  if (path === '/accept' && req.method === 'POST') {
    const {code} = await req.json().catch(() => ({}));
    const inv = code && (await env.DB.prepare('SELECT * FROM invites WHERE code = ?1').bind(String(code)).first());
    if (!inv || Date.now() - inv.created_at > INVITE_TTL) return json({error: 'invite_invalid'}, 404, cors);
    if (inv.client_id === me.id) return json({error: 'own_invite'}, 400, cors);
    await env.DB.prepare('INSERT OR IGNORE INTO links (coach_id, client_id, created_at) VALUES (?1, ?2, ?3)').bind(me.id, inv.client_id, Date.now()).run();
    await env.DB.prepare('DELETE FROM invites WHERE code = ?1').bind(inv.code).run();
    const client = await env.DB.prepare('SELECT id, first_name, username FROM users WHERE id = ?1').bind(inv.client_id).first();
    try { await tgCall(env, 'sendMessage', {chat_id: inv.client_id, text: `✅ ${displayName(me)} теперь твой тренер и может отмечать твои тренировки.`}); } catch (e) {}
    return json({client}, 200, cors);
  }

  if (path === '/link' && req.method === 'DELETE') {
    // A client removes a coach (?coach=ID) or a coach removes a client (?client=ID).
    const coach = Number(url.searchParams.get('coach') || 0);
    const client = Number(url.searchParams.get('client') || 0);
    if (coach) await env.DB.prepare('DELETE FROM links WHERE coach_id = ?1 AND client_id = ?2').bind(coach, me.id).run();
    else if (client) await env.DB.prepare('DELETE FROM links WHERE coach_id = ?1 AND client_id = ?2').bind(me.id, client).run();
    else return json({error: 'bad_request'}, 400, cors);
    return json({ok: true}, 200, cors);
  }

  return json({error: 'not_found'}, 404, cors);
}

async function handleBot(req, env) {
  const expected = (await sha256hex('webhook:' + env.BOT_TOKEN)).slice(0, 32);
  if (!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', expected)) return new Response('forbidden', {status: 403});
  const update = await req.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.text || msg.chat.type !== 'private') return new Response('ok');
  const text = msg.text.trim();
  const m = text.match(/^\/start\s+inv_([a-z0-9]+)$/);
  if (m) {
    const inv = await env.DB.prepare('SELECT i.*, u.first_name, u.username FROM invites i LEFT JOIN users u ON u.id = i.client_id WHERE i.code = ?1').bind(m[1]).first();
    if (!inv || Date.now() - inv.created_at > INVITE_TTL) {
      await tgCall(env, 'sendMessage', {chat_id: msg.chat.id, text: 'Приглашение устарело. Попроси новое.'});
    } else {
      await tgCall(env, 'sendMessage', {
        chat_id: msg.chat.id,
        text: `${displayName(inv)} приглашает тебя тренером. Ты сможешь отмечать его тренировки и менять веса.`,
        reply_markup: {inline_keyboard: [[{text: 'Принять и открыть', web_app: {url: `${env.APP_URL}?invite=${m[1]}`}}]]},
      });
    }
    return new Response('ok');
  }
  if (text.startsWith('/start')) {
    await tgCall(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'Дневник тренировок с автоматической прогрессией.',
      reply_markup: {inline_keyboard: [[{text: 'Открыть', web_app: {url: env.APP_URL}}]]},
    });
  }
  return new Response('ok');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url, cors);
      if (url.pathname === '/bot' && req.method === 'POST') return await handleBot(req, env);
      if (url.pathname === '/') return new Response('fitness-sync ok');
      return new Response('not found', {status: 404});
    } catch (e) {
      return json({error: 'server_error'}, 500, cors);
    }
  },
};
