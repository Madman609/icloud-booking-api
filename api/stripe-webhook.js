// api/stripe-webhook.js
export const config = { runtime: 'edge' };

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Verify Stripe signature for Edge (HMAC of raw body)
async function verifyStripeSignature(request, secret) {
  const sig = request.headers.get('stripe-signature');
  if (!sig) throw new Error('Missing Stripe signature header');

  const params = Object.fromEntries(sig.split(',').map(kv => kv.split('=')));
  const timestamp = params.t;
  const signature = params.v1;
  if (!timestamp || !signature) throw new Error('Invalid signature header');

  // IMPORTANT: read raw body ONCE
  const bodyText = await request.text();

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${bodyText}`)
  );
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare
  if (expected.length !== signature.length) throw new Error('Bad signature length');
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (mismatch !== 0) throw new Error('Signature mismatch');

  return JSON.parse(bodyText);
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!STRIPE_KEY || !WEBHOOK_SECRET) {
      return json(500, { error: 'Stripe env missing', haveKey: !!STRIPE_KEY, haveWh: !!WEBHOOK_SECRET });
    }

    let event;
    try {
      event = await verifyStripeSignature(req, WEBHOOK_SECRET);
    } catch (e) {
      return json(400, { error: 'signature verification failed', detail: String(e?.message || e) });
    }

    // Log the event type & id so we can correlate in Stripe dashboard
    console.log('[WEBHOOK] type=', event?.type, 'id=', event?.id);

    if (event.type === 'checkout.session.completed') {
      const sess = event.data?.object || {};
      const meta = sess.metadata || {};
      const date = meta.date;
      const summary = meta.summary || 'Music Service Booking';
      const note = meta.note || '';
      const apiBase = meta.apiBase;

      if (!apiBase || !date) {
        console.warn('[WEBHOOK] missing apiBase or date', { apiBase, date });
        return json(200, { status: 'ignored-missing-metadata' });
      }

      // Re-check capacity to avoid overbooking
      let day;
      try {
        const r = await fetch(`${apiBase}/api/availability?start=${date}&end=${date}`, { cache: 'no-store' });
        const avail = await r.json();
        day = avail?.days?.[0];
        console.log('[WEBHOOK] availability for', date, '→', day);
      } catch (e) {
        console.error('[WEBHOOK] availability fetch failed', String(e));
        // Still attempt booking; you can choose to bail here instead.
      }

      if (day?.blackout || (Number(day?.bookedCount) >= 2)) {
        console.warn('[WEBHOOK] capacity hit, issuing refund');
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
        return json(200, { status: 'refunded-no-capacity' });
      }

      // Create the calendar booking
      try {
        const make = await fetch(`${apiBase}/api/book`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ date, summary, note })
        });

        const text = await make.text();
        let resp;
        try { resp = JSON.parse(text); } catch { resp = { raw: text }; }

        console.log('[WEBHOOK] /api/book →', make.status, resp);

        if (!make.ok) {
          // Optional: refund if booking fails
          console.error('[WEBHOOK] booking failed');
          return json(200, { status: 'paid-booking-failed', detail: resp });
        }

        return json(200, { status: 'booked', detail: resp });
      } catch (e) {
        console.error('[WEBHOOK] book call error', String(e));
        return json(200, { status: 'paid-book-call-error', detail: String(e) });
      }
    }

    // Ignore other event types
    return json(200, { received: true, ignored: event?.type });
  } catch (err) {
    console.error('[WEBHOOK] fatal', String(err));
    return json(400, { error: err?.message || 'Webhook error' });
  }
}
