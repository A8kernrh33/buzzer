const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'buzz_hpEpfFthFPlmDD778TYKlcSl';

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/buzz', async (req, res) => {
  try {
    const name = String(req.body?.name || 'Someone').slice(0, 40);
    const response = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title': '🔔 Someone is buzzing you!',
        'Priority': '5',
        'Tags': 'bell'
      },
      body: `${name} pressed the BUZZ button.`
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Notification service rejected the buzz' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not send buzz' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Buzz server listening on port ${PORT}`);
});
