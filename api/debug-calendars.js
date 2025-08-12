// Minimal calendar introspection to verify names
import xhr2pkg from 'xhr2';
const { XMLHttpRequest } = xhr2pkg;
globalThis.XMLHttpRequest = XMLHttpRequest;

import { DOMParser as XmldomParser } from '@xmldom/xmldom';
globalThis.DOMParser = XmldomParser;

import * as dav from 'dav';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { ICLOUD_USERNAME, ICLOUD_APP_PASSWORD } = process.env;
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    return res.status(500).json({ error: 'Missing iCloud env vars' });
  }
  try {
    const xhr = new dav.transport.Basic(
      new dav.Credentials({ username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD })
    );
    const account = await dav.createAccount({
      server: 'https://caldav.icloud.com',
      xhr,
      loadCollections: true,
      loadObjects: false
    });

    const list = (account.calendars || []).map(c => ({
      displayName: c.displayName,
      url: c.url
    }));

    res.status(200).json({ ok: true, calendars: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
