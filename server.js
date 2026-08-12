const express = require('express');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const FCM_DEVICE_TOKEN = process.env.FCM_DEVICE_TOKEN;
const COOLDOWN_MS = 10_000;

let lastSentAt = 0;
let pendingBuzzes = [];
let batchTimer = null;

app.use(express.json());
app.use(express.static(__dirname));

function initFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

async function sendFcm(name, extra = false) {
  if (!FCM_DEVICE_TOKEN) throw new Error('FCM_DEVICE_TOKEN is not configured');
  initFirebase();

  await admin.messaging().send({
    token: FCM_DEVICE_TOKEN,
    data: {
      name: name.slice(0, 40),
      type: 'buzz',
      extra: extra ? 'true' : 'false'
    },
    android: {
      priority: 'high',
      ttl: 60 * 1000
    }
  });
}

async function flushPending() {
  batchTimer = null;
  if (!pendingBuzzes.length) return;

  const names = pendingBuzzes.splice(0, pendingBuzzes.length);
  const uniqueNames = [...new Set(names)];
  const summary = uniqueNames.length === 1
    ? `${uniqueNames[0]} buzzed again ${names.length} times during the cooldown.`
    : `${names.length} additional buzzes from ${uniqueNames.join(', ')} during the cooldown.`;

  try {
    await sendFcm(summary, true);
    lastSentAt = Date.now();
  } catch (error) {
    console.error('BATCH BUZZ ERROR:', error);
    pendingBuzzes.unshift(...names);
  }
}

app.post('/api/buzz', async (req, res) => {
  const name = String(req.body?.name || 'Someone').trim().slice(0, 40) || 'Someone';
  const now = Date.now();
  const elapsed = now - lastSentAt;

  if (elapsed >= COOLDOWN_MS && pendingBuzzes.length === 0) {
    try {
      await sendFcm(name);
      lastSentAt = Date.now();
      return res.json({ ok: true, mode: 'sent' });
    } catch (error) {
      console.error('BUZZ ERROR:', error);
      return res.status(502).json({ error: `Could not send buzz: ${error.message}` });
    }
  }

  pendingBuzzes.push(name);
  if (!batchTimer) {
    const remaining = Math.max(0, COOLDOWN_MS - elapsed);
    batchTimer = setTimeout(flushPending, remaining);
  }

  const waitSeconds = Math.ceil(Math.max(0, COOLDOWN_MS - elapsed) / 1000);
  res.json({ ok: true, mode: 'queued', waitSeconds });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Buzz server listening on port ${PORT}`);
});
