exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const name = String(body.name || "Someone").slice(0, 40);

    const response = await fetch("https://ntfy.sh/buzz_hpEpfFthFPlmDD778TYKlcSl", {
      method: "POST",
      headers: {
        "Title": "🔔 Someone is buzzing you!",
        "Priority": "5",
        "Tags": "bell"
      },
      body: `${name} pressed the BUZZ button.`
    });

    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Notification service rejected the buzz" }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: "Could not send buzz" }) };
  }
};
