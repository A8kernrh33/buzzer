const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const FCM_DEVICE_TOKEN = process.env.FCM_DEVICE_TOKEN;
const SUPERIOR_PASSWORD = process.env.SUPERIOR_PASSWORD;
const COOLDOWN_MS = 60_000;
const HISTORY_LIMIT = 50;
const SESSION_MS = 12 * 60 * 60 * 1000;

let lastSentAt = 0;
let history = [];
let lastDelivery = { status: 'ready', name: null, command: null, at: null };
let historyDb = null;
const sessions = new Map();
const loginAttempts = new Map();

app.use(express.json({ limit: '12kb' }));
app.use(express.static(__dirname));

function initFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function getHistoryDb() {
  initFirebase();
  if (!historyDb) historyDb = admin.firestore().collection('summonHistory');
  return historyDb;
}

async function loadHistory() {
  try {
    const snapshot = await getHistoryDb().orderBy('atMs', 'desc').limit(HISTORY_LIMIT).get();
    history = snapshot.docs.map(doc => {
      const d = doc.data();
      return { name: d.name || '', command: d.command || null, status: d.status || 'delivered', at: new Date(d.atMs || Date.now()).toISOString() };
    });
  } catch (error) { console.error('HISTORY LOAD ERROR:', error.message); }
}

function addHistory(entry) {
  const record = { ...entry, at: new Date().toISOString() };
  history.unshift(record);
  history = history.slice(0, HISTORY_LIMIT);
  try {
    getHistoryDb().add({ name: record.name || '', command: record.command || null, status: record.status || 'delivered', atMs: Date.now() })
      .catch(error => console.error('HISTORY SAVE ERROR:', error.message));
  } catch (error) { console.error('HISTORY SAVE ERROR:', error.message); }
}

async function sendFcm(data) {
  if (!FCM_DEVICE_TOKEN) throw new Error('FCM_DEVICE_TOKEN is not configured');
  initFirebase();
  const clean = {};
  for (const [key, value] of Object.entries(data)) clean[key] = String(value ?? '').slice(0, 500);
  await admin.messaging().send({ token: FCM_DEVICE_TOKEN, data: clean, android: { priority: 'high', ttl: 60 * 1000 } });
}

function getRemainingCooldown() { return Math.max(0, COOLDOWN_MS - (Date.now() - lastSentAt)); }
function getClientIp(req) { return String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim(); }
function issueSession() { const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now() + SESSION_MS); return token; }

function requireSuperior(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : req.cookies?.superior_session;
  const expires = token ? sessions.get(token) : null;
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Superior authentication required.' });
  }
  req.superiorToken = token;
  next();
}

app.post('/api/superior/login', (req, res) => {
  if (!SUPERIOR_PASSWORD) return res.status(503).json({ error: 'SUPERIOR_PASSWORD is not configured on the server.' });
  const ip = getClientIp(req), now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  recent.push(now); loginAttempts.set(ip, recent);
  const supplied = String(req.body?.password || ''), a = Buffer.from(supplied), b = Buffer.from(SUPERIOR_PASSWORD);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return res.status(401).json({ error: 'Incorrect Superior password.' });
  const token = issueSession();
  res.json({ ok: true, token, expiresInSeconds: Math.floor(SESSION_MS / 1000) });
});

app.post('/api/superior/logout', requireSuperior, (req, res) => { sessions.delete(req.superiorToken); res.json({ ok: true }); });
app.get('/api/superior/status', requireSuperior, (req, res) => res.json({ ok: true, authenticated: true, controls: ['summon', 'vibrate', 'stop_vibration', 'stop_alarm', 'notification', 'wake'] }));

app.post('/api/buzz', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const message = String(req.body?.message || '').trim().slice(0, 300);
  if (!name) return res.status(400).json({ error: 'Superior name is required.' });
  const remainingMs = getRemainingCooldown();
  if (remainingMs > 0) return res.status(429).json({ error: `The summon button is on cooldown. Try again in ${Math.ceil(remainingMs / 1000)}s.`, waitSeconds: Math.ceil(remainingMs / 1000) });
  try {
    await sendFcm({ name, message, command: 'summon', type: 'buzz' });
    lastSentAt = Date.now();
    lastDelivery = { status: 'delivered', name, command: 'summon', at: new Date().toISOString() };
    addHistory({ name, command: 'summon', status: 'delivered' });
    res.json({ ok: true, mode: 'sent', cooldownSeconds: 60 });
  } catch (error) {
    console.error('BUZZ ERROR:', error);
    addHistory({ name, command: 'summon', status: 'failed' });
    lastDelivery = { status: 'error', name, command: error.message, at: new Date().toISOString() };
    res.status(502).json({ error: `Could not send buzz: ${error.message}` });
  }
});

app.post('/api/superior/command', requireSuperior, async (req, res) => {
  const allowed = new Set(['summon', 'vibrate', 'stop_vibration', 'stop_alarm', 'notification', 'wake']);
  const command = String(req.body?.command || '').trim().toLowerCase();
  if (!allowed.has(command)) return res.status(400).json({ error: 'Unsupported control.' });
  const name = String(req.body?.name || 'Superior').trim().slice(0, 40) || 'Superior';
  const message = String(req.body?.message || '').trim().slice(0, 300);
  const title = String(req.body?.title || 'BUZZER 2.0').trim().slice(0, 80);
  const duration = String(Math.max(1, Math.min(300, Number(req.body?.duration) || 60)));
  const volume = String(Math.max(0, Math.min(100, Number(req.body?.volume) || 100)));
  const pattern = String(req.body?.vibration_pattern || '0,600,250,600,250,1000').slice(0, 150);
  if (command === 'summon' && getRemainingCooldown() > 0) {
    const waitSeconds = Math.ceil(getRemainingCooldown() / 1000);
    return res.status(429).json({ error: `Summon cooldown active for ${waitSeconds}s.`, waitSeconds });
  }
  try {
    await sendFcm({ type: 'control', command, name, message, title, duration, volume, vibration_pattern: pattern });
    if (command === 'summon') lastSentAt = Date.now();
    lastDelivery = { status: 'delivered', name, command, at: new Date().toISOString() };
    addHistory({ name, command, status: 'delivered' });
    res.json({ ok: true, command });
  } catch (error) {
    console.error('SUPERIOR COMMAND ERROR:', error);
    addHistory({ name, command, status: 'failed' });
    res.status(502).json({ error: `Could not send command: ${error.message}` });
  }
});

app.get('/api/history', (req, res) => res.json({ history }));
app.get('/api/status', (req, res) => {
  const remainingMs = getRemainingCooldown();
  res.json({ online: true, ready: remainingMs === 0, cooldownSeconds: Math.ceil(remainingMs / 1000), pending: 0, lastDelivery });
});
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', async () => { console.log(`Buzzer 2.0 server listening on port ${PORT}`); await loadHistory(); });
