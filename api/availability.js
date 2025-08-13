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

/* ---------------- CORS ---------------- */
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

/* -------------- Time helpers -------------- */
function overlaps(s1, e1, s2, e2) { return s1 < e2 && e1 > s2; }
function startOfDay(js) { return new Date(js.getFullYear(), js.getMonth(), js.getDate()); }
function endOfDay(js) { const d = startOfDay(js); d.setDate(d.getDate()+1); return d; }

/* -------------- ICS extraction -------------- */
function getICSFromObj(obj) {
  // tsdav variants / server variants
  return obj?.data || obj?.calendarData || obj?.iCalString || '';
}

/* Primary parse via ical.js */
function extractEvents_icaljs(ics) {
  try {
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    return comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v))
      .map(ev => {
        const s = ev.startDate?.toJSDate?.();
        const e = ev.endDate?.toJSDate?.();
        if (!s || !e) return null;
        const summary = String(ev.summary || '');
        return { start: s, end: e, summary };
      })
      .filter(Boolean);
  } catch {
    return null; // signal failure so we try regex fallback
  }
}

/* Fallback parse using regex (robust for VALUE=DATE all-day entries) */
function extractEvents_regex(ics) {
  const blocks = String(ics).split(/BEGIN:VEVENT/).slice(1).map(b => 'BEGIN:VEVENT' + b.split('END:VEVENT')[0] + 'END:VEVENT');
  const evs = [];
  for (const b of blocks) {
    // DTSTART / DTEND (support VALUE=DATE and DATE-TIME)
    const mStart = b.match(/DTSTART(?:;VALUE=DATE)?:(\d{8})(?:T(\d{6})Z)?/);
    const mEnd   = b.match(/DTEND(?:;VALUE=DATE)?:(\d{8})(?:T(\d{6})Z)?/);
    if (!mStart) continue;

    let s, e;
    if (mStart && mStart[2]) {
      // date-time Z
      const y = mStart[1].slice(0,4), mo = mStart[1].slice(4,6), d = mStart[1].slice(6,8);
      const hh = mStart[2].slice(0,2), mi = mStart[2].slice(2,4), ss = mStart[2].slice(4,6);
      s = new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss}Z`);
    } else {
      // all-day local
      const y = mStart[1].slice(0,4), mo = mStart[1].slice(4,6), d = mStart[1].slice(6,8);
      s = new Date(Number(y), Number(mo)-1, Number(d));
    }

    if (mEnd && mEnd[2]) {
      const y = mEnd[1].slice(0,4), mo = mEnd[1].slice(4,6), d = mEnd[1].slice(6,8);
      const hh = mEnd[2].slice(0,2), mi = mEnd[2].slice(2,4), ss = mEnd[2].slice(4,6);
      e = new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss}Z`);
    } else if (mEnd) {
      // all-day DTEND is exclusive per RFC — treat as local midnight next day
      const y = mEnd[1].slice(0,4), mo = mEnd[1].slice(4,6), d = mEnd[1].slice(6,8);
      e = new Date(Number(y), Number(mo)-1, Number(d));
    } else {
      // No DTEND: assume same-day all-day
      e = new Date(s);
      e.setDate(e.getDate() + 1);
    }

    const sum = (b.match(/SUMMARY:(.*)/) || [,''])[1].trim();
    evs.push({ start: s, end: e, summary: sum });
  }
  return evs;
}

/* Count events (with fallback) */
function countEventsOnDate(objects, jsDate) {
  const dayStart = startOfDay(jsDate);
  const dayEnd   = endOfDay(jsDate);

  let count = 0;
  for (const obj of objects || []) {
    const ics = getICSFromObj(obj);
    if (!ics) continue;

    let events = extractEvents_icaljs(ics);
    if (!events) events = extractEvents_regex(ics);

    for (const ev of events) {
      if (!ev?.start || !ev?.end) continue;
      if (overlaps(ev.start, ev.end, dayStart, dayEnd)) { count++; break; }
    }
  }
  return count;
}

/* Detect “Recording Session (Nh)” with N<4 on that date */
function hasShortRecording(objects, jsDate) {
  const dayStart = startOfDay(jsDate);
  const dayEnd   = endOfDay(jsDate);

  for (const obj of objects || []) {
    const ics = getICSFromObj(obj);
    if (!ics) continue;

    let events = extractEvents_icaljs(ics);
    if (!events) events = extractEvents_regex(ics);

    for (const ev of events) {
      if (!ev?.start || !ev?.end) continue;
      if (!overlaps(ev.start, ev.end, dayStart, dayEnd)) continue;
      const m = String(ev.summary || '').match(/Recording\s+Session\s*\((\d+)\s*h\)/i);
      if (m) {
        const hours = parseInt(m[1], 10);
        if (!Number.isNaN(hours) && hours < 4) return true;
      }
    }
  }
  return false;
}

/* ---------------- Handler ---------------- */
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

    // 1) DAV client
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
      return res.status(500).json({ error: 'Calendars not found', names: calendars.map(c => c.displayName) });
    }

    // 3) Time range
    const startISO = startD.toDate().toISOString();
    const endISO   = endD.add(1, 'day').toDate().toISOString();
    const timeRange = { start: startISO, end: endISO };

    // 4) Objects within range
    let bookingObjs = [], blackoutObjs = [];
    try {
      [bookingObjs, blackoutObjs] = await Promise.all([
        client.fetchCalendarObjects({ calendar: calBookings,  timeRange }),
        client.fetchCalendarObjects({ calendar: calBlackouts, timeRange }),
      ]);
    } catch (e) {
      return res.status(500).json({ error: 'fetchCalendarObjects failed', detail: String(e?.message || e) });
    }

    // 5) Per-day result
    const endExclusive = endD.add(1, 'day');
    const days = [];
    for (let d = startD; d.isBefore(endExclusive); d = d.add(1, 'day')) {
      const js = d.toDate();
      const bookedCount    = countEventsOnDate(bookingObjs, js);
      const blackout       = countEventsOnDate(blackoutObjs, js) > 0;
      const shortRecording = hasShortRecording(bookingObjs, js);
      const available      = !blackout && bookedCount <= 1 && !shortRecording;

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

    if (String(debug).toLowerCase() === 'true') {
      const perDay = [];
      for (const day of days) {
        const js = new Date(day.date + 'T00:00:00');
        const bookingsExtracted = [];
        const blackoutsExtracted = [];

        for (const obj of bookingObjs || []) {
          const ics = getICSFromObj(obj); if (!ics) continue;
          let events = extractEvents_icaljs(ics); if (!events) events = extractEvents_regex(ics);
          for (const ev of events) {
            if (overlaps(ev.start, ev.end, startOfDay(js), endOfDay(js))) {
              bookingsExtracted.push({
                summary: String(ev.summary || ''),
                start: ev.start.toISOString(),
                end: ev.end.toISOString()
              });
            }
          }
        }
        for (const obj of blackoutObjs || []) {
          const ics = getICSFromObj(obj); if (!ics) continue;
          let events = extractEvents_icaljs(ics); if (!events) events = extractEvents_regex(ics);
          for (const ev of events) {
            if (overlaps(ev.start, ev.end, startOfDay(js), endOfDay(js))) {
              blackoutsExtracted.push({
                summary: String(ev.summary || ''),
                start: ev.start.toISOString(),
                end: ev.end.toISOString()
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
          counts: { bookingsFetched: bookingObjs?.length || 0, blackoutsFetched: blackoutObjs?.length || 0 },
          perDay,
          timeRange: { start: startISO, end: endISO }
        }
      });
    }

    return res.status(200).json({ days });
  } catch (e) {
    return res.status(500).json({ error: 'availability crashed', detail: String(e?.message || e) });
  }
}
