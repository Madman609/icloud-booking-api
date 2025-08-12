// api/checkout.js
export const config = { runtime: 'edge' }; // Edge is fast & simple

// --- CORS helpers (inline) ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://609music.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function pickOrigin(req) {
  const incoming = req.headers.get('origin') || '';
  return ALLOWED_ORIGINS.includes(incoming) ? incoming : ALLOWED_ORIGINS[0] || '*';
}

function corsJSON(req, data, status = 200, extraHeaders = {}) {
  const allow = pickOrigin(req);
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': allow,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      ...extraHeaders,
    },
  });
}

function corsPreflight(req) {
  const allow = pickOrigin(req);
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': allow,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

// --- Config / constants ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const API_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'; // local dev

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') return corsPreflight(req);

  try {
    if (req.method !== 'POST') {
      return corsJSON(req, { error: 'Method not allowed' }, 405);
    }

    const body = await req.json().catch(() => ({}));
    const { date, summary, note, total, payMethod } = body || {};

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return corsJSON(req, { error: 'Invalid or missing date' }, 400);
    }

    const amount = Math.round(Number(total || 0) * 100);
    if (!amount || amount < 100) {
      return corsJSON(req, { error: 'Invalid total amount' }, 400);
    }

    // Re-check capacity (calls your availability route)
    const r = await fetch(`${API_BASE}/api/availability?start=${date}&end=${date}`, { cache: 'no-store' });
    const avail = await r.json().catch(() => ({}));
    const day = avail?.days?.[0];

    if (!day || day.blackout || day.bookedCount >= 2) {
      return corsJSON(req, { error: 'Selected date is not available' }, 409);
    }

    if (!STRIPE_KEY) {
      return corsJSON(req, { error: 'STRIPE_SECRET_KEY not configured' }, 500);
    }

    // Stripe Checkout session via HTTPS fetch (Edge-compatible)
    // Apple/Google Pay are covered by 'card'
    const methods = ['card', 'link', 'cashapp'];

    // You can point these to your website if preferred:
    const successUrl = `${API_BASE}/success?date=${encodeURIComponent(date)}`;
    const cancelUrl = `${API_BASE}/cancel?date=${encodeURIComponent(date)}`;

    const form = new URLSearchParams({
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
      // Let Checkout create/attach a customer and collect email
      customer_creation: 'always',
      billing_address_collection: 'auto',
      allow_promotion_codes: 'false',
    });

    // Optionally pass customer_email if you’ve collected it on your page:
    // form.set('customer_email', body.email || '');

    const createRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });

    const session = await createRes.json().catch(() => ({}));

    if (!createRes.ok || !session?.url) {
      return corsJSON(req, { error: session?.error?.message || 'Stripe session failed' }, 500);
    }

    return corsJSON(req, { url: session.url }, 200);
  } catch (err) {
    return corsJSON(req, { error: err?.message || 'Server error' }, 500);
  }
}
