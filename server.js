const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'buzz_hpEpfFthFPlmDD778TYKlcSl';

// Keep ntfy traffic low: one immediate notification, then batch extra buzzes
// that arrive during the next 10 seconds into a single follow-up.
const COOLDOWN_MS = 10_000;
let lastSentAt = 0;
let pendingBuzzes = [];
let batchTimer = null;

app.use(express.json());
app.use(express.static(__dirname));

function sendNtfy(message) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(message),
        'Title': 'Someone is buzzing you!',
        'Priority': '5',
        'Tags': 'bell'
      }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`ntfy returned HTTP ${response.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('ntfy request timed out')));
    req.write(message);
    req.end();
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
    await sendNtfy(summary);
    lastSentAt = Date.now();
  } catch (error) {
    console.error('BATCH BUZZ ERROR:', error);
    // Put the names back so the next buzz can retry the batch.
    pendingBuzzes.unshift(...names);
  }
}

app.post('/api/buzz', async (req, res) => {
  const name = String(req.body?.name || 'Someone').trim().slice(0, 40) || 'Someone';
  const now = Date.now();
  const elapsed = now - lastSentAt;

  // First buzz: send immediately.
  if (elapsed >= COOLDOWN_MS && pendingBuzzes.length === 0) {
    try {
      await sendNtfy(`${name} pressed the BUZZ button.`);
      lastSentAt = Date.now();
      return res.json({ ok: true, mode: 'sent' });
    } catch (error) {
      console.error('BUZZ ERROR:', error);
      return res.status(502).json({ error: `Could not send notification: ${error.message}` });
    }
  }

  // Extra buzzes during the cooldown are queued instead of becoming
  // individual ntfy messages.
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
