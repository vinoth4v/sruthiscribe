// Server-side proxy for the "Ask about this reading" panel.
//
// Holds ANTHROPIC_API_KEY as a Vercel environment variable so visitors never
// see or need their own key. The model is fixed here, never taken from the
// client, so every request from this endpoint uses Sonnet regardless of what
// the page sends.
//
// Setup: Vercel dashboard -> this project -> Settings -> Environment
// Variables -> add ANTHROPIC_API_KEY -> redeploy.

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed.' } });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // 501: distinguishes "not configured yet" from a real upstream failure,
    // so the client can point the site owner at the fix.
    res.status(501).json({ error: { message: 'This site has not configured shared Claude access yet.' } });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch (e) { res.status(400).json({ error: { message: 'Invalid request body.' } }); return; }
  }
  const messages = body && body.messages;
  const system = body && body.system;
  if (!Array.isArray(messages) || !messages.length) {
    res.status(400).json({ error: { message: 'Missing messages.' } });
    return;
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: system,
        messages: messages
      })
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: 'Could not reach Anthropic from the server.' } });
  }
}
