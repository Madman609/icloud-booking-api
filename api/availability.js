import dayjs from 'dayjs';
import * as ICAL from 'ical.js';
import { createDAVClient } from 'tsdav';

const {
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  BOOKINGS_CAL_NAME = 'Bookings',
  BLACKOUTS_CAL_NAME = 'Blackouts',
} = process.env;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to https://609music.com later
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
const requireEnv = () => {
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    throw new Error('Missing ICLOUD_USERNAME or ICLOUD_APP_PASSWORD');
  }
};

function countEventsOnDate(objects, date) {
  const startDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const nextDay = new Date(startDay); nextDay.setDate(nextDay.getDate() + 1);
  let count = 0;
  for (const obj of objects || []) {
    try {
      const jcal = ICAL.parse(obj.data);
      const comp = new ICAL.Component(jcal);
      const events = comp.getAllSubcomponents('vevent');
      for (const v of events) {
        const evt = new ICAL.Event(v);
        const s = evt.startDate.toJSDate();
        const e = evt.endDate.toJSDate();
        if (s < nextDay && e > startDay) { count++; break; }
      }
    } catch {}
  }
  return count;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    requireEnv();
    const { start, end } = req.query;
    if (!start) return res.status(400).json({ error: 'start required' });
    const startD = dayjs(start).startOf('day');
    const endD = dayjs(end || start).startOf('day');
    if (!startD.isValid() || !endD.isValid()) return res.status(400).json({ error: 'invalid dates' });

    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: {
        username: ICLOUD_USERNAME,
        password: ICLOUD_APP_PASSWORD,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    if (!Array.isArray(calendars) || calendars.length === 0) {
      return res.status(500).json({ error: 'No calendars found' });
    }
    const findCal = (name) =>
      calendars.find(c => (c.displayName || '').toLowerCase() === name.toLowerCase());

    const calBookings = findCal(BOOKINGS_CAL_NAME);
    const calBlackouts = findCal(BLACKOUTS_CAL_NAME);
    if (!calBookings || !calBlackouts) {
      return res.status(500).json({ error: 'Calendars not found', names: calendars.map(c => c.displayName) });
    }

    // Fetch objects for the whole span from both calendars
   const startISO = startD.toDate().toISOString();
   const endISO = endD.add(1, 'day').toDate().toISOString();
   const timeRange = { start: startISO, end: endISO };
    };

    const [bookingObjs, blackoutObjs] = await Promise.all([
      client.fetchCalendarObjects({ calendar: calBookings, timeRange }),
      client.fetchCalendarObjects({ calendar: calBlackouts, timeRange }),
    ]);

    const days = [];
    for (let d = startD; d.isBefore(endD.add(1, 'day')); d = d.add(1, 'day')) {
      const js = d.toDate();
      const booked = countEventsOnDate(bookingObjs, js);
      const blackout = countEventsOnDate(blackoutObjs, js) > 0;
      days.push({
        date: d.format('YYYY-MM-DD'),
        available: !blackout && booked <= 1,
        blackout,
        bookedCount: booked,
        rule: 'available if not blacked out AND bookedCount ≤ 1',
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ days });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'availability failed', detail: String(e?.message || e) });
  }
}
