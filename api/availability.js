// Polyfills for 'dav' on Node (Vercel functions)
import xhr2pkg from 'xhr2';
const { XMLHttpRequest } = xhr2pkg;
globalThis.XMLHttpRequest = XMLHttpRequest;

import { DOMParser as XmldomParser } from '@xmldom/xmldom';
globalThis.DOMParser = XmldomParser;

import dayjs from 'dayjs';
import * as dav from 'dav';
import * as ICAL from 'ical.js';

const {
  ICLOUD_USERNAME,
  ICLOUD_APP_PASSWORD,
  BOOKINGS_CAL_NAME = 'Bookings',
  BLACKOUTS_CAL_NAME = 'Blackouts',
} = process.env;

// CORS (tighten origin later to https://609music.com)
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
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

  try {
    const { start, end } = req.query;
    if (!start) return res.status(400).json({ error: 'start required' });

    const startD = dayjs(start).startOf('day');
    const endD = dayjs(end || start).startOf('day');
    if (!startD.isValid() || !endD.isValid()) return res.status(400).json({ error: 'invalid dates' });

    const { account } = await getAccount();
    const calB = findCalendar(account, BOOKINGS_CAL_NAME);
    const calX = findCalendar(account, BLACKOUTS_CAL_NAME);
    if (!calB || !calX) return res.status(500).json({ error: 'Calendars not found' });

    const days = [];
    for (let d = startD; d.isBefore(endD.add(1, 'day')); d = d.add(1, 'day')) {
      const js = d.toDate();
      const booked = countEventsOnDate(calB.objects, js);
      const blackout = countEventsOnDate(calX.objects, js) > 0;
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
    return res.status(500).json({ error: 'availability failed' });
  }
}
