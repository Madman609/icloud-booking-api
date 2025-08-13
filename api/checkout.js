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

// Where to send users back after Stripe
const SITE_BASE = process.env.SITE_BASE || 'https://609music.com';

// Internal API base (this deployment) for webhook metadata, etc.
const INTERNAL_API_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'; // local dev

// IMPORTANT: Use the same public base your browser uses for availability
const PUBLIC_API_BASE =
  process.env.PUBLIC_API_BASE || 'https://icloud-booking-api.vercel.app';

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') return corsPreflight(req);

  try {
    if (req.method !== 'POST') {
      return corsJSON(req, { error: 'Method not allowed' }, 405);
    }

    const body = await req.json().catch(() => ({}));
    const { date, summary, note, total /*, payMethod*/ } = body || {};

    // Basic validation
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return corsJSON(req, { error: 'Invalid or missing date' }, 400);
    }
    const amount = Math.round(Number(total || 0) * 100);
    if (!amount || amount < 100) {
      return corsJSON(req, { error: 'Invalid total amount' }, 400);
    }

    // Re-check capacity (server-side) — call the same public endpoint the browser hits
    const availURL = `${PUBLIC_API_BASE}/api/availability?start=${date}&end=${date}`;
    const availRes = await fetch(availURL, { cache: 'no-store' });
    let avail, rawText = '';
    try {
      rawText = await availRes.text();
      avail = JSON.parse(rawText);
    } catch {
      // leave avail undefined for diagnostics
    }

    const day = avail?.days?.[0];

    // Helpful logging (visible in Vercel function logs)
    console.log('[checkout] recheck', {
      date,
      status: availRes.status,
      hasDays: Boolean(avail?.days?.length),
    });

    if (!availRes.ok) {
      return corsJSON(req, {
        error: 'Availability check failed upstream',
        detail: { status: availRes.status, body: rawText?.slice(0, 400) || null, availURL }
      }, 502);
    }

    // Trust the 'available' flag if present; otherwise fall back to blackout/capacity logic
    const isAvailable =
      day?.available === true ||
      (!!day && day.blackout === false && Number(day.bookedCount || 0) <= 1);

    if (!day || !isAvailable) {
      return corsJSON(req, {
        error: 'Selected date is not available',
        detail: {
          reason: !day ? 'no-day' : (day.blackout ? 'blackout' : `capacity:${day.bookedCount}`),
          day,
          checkedAt: new Date().toISOString(),
          availURL
        }
      }, 409);
    }

    if (!STRIPE_KEY) {
      return corsJSON(req, { error: 'STRIPE_SECRET_KEY not configured' }, 500);
    }

    // Stripe Checkout session (Apple/Google Pay ride with 'card')
    const methods = ['card', 'link', 'cashapp'];

    const successUrl = `${SITE_BASE}/pages/services.html?paid=1&date=${encodeURIComponent(date)}`;
    const cancelUrl  = `${SITE_BASE}/pages/services.html?canceled=1&date=${encodeURIComponent(date)}`;

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
      'metadata[apiBase]': INTERNAL_API_BASE, // webhook will call back here
      customer_creation: 'always',
      billing_address_collection: 'auto',
      allow_promotion_codes: 'false',
    });

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
