import 'cross-fetch/polyfill';
import { createDAVClient } from 'tsdav';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { ICLOUD_USERNAME, ICLOUD_APP_PASSWORD } = process.env;
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    return res.status(500).json({ ok:false, error:'Missing ICLOUD_USERNAME or ICLOUD_APP_PASSWORD' });
  }

  try {
    // Step 1: just create the client (auth)
    let client;
    try {
      client = await createDAVClient({
        serverUrl: 'https://caldav.icloud.com',
        credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
    } catch (e) {
      return res.status(500).json({ ok:false, step:'createDAVClient', message:String(e?.message||e) });
    }

    // Step 2: fetch calendars
    let calendars;
    try {
      calendars = await client.fetchCalendars();
    } catch (e) {
      return res.status(500).json({ ok:false, step:'fetchCalendars', message:String(e?.message||e) });
    }

    // Success: return names so we can verify display names
    return res.status(200).json({
      ok: true,
      calendars: (calendars||[]).map(c => ({ displayName: c.displayName, url: c.url }))
    });

  } catch (e) {
    return res.status(500).json({ ok:false, step:'outer', message:String(e?.message||e) });
  }
}
