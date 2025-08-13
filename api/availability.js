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

/**
 * Count events that overlap the given local day.
 * Also detect "short recording" if any summary matches `Recording Session (Xh)` with X < 4.
 */
function analyzeEventsForDate(objects, date) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  let count = 0;
  let shortRecording = false;

  for (const obj of objects || []) {
    try {
      const jcal = ICAL.parse(obj.data);
      const comp = new ICAL.Component(jcal);
      const events = comp.getAllSubcomponents('vevent');

      for (const sub of events) {
        const ev = new ICAL.Event(sub);
        const s = ev.startDate.toJSDate();
        const e = ev.endDate.toJSDate();

        // Overlap test
        if (s < dayEnd && e > dayStart) {
          count++;

          // Short recording detection from SUMMARY
          const summary = (ev.summary || '').toString();
          const m = summary.match(/Recording Session\s*\((\d+)h\)/i);
          if (m) {
            const hours = parseInt(m[1], 10);
            if (Number.isFinite(hours) && hours < 4) shortRecording = true;
          }

          break; // move to next object once we counted it
        }
      }
    } catch {
      // ignore malformed items
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

    // --- DAV client
    let client;
    try {
      client = await createDAVClient({
        serverUrl: 'https://caldav.icloud.com',
        credentials: { username: ICLOUD_USERNAME, password: ICLOUD_APP_PASSWORD },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
    } catch (e) {
      return res.status(500).json({ error: 'createDAVClient failed', detail: String(e?.message || e) });
    }

    // --- Calendars
    let calendars;
    try {
      calendars = await client.fetchCalendars();
    } catch (e) {
      return res.status(500).json({ error: 'fetchCalendars failed', detail: String(e?.message || e) });
    }
    if (!Array.isArray(calendars) || calendars.length === 0) {
      return res.status(500).json({ error: 'No calendars found' });
    }

    const findCal = (name) =>
      calendars.find(c => (c.displayName || '').toLowerCase() === String(name).toLowerCase());

    const calBookings = findCal(BOOKINGS_CAL_NAME);
    const calBlackouts = findCal(BLACKOUTS_CAL_NAME);
    if (!calBookings || !calBlackouts) {
      return res.status(500).json({
        error: 'Calendars not found',
        names: calendars.map(c => c.displayName)
      });
    }

    // --- Time range (buffer by ±1 day to catch all-day/tz edge cases)
    const startISO = startD.subtract(1, 'day').toDate().toISOString();
    const endISO = endD.add(2, 'day').toDate().toISOString();
    const timeRange = { start: startISO, end: endISO };

    // --- Fetch objects in buffered range
    let bookingObjs = [], blackoutObjs = [];
    try {
      [bookingObjs, blackoutObjs] = await Promise.all([
        client.fetchCalendarObjects({ calendar: calBookings, timeRange }),
        client.fetchCalendarObjects({ calendar: calBlackouts, timeRange }),
      ]);
    } catch (e) {
      return res.status(500).json({ error: 'fetchCalendarObjects failed', detail: String(e?.message || e) });
    }

    // --- Build per-day results
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
    return res.status(200).json({ days });
  } catch (e) {
    return res.status(500).json({
      error: 'availability crashed',
      detail: String(e?.message || e)
    });
  }
}
