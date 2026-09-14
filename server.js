const express = require('express');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const FCM_DEVICE_TOKEN = process.env.FCM_DEVICE_TOKEN;
const COOLDOWN_MS = 60_000;
const HISTORY_LIMIT = 25;

let lastSentAt = 0;
let history = [];
let lastDelivery = { status: 'ready', name: null, command: null, at: null };
let historyDb = null;

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

function getHistoryDb() {
  initFirebase();
  if (!historyDb) historyDb = admin.firestore().collection('summonHistory');
  return historyDb;
}

async function loadHistory() {
  try {
    const snapshot = await getHistoryDb().orderBy('atMs', 'desc').limit(HISTORY_LIMIT).get();
    history = snapshot.docs.map(doc => {
      const data = doc.data();
      return { name: data.name || '', command: data.command || null, status: data.status || 'delivered', at: new Date(data.atMs || Date.now()).toISOString() };
    });
    console.log(`Loaded ${history.length} summon history entries from Firestore.`);
  } catch (error) {
    console.error('HISTORY LOAD ERROR:', error.message);
    console.error('Enable Firestore in the Firebase project if it has not been enabled yet.');
  }
}

function addHistory(entry) {
  const record = { ...entry, at: new Date().toISOString() };
  history.unshift(record);
  history = history.slice(0, HISTORY_LIMIT);
  try {
    getHistoryDb().add({
      name: record.name || '',
      command: record.command || null,
      status: record.status || 'delivered',
      atMs: Date.now()
    }).catch(error => console.error('HISTORY SAVE ERROR:', error.message));
  } catch (error) {
    console.error('HISTORY SAVE ERROR:', error.message);
  }
}

async function sendFcm(name, command = '') {
  if (!FCM_DEVICE_TOKEN) throw new Error('FCM_DEVICE_TOKEN is not configured');
  initFirebase();
  await admin.messaging().send({
    token: FCM_DEVICE_TOKEN,
    data: {
      name: name.slice(0, 40),
      command: command.slice(0, 180),
      type: 'buzz'
    },
    android: { priority: 'high', ttl: 60 * 1000 }
  });
}

app.post('/api/buzz', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const command = String(req.body?.command || '').trim().slice(0, 180);
  if (!name) return res.status(400).json({ error: 'Superior name is required.' });

  const elapsed = Date.now() - lastSentAt;
  const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);

  if (remainingMs > 0) {
    const waitSeconds = Math.ceil(remainingMs / 1000);
    return res.status(429).json({
      error: `The summon button is on cooldown. Try again in ${waitSeconds}s.`,
      waitSeconds
    });
  }

  try {
    await sendFcm(name, command);
    lastSentAt = Date.now();
    lastDelivery = { status: 'delivered', name, command: command || null, at: new Date().toISOString() };
    addHistory({ name, command: command || null, status: 'delivered' });
    return res.json({ ok: true, mode: 'sent', cooldownSeconds: 60 });
  } catch (error) {
    console.error('BUZZ ERROR:', error);
    addHistory({ name, command: command || null, status: 'failed' });
    lastDelivery = { status: 'error', name, command: error.message, at: new Date().toISOString() };
    return res.status(502).json({ error: `Could not send buzz: ${error.message}` });
  }
});

app.get('/api/history', (req, res) => res.json({ history }));
app.get('/api/status', (req, res) => {
  const remainingMs = Math.max(0, COOLDOWN_MS - (Date.now() - lastSentAt));
  res.json({ online: true, ready: remainingMs === 0, cooldownSeconds: Math.ceil(remainingMs / 1000), pending: 0, lastDelivery });
});
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Buzz server listening on port ${PORT}`);
  await loadHistory();
});
