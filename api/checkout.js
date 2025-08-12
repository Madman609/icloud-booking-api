// api/checkout.js
export const config = { runtime: 'edge' }; // Edge is fast & simple

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const API_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'; // local dev

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    const body = await req.json();
    const { date, summary, note, total, payMethod } = body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'Invalid or missing date' }), { status: 400 });
    }
    const amount = Math.round(Number(total || 0) * 100);
    if (!amount || amount < 100) {
      return new Response(JSON.stringify({ error: 'Invalid total amount' }), { status: 400 });
    }

    // Re-check capacity (calls your existing availability route)
    const r = await fetch(`${API_BASE}/api/availability?start=${date}&end=${date}`, { cache: 'no-store' });
    const avail = await r.json();
    const day = avail?.days?.[0];
    if (!day || day.blackout || day.bookedCount >= 2) {
      return new Response(JSON.stringify({ error: 'Selected date is not available' }), { status: 409 });
    }

    if (!STRIPE_KEY) {
      return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }), { status: 500 });
    }

    // Stripe (Edge-compatible fetch)
    const lineItems = [{
      price_data: {
        currency: 'usd',
        product_data: { name: summary || 'Music Service Booking' },
        unit_amount: amount
      },
      quantity: 1
    }];

    // Choose allowed methods; Apple/Google Pay ride on 'card'
    const methods = ['card', 'link', 'cashapp'];

    const successUrl = `${API_BASE}/success?date=${encodeURIComponent(date)}`;
    const cancelUrl = `${API_BASE}/cancel?date=${encodeURIComponent(date)}`;

    const createRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        mode: 'payment',
        'payment_method_types[]': methods[0],
        'payment_method_types[]': methods[1],
        'payment_method_types[]': methods[2],
        success_url: successUrl,
        cancel_url: cancelUrl,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': summary || 'Music Service Booking',
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][quantity]': '1',
        // Metadata for webhook → /api/book
        'metadata[date]': date,
        'metadata[summary]': summary || '',
        'metadata[note]': note || '',
        'metadata[apiBase]': API_BASE,
        // Collect email in Checkout
        customer_creation: 'always',
        customer_email: '', // optional; Checkout will prompt
        billing_address_collection: 'auto',
        allow_promotion_codes: 'false'
      })
    });

    const session = await createRes.json();
    if (!createRes.ok || !session?.url) {
      return new Response(JSON.stringify({ error: session?.error?.message || 'Stripe session failed' }), { status: 500 });
    }

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Server error' }), { status: 500 });
  }
}
