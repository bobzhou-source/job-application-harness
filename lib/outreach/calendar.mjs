// lib/outreach/calendar.mjs — Apple Calendar delivery for outreach:
// the request-file CalendarBridge protocol plus recipient-local slot planning.
//
// Nothing here sends anything; it only writes reminders into the user's own
// calendar. Every path (the bridge app) and every identifier (calendar id)
// arrives through arguments, so the module stays free of personal data.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_DURATION_MINUTES = 20;
const BRIDGE_DEADLINE_MS = 60_000;
const BRIDGE_TIMEOUT_MS = 90_000;
const MAX_DAYS_SCANNED = 800;

/**
 * One CalendarBridge operation through its request-file protocol. `/usr/bin/open`
 * is required (not the binary directly) so the bundle's TCC grant applies.
 */
export async function bridgeCall({ appPath }, operation, args = {}) {
  if (!appPath) throw new TypeError('calendar: appPath is required');
  if (!operation) throw new TypeError('calendar: operation is required');

  const dir = mkdtempSync(join(tmpdir(), 'outreach-cal-'));
  const requestPath = join(dir, 'request.json');
  const responsePath = join(dir, 'response.json');
  const stderrPath = join(dir, 'stderr.log');
  writeFileSync(
    requestPath,
    `${JSON.stringify({ operation, arguments: args, deadlineMs: Date.now() + BRIDGE_DEADLINE_MS })}\n`
  );

  try {
    const { code, signal, spawnError } = await runOpen([
      '-W',
      '-n',
      '-i',
      requestPath,
      '-o',
      responsePath,
      '--stderr',
      stderrPath,
      appPath,
    ]);
    if (spawnError) throw new Error(`CalendarBridge ${operation} could not launch: ${spawnError.message}`);

    const stderr = readText(stderrPath);
    const out = readText(responsePath).trim();
    if (!out) {
      throw new Error(
        `CalendarBridge ${operation} returned nothing (open exit ${describeExit(code, signal)})${stderr ? `: ${stderr}` : ''}`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error(`CalendarBridge ${operation} returned malformed JSON: ${out.slice(0, 300)}`);
    }
    if (!parsed.ok) {
      throw new Error(`CalendarBridge ${operation} failed: ${parsed.error?.code} ${parsed.error?.message}`);
    }
    return parsed.result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOpen(args) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), BRIDGE_TIMEOUT_MS);
    child.on('error', (spawnError) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, spawnError });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, spawnError: null });
    });
  });
}

function describeExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `exit ${code}`;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------ timezone math

/** Offset in minutes east of UTC for `tz` at `date` (negative in the Americas). */
function offsetMinutesAt(tz, date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  if (!part || part === 'GMT' || part === 'UTC') return 0;
  const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

function zonedParts(tz, date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')) % 24,
    mm: Number(get('minute')),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Local wall time in `tz` -> RFC 3339 with an explicit offset. */
function zonedToRfc3339(tz, y, m, d, hh, mm) {
  const wallUtc = Date.UTC(y, m - 1, d, hh, mm);
  let off = offsetMinutesAt(tz, new Date(wallUtc));
  let ts = wallUtc - off * 60_000;
  off = offsetMinutesAt(tz, new Date(ts));
  ts = wallUtc - off * 60_000;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:00${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function localDateString(tz, date = new Date()) {
  const p = zonedParts(tz, date);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function minutesOf(clock) {
  const [h, m] = String(clock).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new TypeError(`invalid clock time ${clock}`);
  return h * 60 + m;
}

function clockOf(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

// ------------------------------------------------------------------ slots

/**
 * Recipient-local outreach slots: `count` slot windows of `durationMinutes`
 * each, drawn from the allowed weekdays inside `window` (local clock), at most
 * `perDay` per calendar day, separated by at least `gapMinutes`, never in the
 * past, and at least `gapMinutes` away from every time in `existing` (the RFC
 * 3339 starts of reminders already on the calendar). Slots already consumed for
 * a date arrive in `used` and take the earliest positions, so the day's
 * remaining capacity shrinks accordingly.
 */
export function planSlots({
  timeZone,
  count,
  startDate,
  days = ['Tue', 'Wed', 'Thu'],
  window = ['09:00', '10:30'],
  perDay = 3,
  gapMinutes = 15,
  used = {},
  existing = [],
  durationMinutes = DEFAULT_DURATION_MINUTES,
} = {}) {
  if (!timeZone) throw new TypeError('planSlots: timeZone is required');
  if (!Number.isInteger(count) || count < 0) throw new TypeError('planSlots: count must be a non-negative integer');
  if (count === 0) return [];

  const [windowStart, windowEnd] = window;
  const startM = minutesOf(windowStart);
  const endM = minutesOf(windowEnd);
  if (endM <= startM) throw new TypeError('planSlots: window end must be after window start');
  if (!Number.isInteger(perDay) || perDay < 1) throw new TypeError('planSlots: perDay must be >= 1');
  if (!Number.isFinite(gapMinutes) || gapMinutes < 0) throw new TypeError('planSlots: gapMinutes must be >= 0');
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new TypeError('planSlots: durationMinutes must be > 0');
  }
  const allowed = new Set(days);
  const gapMs = gapMinutes * 60_000;
  const existingMs = (Array.isArray(existing) ? existing : [existing])
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  const nowMs = Date.now();
  const today = localDateString(timeZone);
  let day = startDate ? String(startDate) : today;
  if (day < today) day = today;

  const out = [];
  let scanned = 0;
  while (out.length < count) {
    if (scanned++ > MAX_DAYS_SCANNED) {
      throw new Error(`planSlots: could not find ${count} slots within ${MAX_DAYS_SCANNED} days`);
    }
    if (allowed.has(weekdayOf(day))) {
      const [y, m, d] = day.split('-').map(Number);
      const already = Math.max(0, Number(used?.[day] ?? 0) | 0);
      const capacity = perDay - already;
      if (capacity > 0) {
        const base = startM + already * (durationMinutes + gapMinutes);
        const usable = endM - base;
        let k = Math.min(count - out.length, capacity, Math.floor((usable + gapMinutes) / (durationMinutes + gapMinutes)));
        while (k > 1 && Math.floor((usable - k * durationMinutes) / (k - 1)) < gapMinutes) k -= 1;
        if (k > 0 && usable >= durationMinutes) {
          const gap = k > 1 ? Math.floor((usable - k * durationMinutes) / (k - 1)) : 0;
          for (let i = 0; i < k && out.length < count; i += 1) {
            const start = base + i * (durationMinutes + gap);
            const end = start + durationMinutes;
            const startRfc = zonedToRfc3339(timeZone, y, m, d, Math.floor(start / 60), start % 60);
            const startMs = Date.parse(startRfc);
            if (startMs <= nowMs) continue; // never schedule in the past
            if (existingMs.some((t) => Math.abs(t - startMs) < gapMs)) continue; // keep clear of booked times
            out.push({
              date: day,
              timeZone,
              startLocal: clockOf(start),
              endLocal: clockOf(end),
              start: startRfc,
              end: zonedToRfc3339(timeZone, y, m, d, Math.floor(end / 60), end % 60),
            });
          }
        }
      }
    }
    if (out.length < count) day = addDays(day, 1);
  }
  return out;
}

// --------------------------------------------------------------- reminders

/** Creates one reminder event and returns its bridge event id. */
export async function createReminder({ appPath, calendarId, title, notes, start, end, alarmMinutes = 10, availability }) {
  if (!calendarId) throw new TypeError('createReminder: calendarId is required');
  if (!title) throw new TypeError('createReminder: title is required');
  if (!start || !end) throw new TypeError('createReminder: start and end are required');

  const result = await bridgeCall({ appPath }, 'create_event', {
    calendarId,
    title,
    allDay: false,
    ...(availability ? { availability } : {}),
    start,
    end,
    ...(notes ? { notes } : {}),
    alarms: [{ offsetMinutes: -Math.abs(Number(alarmMinutes)) }],
  });
  const record = result?.event ?? result ?? {};
  const eventId = record.eventId ?? record.id ?? result?.eventId ?? result?.id;
  if (!eventId) throw new Error(`createReminder: bridge returned no event id (${JSON.stringify(result)})`);
  return {
    eventId,
    revision: record.revision ?? result?.revision ?? null,
    start: record.start ?? start,
    end: record.end ?? end,
  };
}

/** Reminders whose title starts with `titlePrefix`, inside [from, to). */
export async function findReminders({ appPath, calendarId, titlePrefix, from, to }) {
  const result = await bridgeCall({ appPath }, 'search_events', {
    ...(calendarId ? { calendarId } : {}),
    start: from,
    end: to,
  });
  const events = Array.isArray(result) ? result : (result?.events ?? result?.results ?? []);
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;

  return events
    .map((raw) => raw?.event ?? raw)
    .map((event) => ({
      eventId: event?.eventId ?? event?.id,
      title: event?.title ?? '',
      start: event?.start,
      revision: event?.revision ?? null,
    }))
    .filter((event) => event.eventId)
    .filter((event) => !titlePrefix || String(event.title).startsWith(titlePrefix))
    .filter((event) => {
      const at = event.start ? Date.parse(event.start) : NaN;
      if (!Number.isFinite(at)) return true;
      return at >= fromMs && at < toMs;
    });
}
