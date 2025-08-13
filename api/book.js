// api/book.js  (Vercel Node runtime, ESM)

// 🔧 Fix: enable Day.js UTC plugin (needed for .utc())
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
dayjs.extend(utc);

import { createDAVClient } from 'tsdav';

export const config = { runtime: 'nodejs' };

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
  res.setHeader('Cache-Control', 'no-store');
}

const requireEnv = () => {
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    throw new Error('Missing ICLOUD_USERNAME or ICLOUD_APP_PASSWORD');
  }
};

// Build a simple all-day ICS event (local all-day date, UTC DTSTAMP)
function buildICS({ uid, date, summary, note }) {
  // `date` will be a Day.js object pointing to local midnight for that day
  const dtStart = dayjs(date).format('YYYYMMDD');                 // all-day start (local)
  const dtEnd   = dayjs(date).add(1, 'day').format('YYYYMMDD');   // all-day end (local next day)

  // DTSTAMP must be in UTC per spec
  const stamp = dayjs().utc().format('YYYYMMDDTHHmmss[Z]');

  const desc = note
    ? `DESCRIPTION:${String(note).replace(/\r?\n/g, '\\n')}`
    : '';

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
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    requireEnv();

    const { date, summary = '609 Booking', note = '' } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date required' });

    // Parse the YYYY-MM-DD coming from the client as a local date (no time)
    const d = dayjs(date, 'YYYY-MM-DD').startOf('day');
    if (!d.isValid()) return res.status(400).json({ error: 'invalid date' });

    // Connect to iCloud CalDAV
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
      });
    }

    // Capacity / blackout check for that local day
    const timeRange = {
      start: d.toDate().toISOString(),
      end: d.add(1, 'day').toDate().toISOString(),
    };

    const [bookingObjs, blackoutObjs] = await Promise.all([
      client.fetchCalendarObjects({ calendar: calBookings, timeRange }),
      client.fetchCalendarObjects({ calendar: calBlackouts, timeRange }),
    ]);

    const bookedCount = bookingObjs?.length || 0;
    const isBlackout = (blackoutObjs?.length || 0) > 0;

    if (isBlackout || bookedCount >= 2) {
      return res.status(409).json({ error: 'date not available', bookedCount, isBlackout });
    }

    // Create all-day booking
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@609music`;
    const ics = buildICS({ uid, date: d, summary, note });

    await client.createCalendarObject({
      calendar: calBookings,
      filename: `${uid}.ics`,
      iCalString: ics,
    });

    return res.status(200).json({
      ok: true,
      created: { date: d.format('YYYY-MM-DD'), uid }
    });
  } catch (e) {
    console.error('[book] error:', e);
    return res.status(500).json({ error: 'book failed', detail: String(e?.message || e) });
  }
}
