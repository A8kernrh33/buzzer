const express = require('express');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const FCM_DEVICE_TOKEN = process.env.FCM_DEVICE_TOKEN;
const COOLDOWN_MS = 10_000;
const HISTORY_LIMIT = 25;

let lastSentAt = 0;
let pendingBuzzes = [];
let batchTimer = null;
let history = [];
let lastDelivery = { status: 'ready', name: null, command: null, at: null };

app.use(express.json({ limit: '8kb' }));
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

function addHistory(entry) {
  history.unshift({ ...entry, at: new Date().toISOString() });
  history = history.slice(0, HISTORY_LIMIT);
}

async function sendFcm(name, command = '', extra = false) {
  if (!FCM_DEVICE_TOKEN) throw new Error('FCM_DEVICE_TOKEN is not configured');
  initFirebase();
  await admin.messaging().send({
    token: FCM_DEVICE_TOKEN,
    data: {
      name: name.slice(0, 40),
      command: command.slice(0, 180),
      type: 'buzz',
      extra: extra ? 'true' : 'false'
    },
    android: { priority: 'high', ttl: 60 * 1000 }
  });
}

async function flushPending() {
  batchTimer = null;
  if (!pendingBuzzes.length) return;
  const pending = pendingBuzzes.splice(0, pendingBuzzes.length);
  const uniqueNames = [...new Set(pending.map(x => x.name))];
  const summaryName = uniqueNames.length === 1
    ? `${uniqueNames[0]} buzzed again ${pending.length} times during the cooldown.`
    : `${pending.length} additional buzzes from ${uniqueNames.join(', ')} during the cooldown.`;
  const summaryCommand = pending.map(x => x.command).filter(Boolean).slice(0, 3).join(' · ');
  try {
    await sendFcm(summaryName, summaryCommand, true);
    lastSentAt = Date.now();
    lastDelivery = { status: 'delivered', name: summaryName, command: summaryCommand || null, at: new Date().toISOString() };
    pending.forEach(item => addHistory({ name: item.name, command: item.command || null, status: 'delivered' }));
  } catch (error) {
    console.error('BATCH BUZZ ERROR:', error);
    pendingBuzzes.unshift(...pending);
    lastDelivery = { status: 'error', name: null, command: error.message, at: new Date().toISOString() };
  }
}

app.post('/api/buzz', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const command = String(req.body?.command || '').trim().slice(0, 180);
  if (!name) return res.status(400).json({ error: 'Superior name is required.' });

  const now = Date.now();
  const elapsed = now - lastSentAt;

  if (elapsed >= COOLDOWN_MS && pendingBuzzes.length === 0) {
    try {
      await sendFcm(name, command);
      lastSentAt = Date.now();
      lastDelivery = { status: 'delivered', name, command: command || null, at: new Date().toISOString() };
      addHistory({ name, command: command || null, status: 'delivered' });
      return res.json({ ok: true, mode: 'sent' });
    } catch (error) {
      console.error('BUZZ ERROR:', error);
      addHistory({ name, command: command || null, status: 'failed' });
      lastDelivery = { status: 'error', name, command: error.message, at: new Date().toISOString() };
      return res.status(502).json({ error: `Could not send buzz: ${error.message}` });
    }
  }

  pendingBuzzes.push({ name, command });
  addHistory({ name, command: command || null, status: 'queued' });
  if (!batchTimer) {
    const remaining = Math.max(0, COOLDOWN_MS - elapsed);
    batchTimer = setTimeout(flushPending, remaining);
  }
  const waitSeconds = Math.ceil(Math.max(0, COOLDOWN_MS - elapsed) / 1000);
  res.json({ ok: true, mode: 'queued', waitSeconds });
});

app.get('/api/history', (req, res) => res.json({ history }));
app.get('/api/status', (req, res) => {
  const remainingMs = Math.max(0, COOLDOWN_MS - (Date.now() - lastSentAt));
  res.json({ online: true, ready: remainingMs === 0 && pendingBuzzes.length === 0, cooldownSeconds: Math.ceil(remainingMs / 1000), pending: pendingBuzzes.length, lastDelivery });
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, '0.0.0.0', () => console.log(`Buzz server listening on port ${PORT}`));
