// api/_cors.js  (Edge/Fetch compatible)
export function corsifyJSON(data, status = 200, extraHeaders = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  // Allow-list: set in Vercel → Settings → Environment Variables
  const allow = process.env.ALLOWED_ORIGIN || 'https://609music.com';
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': allow,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      ...extraHeaders,
    }
  });
}

// For OPTIONS preflight:
export function corsPreflight() {
  const allow = process.env.ALLOWED_ORIGIN || 'https://609music.com';
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': allow,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-max-age': '86400'
    }
  });
}
