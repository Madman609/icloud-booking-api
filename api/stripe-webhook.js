// api/stripe-webhook.js
export const config = { runtime: 'edge' };

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Minimal HMAC verify for Stripe signature (Edge-compatible)
async function verifyStripeSignature(request, secret) {
  const sig = request.headers.get('stripe-signature');
  if (!sig) throw new Error('Missing Stripe signature');

  // Stripe header: t=timestamp,v1=signature,...
  const parts = Object.fromEntries(sig.split(',').map(kv => kv.split('=')));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) throw new Error('Invalid signature header');

  const raw = await request.text();
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${raw}`));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time-ish compare
  if (expected.length !== v1.length) throw new Error('Bad signature');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) throw new Error('Signature mismatch');

  return JSON.parse(raw);
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!STRIPE_KEY || !WEBHOOK_SECRET) {
      return new Response('Stripe not configured', { status: 500 });
    }

    // Verify & parse event
    const event = await verifyStripeSignature(req, WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object ?? {};
      const meta = sess.metadata ?? {};

      const date = meta.date;
      const summary = meta.summary || 'Music Service Booking';
      const note = meta.note || '';

      if (!date) {
        return new Response(JSON.stringify({ error: 'Missing date in metadata' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }

      // Build same-origin absolute URL so we NEVER hit a protected preview URL
      const host = req.headers.get('host');
      const baseURL = `https://${host}`;
      const availabilityURL = `${baseURL}/api/availability?start=${date}&end=${date}`;
      const bookURL = `${baseURL}/api/book`;

      // Recheck capacity to avoid double-booking
      const r = await fetch(availabilityURL, { cache: 'no-store' });
      const avail = await r.json();
      const day = avail?.days?.[0];

      if (!day || day.blackout || day.bookedCount >= 2) {
        // Optional: auto-refund if capacity gone
        if (sess.payment_intent) {
          await fetch('https://api.stripe.com/v1/refunds', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${STRIPE_KEY}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ payment_intent: String(sess.payment_intent) })
          });
        }
        return new Response(JSON.stringify({
          status: 'refunded (no capacity)',
          checked: availabilityURL
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      // Create the calendar event via your own /api/book
      const make = await fetch(bookURL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date, summary, note })
      });

      if (!make.ok) {
        return new Response(JSON.stringify({
          status: 'paid but booking failed',
          bookURL,
          detail: await make.text()
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        status: 'booked',
        bookURL
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // Acknowledge other events
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Webhook error' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
}
