// api/availability.js
import dayjs from 'dayjs';
import ICAL from 'ical.js';
// or:
// import { parse as icalParse, Component as ICALComponent, Event as ICALEvent } from 'ical.js';
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

/** Convert many possible shapes into a UTF-8 string (or null) */
function toUtf8String(maybe) {
  if (!maybe) return null;
  if (typeof maybe === 'string') return maybe;

  // Node Buffer-like: { type: 'Buffer', data: [...] }
  if (typeof maybe === 'object' && maybe.type === 'Buffer' && Array.isArray(maybe.data)) {
    try { return Buffer.from(maybe.data).toString('utf8'); } catch { /* ignore */ }
  }

  // ArrayBuffer / Uint8Array
  if (typeof ArrayBuffer !== 'undefined' && (maybe instanceof ArrayBuffer || ArrayBuffer.isView?.(maybe))) {
    try {
      const view = maybe instanceof ArrayBuffer ? new Uint8Array(maybe) : new Uint8Array(maybe.buffer);
      return new TextDecoder('utf-8').decode(view);
    } catch { /* ignore */ }
  }

  // Common nested containers
  // - tsdav often uses objectData.calendarData or .data
  if (maybe && typeof maybe === 'object') {
    if (typeof maybe.calendarData === 'string') return maybe.calendarData;
    if (typeof maybe['calendar-data'] === 'string') return maybe['calendar-data'];
    if (typeof maybe.data === 'string') return maybe.data;
    if (maybe.objectData) {
      const s = toUtf8String(maybe.objectData);
      if (s) return s;
    }
    if (maybe.object) {
      const s = toUtf8String(maybe.object);
      if (s) return s;
    }
    if (maybe.props) {
      // Some servers stash it under props.* keys
      const c1 = toUtf8String(maybe.props['calendar-data']);
      if (c1) return c1;
      const c2 = toUtf8String(maybe.props['calendardata']);
      if (c2) return c2;
      const c3 = toUtf8String(maybe.props['calendarData']);
      if (c3) return c3;
    }
  }

  return null;
}

/** Try all known places to pull an ICS string from a tsdav object */
function pickICS(obj) {
  if (!obj) return null;
  // direct
  let s = toUtf8String(obj);
  if (s) return s;
  // known fields
  s = toUtf8String(obj.data) || toUtf8String(obj.calendarData) || toUtf8String(obj['calendar-data']);
  if (s) return s;
  // object/objectData wrappers
  s = toUtf8String(obj.objectData) || toUtf8String(obj.object);
  if (s) return s;
  // props variations
  if (obj.props) {
    s = toUtf8String(obj.props['calendar-data']) || toUtf8String(obj.props['calendardata']) || toUtf8String(obj.props['calendarData']);
    if (s) return s;
  }
  return null;
}

/** If ICS is missing inline, fetch the object by URL to hydrate */
async function hydrateICS(client, calendar, objs) {
  const out = [];
  for (const o of objs || []) {
    let ics = pickICS(o);
    let hydrated = false;
    if (!ics) {
      const objUrl = o.url || o.href || o.path || o.objectUrl;
      if (objUrl) {
        try {
          const one = await client.fetchCalendarObject({
            calendar,
            objectUrl: objUrl,
          });
          ics = pickICS(one) || pickICS(one?.object) || pickICS(one?.objectData) || pickICS(one?.data) || null;
          hydrated = !!ics;
        } catch {
          // ignore, keep null
        }
      }
    }
    out.push({ ...o, __ics: ics || null, __hydrated: hydrated });
  }
  return out;
}

/** Normalize all-day / odd DTEND events and return JS dates */
function normalizeRange(ev) {
  const s = ev.startDate; // ICAL.Time
  const e = ev.endDate;
  let sJS = s?.toJSDate?.() || null;
  let eJS = e?.toJSDate?.() || null;
  const isAllDay = !!s?.isDate;

  if (isAllDay) {
    // iCloud all-day can have DTEND equal to DTSTART or missing — treat as one day
    if (!eJS || +eJS <= +sJS) {
      eJS = new Date(sJS.getFullYear(), sJS.getMonth(), sJS.getDate() + 1);
    } else {
      // some all-day events already have next-day DTEND; keep as-is
    }
  }
  return { sJS, eJS, isAllDay };
}

function analyzeForDate(objs, date, debugList) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  let count = 0;
  let shortRecording = false;
  const summaries = [];

  for (const obj of objs || []) {
    const ics = obj.__ics || pickICS(obj);
    if (!ics) {
      if (debugList) debugList.push({ note: 'no-ics', url: obj.url || obj.href || obj.path || null });
      continue;
    }

    try {
      // Quick sanity preview for debug (don’t leak full ICS)
      const preview = ics.slice(0, 120);

      const jcal = ICAL.parse(ics);
      const comp = new ICAL.Component(jcal);
      const events = comp.getAllSubcomponents('vevent');
      if (!events || !events.length) {
        if (debugList) debugList.push({ note: 'no-vevent', preview });
        continue;
      }

      for (const sub of events) {
        const ev = new ICAL.Event(sub);
        const { sJS, eJS, isAllDay } = normalizeRange(ev);
        if (!sJS || !eJS) {
          if (debugList) debugList.push({ note: 'bad-range', summary: String(ev.summary || ''), preview });
          continue;
        }

        const summary = String(ev.summary || '').slice(0, 160);

        // Overlap test
        if (sJS < dayEnd && eJS > dayStart) {
          count++;
          summaries.push(summary);
          const m = summary.match(/Recording Session\s*\((\d+)h\)/i);
          if (m) {
            const hrs = parseInt(m[1], 10);
            if (Number.isFinite(hrs) && hrs < 4) shortRecording = true;
          }
          if (debugList) {
            debugList.push({
              summary,
              isAllDay,
              starts: sJS.toISOString(),
              ends: eJS.toISOString(),
              preview,
            });
          }
          break; // this object counts for the day
        } else if (debugList) {
          debugList.push({
            note: 'no-overlap',
            summary,
            isAllDay,
            starts: sJS.toISOString(),
            ends: eJS.toISOString(),
            preview,
          });
        }
      }
    } catch (e) {
      if (debugList) {
        const pv = (typeof ics === 'string') ? ics.slice(0, 120) : null;
        debugList.push({ note: 'parse-failed', error: String(e?.message || e), preview: pv });
      }
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

    // Wider window to be safe (handles midnight boundaries/all-day)
    const timeRange = {
      start: startD.subtract(1, 'day').toDate().toISOString(),
      end:   endD.add(2, 'day').toDate().toISOString(),
    };

    // Pull objects; ask tsdav to include object data if possible
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
      // Always try to hydrate, even if something already had inline ICS,
      // because some providers return stubs unless fetched individually.
      bookingsRaw = await hydrateICS(client, calBookings, b || []);
      blackoutsRaw = await hydrateICS(client, calBlackouts, k || []);
    } catch (e) {
      return res.status(500).json({ error: 'fetchCalendarObjects failed', detail: String(e?.message || e) });
    }

    const days = [];
    const perDayDebug = [];

    for (let d = startD; d.isBefore(endD.add(1, 'day')); d = d.add(1, 'day')) {
      const js = d.toDate();
      const debugListB = debug ? [] : null;
      const debugListK = debug ? [] : null;

      const A = analyzeForDate(bookingsRaw, js, debugListB);
      const B = analyzeForDate(blackoutsRaw, js, debugListK);

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
          bookingsExtracted: debugListB,
          blackoutsExtracted: debugListK,
        });
      }
    }

    const payload = {
      days,
      ...(debug ? {
        debug: {
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
            bookingsWithICS: bookingsRaw.filter(o => !!(o.__ics || pickICS(o))).length,
            blackoutsWithICS: blackoutsRaw.filter(o => !!(o.__ics || pickICS(o))).length,
            bookingsHydrated: bookingsRaw.filter(o => o.__hydrated).length,
            blackoutsHydrated: blackoutsRaw.filter(o => o.__hydrated).length,
          },
          allCalendars: allCalNames,
          perDay: perDayDebug,
          timeRange,
        }
      } : {})
    };

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'availability crashed', detail: String(e?.message || e) });
  }
}
