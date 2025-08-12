// Polyfill XMLHttpRequest for 'dav' in Node (Vercel functions)
import xhr2pkg from 'xhr2';
const { XMLHttpRequest: XHR2 } = xhr2pkg;
globalThis.XMLHttpRequest = XHR2;

import dayjs from 'dayjs';
import * as dav from 'dav';
import * as ICAL from 'ical.js';

const {
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  BOOKINGS_CAL_NAME = 'Bookings',
  BLACKOUTS_CAL_NAME = 'Blackouts',
} = process.env;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function missingEnv() {
  const m = [];
  if (!ICLOUD_USERNAME) m.push('ICLOUD_USERNAME');
  if (!ICLOUD_APP_PASSWORD) m.push('ICLOUD_APP_PASSWORD');
  if (m.length) throw new Error('Missing env vars: ' + m.join(', '));
}

async function getAccount() {
  missingEnv();
  const xhr = new dav.transport.Basic(
    new dav.Credentials({ username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD })
  );
  const account = await dav.createAccount({
    server: 'https://caldav.icloud.com',
    xhr,
    loadCollections: true,
    loadObjects: true,
  });
  return { account, xhr };
}

function findCalendar(account, displayName) {
  return account.calendars.find(
    c => (c.displayName || '').toLowerCase() === (displayName || '').toLowerCase()
  );
}

function countEventsOnDate(objects, date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const next = new Date(target); next.setDate(next.getDate() + 1);
  let count = 0;
  for (const obj of (objects || [])) {
    if (!obj.calendarData) continue;
    try {
      const jcal = ICAL.parse(obj.calendarData);
      const comp = new ICAL.Component(jcal);
      const vevents = comp.getAllSubcomponents('vevent');
      for (const v of vevents) {
        const event = new ICAL.Event(v);
        const start = event.startDate.toJSDate();
        const end = event.endDate.toJSDate();
        if (start < next && end > target) { count += 1; break; }
      }
    } catch {}
  }
  return count;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { date, summary = '609 Booking', note = '' } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date required' });

    const d = dayjs(date).startOf('day');
    if (!d.isValid()) return res.status(400).json({ error: 'invalid date' });

    const { account, xhr } = await getAccount();
    const calB = findCalendar(account, BOOKINGS_CAL_NAME);
    const calX = findCalendar(account, BLACKOUTS_CAL_NAME);
    if (!calB || !calX) return res.status(500).json({ error: 'Calendars not found' });

    const booked = countEventsOnDate(calB.objects, d.toDate());
    const blackout = countEventsOnDate(calX.objects, d.toDate()) > 0;
    if (blackout || booked >= 2) {
      return res.status(409).json({ error: 'date not available' });
    }

    // Create an all-day event
    const dtStart = d.format('YYYYMMDD');
    const dtEnd = d.add(1, 'day').format('YYYYMMDD');
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@609music`;

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//609 Productions//Booking//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dayjs().utc().format('YYYYMMDDTHHmmss[Z]')}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:${summary}`,
      note ? `DESCRIPTION:${note.replace(/\n/g, '\\n')}` : '',
      'END:VEVENT',
      'END:VCALENDAR'
    ].filter(Boolean).join('\r\n');

    await dav.createObject(calB, { data: ics, filename: `${uid}.ics`, xhr });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, created: { date: d.format('YYYY-MM-DD'), uid } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'book failed' });
  }
}
