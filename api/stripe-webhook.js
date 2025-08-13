// api/stripe-webhook.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;         // Test or Live (match your mode)
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // From Stripe Dashboard > Developers > Webhooks
const SELF_BASE_URL =
  process.env.SELF_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

// Read raw body for signature verification
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }
    if (!STRIPE_KEY || !WEBHOOK_SECRET) {
      console.error('[webhook] missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
      return res.status(500).send('Stripe not configured');
    }

    const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

    // IMPORTANT: use raw body, not parsed JSON
    const sig = req.headers['stripe-signature'];
    const rawBody = await readRawBody(req);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('[webhook] signature verification failed:', err?.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Log minimal event info for debugging
    console.log('[webhook] event type:', event.type);

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object || {};
      const meta = sess.metadata || {};
      const date = meta.date;
      const summary = meta.summary || 'Music Service Booking';
      const note = meta.note || '';
      const apiBase = meta.apiBase || SELF_BASE_URL;

      console.log('[webhook] completed:', { date, summary, apiBase });

      // Re-check capacity first (race-proof)
      try {
        const r = await fetch(`${apiBase}/api/availability?start=${date}&end=${date}`, { cache: 'no-store' });
        const avail = await r.json();
        const day = avail?.days?.[0];

        if (!day || day.blackout || day.bookedCount >= 2) {
          console.warn('[webhook] no capacity; optionally refund here. day=', day);
          // Optional: if you want to auto-refund in this case:
          // if (sess.payment_intent) {
          //   await stripe.refunds.create({ payment_intent: sess.payment_intent });
          // }
          return res.status(200).json({ status: 'no capacity' });
        }
      } catch (e) {
        console.error('[webhook] availability check failed:', e?.message || e);
        // Keep going (or choose to return a 500 to have Stripe retry)
      }

      // Create calendar event via your Node booking API
      try {
        const make = await fetch(`${apiBase}/api/book`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, summary, note }),
        });

        if (!make.ok) {
          const text = await make.text();
          console.error('[webhook] /api/book failed:', make.status, text);
          return res.status(200).json({ status: 'paid but booking failed' });
        }

        const created = await make.json();
        console.log('[webhook] booked:', created);
        return res.status(200).json({ status: 'booked' });
      } catch (e) {
        console.error('[webhook] /api/book exception:', e?.message || e);
        return res.status(200).json({ status: 'paid but booking failed' });
      }
    }

    // Acknowledge other events
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] fatal error:', err?.message || err);
    return res.status(500).send('Server error');
  }
}
