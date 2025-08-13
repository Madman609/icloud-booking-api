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
  if (!obj) return null;
  if (typeof obj.data === 'string') return obj.data;
  if (typeof obj.calendarData === 'string') return obj.calendarData;
  if (obj.props) {
    if (typeof obj.props['calendar-data'] === 'string') return obj.props['calendar-data'];
    if (typeof obj.props['calendardata'] === 'string') return obj.props['calendardata'];
  }
  if (obj.objectData && typeof obj.objectData.calendarData === 'string') {
    return obj.objectData.calendarData;
  }
  return null;
}

async function hydrateICS(client, calendar, objs) {
  const out = [];
  for (const o of objs || []) {
    let ics = pickICS(o);
    let hydrated = false;
    if (!ics) {
      try {
        const one = await client.fetchCalendarObject({
          calendar,
          objectUrl: o.url || o.href || o.path,
        });
        ics = pickICS(one) || pickICS(one?.object) || null;
        hydrated = !!ics;
      } catch {
        // ignore
      }
    }
    out.push({ ...o, __ics: ics || null, __hydrated: hydrated });
  }
  return out;
}

function analyzeForDate(objs, date) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  let count = 0;
  let shortRecording = false;
  const summaries = [];

  for (const obj of objs || []) {
    const ics = obj.__ics || pickICS(obj);
    if (!ics) continue;

    try {
      const jcal = ICAL.parse(ics);
      const comp = new ICAL.Component(jcal);
      const events = comp.getAllSubcomponents('vevent');
      for (const sub of events) {
        const ev = new ICAL.Event(sub);
        const s = ev.startDate.toJSDate();
        const e = ev.endDate.toJSDate();
        if (s < dayEnd && e > dayStart) {
          count++;
          const summary = String(ev.summary || '').slice(0, 140);
          summaries.push(summary);
          const m = summary.match(/Recording Session\s*\((\d+)h\)/i);
          if (m) {
            const hrs = parseInt(m[1], 10);
            if (Number.isFinite(hrs) && hrs < 4) shortRecording = true;
          }
          break;
        }
      }
    } catch {
      // skip malformed
    }
  }

  return { count, shortRecording, summaries };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    needEnv();

    const { start, end, debug } = req.query || {};
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

    const allCalNames = (calendars || []).map(c => ({
      displayName: c.displayName,
      url: c.url || c.href || c.path,
      components: c.components,
      accountType: c.accountType,
    }));

    const findCal = (name) =>
      calendars.find(c => (c.displayName || '').toLowerCase() === String(name).toLowerCase());

    const calBookings = findCal(BOOKINGS_CAL_NAME);
    const calBlackouts = findCal(BLACKOUTS_CAL_NAME);

    if (!calBookings || !calBlackouts) {
      return res.status(500).json({
        error: 'Calendars not found',
        requested: { BOOKINGS_CAL_NAME, BLACKOUTS_CAL_NAME },
        available: allCalNames,
      });
    }

    const timeRange = {
      start: startD.subtract(1, 'day').toDate().toISOString(),
      end:   endD.add(2, 'day').toDate().toISOString(),
    };

    let bookingsRaw = [];
    let blackoutsRaw = [];
    try {
      const [b, k] = await Promise.all([
        client.fetchCalendarObjects({
          calendar: calBookings,
          timeRange,
          expand: true,
          objectData: true,
        }),
        client.fetchCalendarObjects({
          calendar: calBlackouts,
          timeRange,
          expand: true,
          objectData: true,
        }),
      ]);
      bookingsRaw = await hydrateICS(client, calBookings, b || []);
      blackoutsRaw = await hydrateICS(client, calBlackouts, k || []);
    } catch (e) {
      return res.status(500).json({ error: 'fetchCalendarObjects failed', detail: String(e?.message || e) });
    }

    const days = [];
    const perDayDebug = [];

    for (let d = startD; d.isBefore(endD.add(1, 'day')); d = d.add(1, 'day')) {
      const js = d.toDate();

      const A = analyzeForDate(bookingsRaw, js);
      const B = analyzeForDate(blackoutsRaw, js);
      const bookedCount = A.count;
      const blackout = B.count > 0;
      const shortRecording = A.shortRecording;

      days.push({
        date: d.format('YYYY-MM-DD'),
        available: !blackout && bookedCount <= 1 && !shortRecording,
        blackout,
        bookedCount,
        shortRecording,
        rule: 'available if NOT blackout AND bookedCount ≤ 1 AND NO recording session < 4h',
      });

      if (debug) {
        perDayDebug.push({
          date: d.format('YYYY-MM-DD'),
          bookingSummaries: A.summaries,
          blackoutSummaries: B.summaries,
        });
      }
    }

    const payload = { days };
    if (debug) {
      payload.debug = {
        requested: { BOOKINGS_CAL_NAME, BLACKOUTS_CAL_NAME },
        resolvedCalendars: {
          bookings: {
            displayName: calBookings.displayName,
            url: calBookings.url || calBookings.href || calBookings.path,
          },
          blackouts: {
            displayName: calBlackouts.displayName,
            url: calBlackouts.url || calBlackouts.href || calBlackouts.path,
          },
        },
        counts: {
          bookingsFetched: bookingsRaw.length,
          blackoutsFetched: blackoutsRaw.length,
          bookingsWithICS: bookingsRaw.filter(o => !!o.__ics).length,
          blackoutsWithICS: blackoutsRaw.filter(o => !!o.__ics).length,
          bookingsHydrated: bookingsRaw.filter(o => o.__hydrated).length,
          blackoutsHydrated: blackoutsRaw.filter(o => o.__hydrated).length,
        },
        allCalendars: allCalNames,
        perDay: perDayDebug,
        timeRange,
      };
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'availability crashed', detail: String(e?.message || e) });
  }
}
