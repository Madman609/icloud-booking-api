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

/* ---- CORS ---- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to https://609music.com later
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function needEnv() {
  if (!ICLOUD_USERNAME || !ICLOUD_APP_PASSWORD) {
    throw new Error('Missing ICLOUD_USERNAME or ICLOUD_APP_PASSWORD');
  }
}

/* ---- Helpers ---- */
function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
}

function getICSFromObj(obj) {
  // tsdav / servers can surface data under different keys — support them all
  return obj?.data || obj?.calendarData || obj?.iCalString || '';
}

function extractEventsFromICS(ics) {
  try {
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    return comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v));
  } catch {
    return [];
  }
}

function countEventsOnDate(objects, jsDate) {
  const dayStart = new Date(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate());
  const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  let count = 0;
  for (const obj of objects || []) {
    const ics = getICSFromObj(obj);
    if (!ics) continue;

    const events = extractEventsFromICS(ics);
    for (const ev of events) {
      const s = ev.startDate?.toJSDate?.();
      const e = ev.endDate?.toJSDate?.();
      if (!s || !e) continue;
      if (overlaps(s, e, dayStart, dayEnd)) { count++; break; }
    }
  }
  return count;
}

function hasShortRecording(objects, jsDate) {
  const dayStart = new Date(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate());
  const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  for (const obj of objects || []) {
    const ics = getICSFromObj(obj);
    if (!ics) continue;

    const events = extractEventsFromICS(ics);
    for (const ev of events) {
      const s = ev.startDate?.toJSDate?.();
      const e = ev.endDate?.toJSDate?.();
      if (!s || !e) continue;
      if (!overlaps(s, e, dayStart, dayEnd)) continue;

      const summary = String(ev.summary || '');
      // Match "Recording Session (Nh)"
      const m = summary.match(/Recording\s+Session\s*\((\d+)\s*h\)/i);
      if (m) {
        const hours = parseInt(m[1], 10);
        if (!Number.isNaN(hours) && hours < 4) return true;
      }
    }
  }
  return false;
}

/* ---- Handler ---- */
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    needEnv();

    const { start, end, debug } = req.query || {};
    if (!start) return res.status(400).json({ error: 'start required' });

    const startD = dayjs(start).startOf('day');
    const endD   = dayjs(end || start).startOf('day');
    if (!startD.isValid() || !endD.isValid()) {
      return res.status(400).json({ error: 'invalid dates' });
    }

    // 1) CalDAV client
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

    // 2) Calendars
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

    // 3) Time range
    const startISO = startD.toDate().toISOString();
    const endISO   = endD.add(1, 'day').toDate().toISOString();
    const timeRange = { start: startISO, end: endISO };

    // 4) Objects in range
    let bookingObjs = [], blackoutObjs = [];
    try {
      [bookingObjs, blackoutObjs] = await Promise.all([
        client.fetchCalendarObjects({ calendar: calBookings,  timeRange }),
        client.fetchCalendarObjects({ calendar: calBlackouts, timeRange }),
      ]);
    } catch (e) {
      return res.status(500).json({ error: 'fetchCalendarObjects failed', detail: String(e?.message || e) });
    }

    // 5) Per-day availability (no UI text here)
    const endExclusive = endD.add(1, 'day'); // don’t mutate endD itself
    const days = [];
    for (let d = startD; d.isBefore(endExclusive); d = d.add(1, 'day')) {
      const js = d.toDate();
      const bookedCount    = countEventsOnDate(bookingObjs, js);
      const blackout       = countEventsOnDate(blackoutObjs, js) > 0;
      const shortRecording = hasShortRecording(bookingObjs, js);

      const available = !blackout && bookedCount <= 1 && !shortRecording;

      days.push({
        date: d.format('YYYY-MM-DD'),
        available,
        blackout,
        bookedCount,
        shortRecording,
        rule: 'available if NOT blackout AND bookedCount ≤ 1 AND NO recording session < 4h'
      });
    }

    res.setHeader('Cache-Control', 'no-store');

    // Optional debug to help verify what the server saw
    if (String(debug).toLowerCase() === 'true') {
      const perDay = [];
      for (const day of days) {
        const js = new Date(day.date + 'T00:00:00');
        const bookingsExtracted = [];
        const blackoutsExtracted = [];

        for (const obj of bookingObjs || []) {
          const ics = getICSFromObj(obj);
          if (!ics) continue;
          const events = extractEventsFromICS(ics);
          for (const ev of events) {
            const s = ev.startDate?.toJSDate?.();
            const e = ev.endDate?.toJSDate?.();
            if (!s || !e) continue;
            if (overlaps(s, e, js, new Date(js.getTime() + 86400000))) {
              bookingsExtracted.push({
                summary: String(ev.summary || ''),
                start: s.toISOString(),
                end: e.toISOString()
              });
            }
          }
        }
        for (const obj of blackoutObjs || []) {
          const ics = getICSFromObj(obj);
          if (!ics) continue;
          const events = extractEventsFromICS(ics);
          for (const ev of events) {
            const s = ev.startDate?.toJSDate?.();
            const e = ev.endDate?.toJSDate?.();
            if (!s || !e) continue;
            if (overlaps(s, e, js, new Date(js.getTime() + 86400000))) {
              blackoutsExtracted.push({
                summary: String(ev.summary || ''),
                start: s.toISOString(),
                end: e.toISOString()
              });
            }
          }
        }
        perDay.push({ date: day.date, bookingsExtracted, blackoutsExtracted });
      }

      return res.status(200).json({
        days,
        debug: {
          requested: { BOOKINGS_CAL_NAME, BLACKOUTS_CAL_NAME },
          resolvedCalendars: {
            bookings: { displayName: calBookings.displayName, url: calBookings.url },
            blackouts: { displayName: calBlackouts.displayName, url: calBlackouts.url }
          },
          counts: {
            bookingsFetched: bookingObjs?.length || 0,
            blackoutsFetched: blackoutObjs?.length || 0
          },
          perDay,
          timeRange: { start: startISO, end: endISO }
        }
      });
    }

    return res.status(200).json({ days });
  } catch (e) {
    return res.status(500).json({
      error: 'availability crashed',
      detail: String(e?.message || e)
    });
  }
}
