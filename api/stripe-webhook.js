// api/stripe-webhook.js
export const config = { runtime: 'edge' };

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Quick HMAC verification for Edge (Stripe official library isn’t Edge-native).
// NOTE: For production robustness consider moving this route to Node runtime
// with the official Stripe SDK. This minimal Edge version verifies signatures.
async function verifyStripeSignature(request, secret) {
  const sig = request.headers.get('stripe-signature');
  if (!sig) throw new Error('Missing Stripe signature');

  // Stripe’s signature header looks like: t=timestamp,v1=signature,...
  const params = Object.fromEntries(sig.split(',').map(kv => kv.split('=')));
  const timestamp = params.t;
  const signature = params.v1;
  if (!timestamp || !signature) throw new Error('Invalid signature header');

  const body = await request.text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Compare in constant time
  if (expected.length !== signature.length) throw new Error('Bad signature');
  let ok = 0;
  for (let i = 0; i < expected.length; i++) ok |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (ok !== 0) throw new Error('Signature mismatch');

  return JSON.parse(body);
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!STRIPE_KEY || !WEBHOOK_SECRET) {
      return new Response('Stripe not configured', { status: 500 });
    }

    // Verify signature & parse event
    const event = await verifyStripeSignature(req, WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object || {};
      const meta = sess.metadata || {};
      const date = meta.date;
      const summary = meta.summary || 'Music Service Booking';
      const note = meta.note || '';
      const apiBase = meta.apiBase;

      // Recheck availability (race-proof)
      const r = await fetch(`${apiBase}/api/availability?start=${date}&end=${date}`, { cache: 'no-store' });
      const avail = await r.json();
      const day = avail?.days?.[0];
      if (!day || day.blackout || day.bookedCount >= 2) {
        // Optional: auto-refund (requires a Payment Intent)
        if (sess.payment_intent) {
          await fetch(`https://api.stripe.com/v1/refunds`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${STRIPE_KEY}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ payment_intent: sess.payment_intent })
          });
        }
        return new Response(JSON.stringify({ status: 'refunded (no capacity)' }), { status: 200 });
      }

      // Create the calendar event via your existing /api/book endpoint
      const make = await fetch(`${apiBase}/api/book`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ date, summary, note })
      });

      if (!make.ok) {
        // If calendar fails, you may choose to refund here too
        return new Response(JSON.stringify({ status: 'paid but booking failed' }), { status: 200 });
      }

      return new Response(JSON.stringify({ status: 'booked' }), { status: 200 });
    }

    // Ignore other events
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Webhook error' }), { status: 400 });
  }
}
