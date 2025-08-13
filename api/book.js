// api/book.js
// Node runtime (required for tsdav). Creates an all-day event in iCloud "Bookings" calendar
// after checking "Blackouts" and ensuring <= 1 existing booking for that date.

export const config = { runtime: 'nodejs' };

import dayjs from 'dayjs';
import { createDAVClient } from 'tsdav';

const {
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  BOOKINGS_CAL_NAME = 'Bookings',
  BLACKOUTS_CAL_NAME = 'Blackouts',
  CORS_ALLOW_ORIGIN = 'https://609music.com', // you can set this in Vercel; keep "*" while testing if needed
} = process.env;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // browsers like to see this so responses can be cached safely by default
  res.setHeader('Cache-Control', 'no-store');
}

function requireEnv() {
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    throw new Error('Missing ICLOUD_USERNAME or ICLOUD_APP_PASSWORD');
  }
}

function buildICS({ uid, dateISO, summary, note }) {
  const d0 = dayjs(dateISO);                          // local date (start-of-day)
  const dtStart = d0.format('YYYYMMDD');
  const dtEnd = d0.add(1, 'day').format('YYYYMMDD');  // all-day event ends next day
  const stamp = dayjs().utc().format('YYYYMMDDTHHmmss[Z]');
  const desc = note ? `DESCRIPTION:${String(note).replace(/\r?\n/g, '\\n')}` : '';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//609 Productions//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dtStart}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `SUMMARY:${summary}`,
    desc,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    requireEnv();

    const { date, summary = '609 Booking', note = '' } = req.body || {};
    // Expect "YYYY-MM-DD"
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    }
    const d = dayjs(date);
    if (!d.isValid()) return res.status(400).json({ error: 'invalid date' });

    // Connect to iCloud via CalDAV
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    const findCal = (name) =>
      calendars.find(c => (c.displayName || '').toLowerCase() === String(name).toLowerCase());

    const calBookings = findCal(BOOKINGS_CAL_NAME);
    const calBlackouts = findCal(BLACKOUTS_CAL_NAME);

    if (!calBookings || !calBlackouts) {
      return res.status(500).json({
        error: 'Calendars not found',
        names: calendars.map(c => c.displayName),
        expected: { BOOKINGS_CAL_NAME, BLACKOUTS_CAL_NAME },
      });
    }

    // Capacity / blackout check for the selected day (local midnight → +1 day)
    const timeRange = {
      start: d.startOf('day').toDate().toISOString(),
      end: d.startOf('day').add(1, 'day').toDate().toISOString(),
    };

    const [bookingObjs, blackoutObjs] = await Promise.all([
      client.fetchCalendarObjects({ calendar: calBookings, timeRange }),
      client.fetchCalendarObjects({ calendar: calBlackouts, timeRange }),
    ]);

    const bookedCount = bookingObjs?.length || 0;
    const isBlackout = (blackoutObjs?.length || 0) > 0;

    // Rule: available if not blacked out AND bookedCount ≤ 1
    if (isBlackout || bookedCount >= 2) {
      return res.status(409).json({ error: 'date not available', bookedCount, isBlackout });
    }

    // Create all-day booking
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@609music`;
    const ics = buildICS({ uid, dateISO: date, summary, note });

    await client.createCalendarObject({
      calendar: calBookings,
      filename: `${uid}.ics`,
      iCalString: ics,
    });

    return res.status(200).json({
      ok: true,
      created: { date, uid },
    });
  } catch (e) {
    console.error('[book] error:', e);
    return res.status(500).json({ error: 'book failed', detail: String(e?.message || e) });
  }
}
