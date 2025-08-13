// api/availability.js
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
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to https://609music.com in prod
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function needEnv() {
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    throw new Error('Missing ICLOUD_USERNAME or ICLOUD_APP_PASSWORD');
  }
}

function pickICS(obj) {
  // tsdav can surface ICS as `data`, `calendarData`, or nested in props
  if (obj?.data) return obj.data;
  if (obj?.calendarData) return obj.calendarData;
  if (obj?.props) {
    // common prop key names
    if (obj.props['calendar-data']) return obj.props['calendar-data'];
    if (obj.props['calendardata']) return obj.props['calendardata'];
  }
  return null;
}

/** Analyze overlap against a local day and detect short (<4h) recording sessions by SUMMARY text. */
function analyzeEventsForDate(objects, date) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  let count = 0;
  let shortRecording = false;

  for (const obj of objects || []) {
    const ics = pickICS(obj);
    if (!ics) continue;

    try {
      const jcal = ICAL.parse(ics);
      const comp = new ICAL.Component(jcal);
      const events = comp.getAllSubcomponents('vevent');

      for (const sub of events) {
        const ev = new ICAL.Event(sub);
        const s = ev.startDate.toJSDate();
        const e = ev.endDate.toJSDate();

        // overlap with this local day?
        if (s < dayEnd && e > dayStart) {
          count++;

          const summary = (ev.summary || '').toString();
          const m = summary.match(/Recording Session\s*\((\d+)h\)/i);
          if (m) {
            const hours = parseInt(m[1], 10);
            if (Number.isFinite(hours) && hours < 4) shortRecording = true;
          }
          break; // count an obj at most once per day
        }
      }
    } catch {
      // ignore malformed ICS
    }
  }

  return { count, shortRecording };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    needEnv();

    const { start, end } = req.query || {};
    if (!start) return res.status(400).json({ error: 'start required' });

    const startD = dayjs(start).startOf('day');
    const endD = dayjs(end || start).startOf('day');
    if (!startD.isValid() || !endD.isValid()) {
      return res.status(400).json({ error: 'invalid dates' });
    }

    // DAV client
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
      return res.status(500).json({ error: 'Calendars not found', names: calendars.map(c => c.displayName) });
    }

    // Buffer ±1 day to catch all-day/tz edges; and ask tsdav to expand instances
    const timeRange = {
      start: startD.subtract(1, 'day').toDate().toISOString(),
      end:   endD.add(2, 'day').toDate().toISOString(),
    };

    const [bookingObjs, blackoutObjs] = await Promise.all([
      client.fetchCalendarObjects({ calendar: calBookings, timeRange, expand: true }),
      client.fetchCalendarObjects({ calendar: calBlackouts, timeRange, expand: true }),
    ]);

    const days = [];
    for (let d = startD; d.isBefore(endD.add(1, 'day')); d = d.add(1, 'day')) {
      const js = d.toDate();

      const { count: bookedCount, shortRecording } = analyzeEventsForDate(bookingObjs, js);
      const blackout = analyzeEventsForDate(blackoutObjs, js).count > 0;

      days.push({
        date: d.format('YYYY-MM-DD'),
        available: !blackout && bookedCount <= 1 && !shortRecording,
        blackout,
        bookedCount,
        shortRecording,
        rule: 'available if NOT blackout AND bookedCount ≤ 1 AND NO recording session < 4h'
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ days });
  } catch (e) {
    res.status(500).json({ error: 'availability crashed', detail: String(e?.message || e) });
  }
}
