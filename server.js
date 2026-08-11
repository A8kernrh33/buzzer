const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'buzz_hpEpfFthFPlmDD778TYKlcSl';

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

app.post('/api/buzz', async (req, res) => {
  try {
    const name = String(req.body?.name || 'Someone').slice(0, 40);
    await sendNtfy(`${name} pressed the BUZZ button.`);
    res.json({ ok: true });
  } catch (error) {
    console.error('BUZZ ERROR:', error);
    res.status(502).json({ error: `Could not send notification: ${error.message}` });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Buzz server listening on port ${PORT}`);
});
