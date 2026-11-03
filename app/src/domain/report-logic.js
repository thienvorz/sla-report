const dateFormatterCache = new Map();
const dateTimeFormatterCache = new Map();
const businessWindowCache = new Map();
const holidaySetCache = new WeakMap();
const MAX_BUSINESS_WINDOWS = 20_000;

function dateFormatter(timeZone) {
  if (!dateFormatterCache.has(timeZone)) {
    dateFormatterCache.set(timeZone, new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }));
  }
  return dateFormatterCache.get(timeZone);
}

function dateTimeFormatter(timeZone) {
  if (!dateTimeFormatterCache.has(timeZone)) {
    dateTimeFormatterCache.set(timeZone, new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }));
  }
  return dateTimeFormatterCache.get(timeZone);
}

function partsObject(formatter, date) {
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map(({ type, value }) => [type, value]));
}

function localDateString(epochMs, timeZone) {
  const parts = partsObject(dateFormatter(timeZone), new Date(epochMs));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localWallString(epochMs, timeZone) {
  const parts = partsObject(dateTimeFormatter(timeZone), new Date(epochMs));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function instantMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${label} must be a valid timestamp`);
  return ms;
}

function validateIsoDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a valid calendar date`);
  }
  return value;
}

function readById(source, id) {
  if (source instanceof Map) return source.get(id) ?? source.get(String(id));
  if (Array.isArray(source)) return source.find((value) => String(value.id) === String(id));
  return source?.[id] ?? source?.[String(id)];
}

function holidayDate(value) {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  }
  if (value && typeof value.date === "string") return holidayDate(value.date);
  return null;
}

function holidaySet(values) {
  if (Array.isArray(values)) {
    const cached = holidaySetCache.get(values);
    if (cached) return cached;
  }
  const result = new Set((values ?? []).map(holidayDate).filter(Boolean));
  if (Array.isArray(values)) holidaySetCache.set(values, result);
  return result;
}

function parseWallClock(date, clock) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(`${date}T${clock}`);
  if (!match) throw new TypeError(`Invalid local wall time: ${date} ${clock}`);
  const [, year, month, day, hour, minute] = match;
  const values = [year, month, day, hour, minute].map(Number);
  const base = Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4]);
  const check = new Date(base).toISOString();
  if (check.slice(0, 10) !== date || Number(check.slice(11, 13)) !== values[3] || Number(check.slice(14, 16)) !== values[4]) {
    throw new TypeError(`Invalid local wall time: ${date} ${clock}`);
  }
  return { year: values[0], month: values[1], day: values[2], hour: values[3], minute: values[4], base };
}

function localPartsAt(epochMs, timeZone) {
  const parts = partsObject(dateTimeFormatter(timeZone), new Date(epochMs));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function sameWallMinute(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

// Resolve local wall times without assuming a fixed UTC offset. For a repeated
// DST hour, openings use the earlier occurrence and closings the later one.
function wallTimeInstants(date, clock, timeZone) {
  const target = parseWallClock(date, clock);
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 3) {
    const sample = target.base + delta * 60 * 60 * 1000;
    const local = localPartsAt(sample, timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    offsets.add(localAsUtc - Math.floor(sample / 1000) * 1000);
  }

  const candidates = [...offsets]
    .map((offset) => target.base - offset)
    .filter((candidate) => sameWallMinute(localPartsAt(candidate, timeZone), target))
    .sort((a, b) => a - b);
  if (candidates.length) return candidates;

  // A schedule boundary inside a spring-forward gap has no exact instant.
  // Move it forward to the first representable local minute.
  for (let minute = 1; minute <= 180; minute += 1) {
    const shifted = new Date(target.base + minute * 60_000);
    const shiftedDate = shifted.toISOString().slice(0, 10);
    const shiftedClock = shifted.toISOString().slice(11, 16);
    const resolved = wallTimeInstantsExact(shiftedDate, shiftedClock, timeZone);
    if (resolved.length) return resolved;
  }
  throw new RangeError(`Could not resolve local wall time ${date} ${clock} in ${timeZone}`);
}

function wallTimeInstantsExact(date, clock, timeZone) {
  const target = parseWallClock(date, clock);
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 3) {
    const sample = target.base + delta * 60 * 60 * 1000;
    const local = localPartsAt(sample, timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    offsets.add(localAsUtc - Math.floor(sample / 1000) * 1000);
  }
  return [...offsets]
    .map((offset) => target.base - offset)
    .filter((candidate) => sameWallMinute(localPartsAt(candidate, timeZone), target))
    .sort((a, b) => a - b);
}

function addCalendarDays(date, amount) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + amount);
  return next.toISOString().slice(0, 10);
}

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) throw new TypeError(`Invalid business-hours time: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new TypeError(`Invalid business-hours time: ${value}`);
  return hours * 60 + minutes;
}

function businessWindow(date, hours, timeZone) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const window = hours?.[keys[day]];
  if (!window) return null;

  const cacheKey = `${timeZone}\u0000${date}\u0000${window.open}\u0000${window.close}`;
  const cached = businessWindowCache.get(cacheKey);
  if (cached) return cached;

  const openMinute = timeToMinutes(window.open);
  const closeMinute = timeToMinutes(window.close);
  const closeDate = closeMinute <= openMinute ? addCalendarDays(date, 1) : date;
  const openCandidates = wallTimeInstants(date, window.open, timeZone);
  const closeCandidates = wallTimeInstants(closeDate, window.close, timeZone);
  const result = {
    open: openCandidates[0],
    close: closeCandidates.at(-1),
  };
  businessWindowCache.set(cacheKey, result);
  if (businessWindowCache.size > MAX_BUSINESS_WINDOWS) {
    businessWindowCache.delete(businessWindowCache.keys().next().value);
  }
  return result;
}

export function businessSecondsBetween(startMs, endMs, site, holidays = []) {
  if (endMs <= startMs) return 0;
  if (!site?.timezone || !site?.business_hours) {
    throw new TypeError("Site timezone and business_hours are required");
  }

  const closedDates = holidaySet(holidays);
  const firstDate = localDateString(startMs, site.timezone);
  const lastDate = localDateString(endMs, site.timezone);
  let totalMs = 0;

  for (let date = firstDate; date <= lastDate; date = addCalendarDays(date, 1)) {
    if (closedDates.has(date)) continue;
    const window = businessWindow(date, site.business_hours, site.timezone);
    if (!window || window.close <= window.open) continue;
    totalMs += Math.max(0, Math.min(endMs, window.close) - Math.max(startMs, window.open));
  }
  return Math.floor(totalMs / 1000);
}

function compareEvents(a, b) {
  const timeDifference = Number(a.at) - Number(b.at);
  if (timeDifference !== 0) return timeDifference;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""), "en", { numeric: true });
}

export function effectiveEvents(events = []) {
  const byId = new Map();
  const withoutIds = [];
  for (const event of events) {
    if (event?.id === undefined || event?.id === null) {
      withoutIds.push(event);
    } else if (!byId.has(String(event.id))) {
      byId.set(String(event.id), event);
    }
  }

  const unique = [...byId.values(), ...withoutIds];
  const revertedIds = new Set(unique
    .filter((event) => event?.reverts_id !== null && event?.reverts_id !== undefined)
    .map((event) => String(event.reverts_id)));
  return unique
    .filter((event) => event?.reverts_id === null || event?.reverts_id === undefined)
    .filter((event) => event?.id === undefined || event?.id === null || !revertedIds.has(String(event.id)))
    .sort(compareEvents);
}

function deadlineWallString(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Invalid due_at value: ${value}`);
  const [, day, month, year, hour, minute] = match;
  parseWallClock(`${year}-${month}-${day}`, `${hour}:${minute}`);
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function completedLate(events, timeZone) {
  const completeEvent = [...events].reverse().find((event) => event.status === "complete");
  const latestDeadlineEvent = events.filter((event) => event.due_at)
    .sort(compareEvents).at(-1);
  if (!completeEvent || !latestDeadlineEvent) return null;

  const deadline = deadlineWallString(latestDeadlineEvent.due_at);
  if (!deadline) return null;
  const completedAt = localWallString(Number(completeEvent.at) * 1000, timeZone);
  return completedAt > deadline;
}

function targetMinutes(priority) {
  if (priority === "High") return 60;
  if (priority === "Medium") return 240;
  return 480;
}

export function calculateRequestRow(request, {
  events = [],
  site,
  holidays = [],
  staffById = new Map(),
}) {
  if (!site?.timezone) throw new TypeError(`Missing site or timezone for request ${request.id}`);
  const sortedEvents = effectiveEvents(events);
  const firstResponse = sortedEvents.find((event) => event.status === "processing"
    && event.actor_id !== null && event.actor_id !== undefined);
  let responder = null;
  let responseBusinessMinutes = null;
  let withinTarget = null;

  if (firstResponse) {
    const responderId = firstResponse.actor_id;
    const staff = readById(staffById, responderId);
    responder = staff?.name ?? null;
    const createdAt = instantMs(request.created_at, `request ${request.id} created_at`);
    const responseAt = Number(firstResponse.at) * 1000;
    if (!Number.isFinite(responseAt)) throw new TypeError(`Event ${firstResponse.id} has invalid at`);
    const seconds = responseAt < createdAt
      ? 0
      : businessSecondsBetween(createdAt, responseAt, site, holidays);
    responseBusinessMinutes = Math.floor(seconds / 60);
    withinTarget = responseBusinessMinutes <= targetMinutes(request.priority);
  }

  return {
    id: request.id,
    site_id: request.site_id,
    responder_id: firstResponse ? firstResponse.actor_id : null,
    responder,
    response_business_minutes: responseBusinessMinutes,
    within_target: withinTarget,
    completed_late: completedLate(sortedEvents, site.timezone),
  };
}

export function buildSlaReport({
  from,
  to,
  requests = [],
  eventsByRequestId = new Map(),
  sitesById = new Map(),
  holidaysBySiteId = new Map(),
  staffById = new Map(),
  calculateRow = calculateRequestRow,
}) {
  validateIsoDate(from, "from");
  validateIsoDate(to, "to");
  if (from > to) throw new RangeError("from must be on or before to");

  const rows = [];
  for (const request of requests) {
    if (request.status === "canceled"
      || (request.deleted_at !== null && request.deleted_at !== undefined)
      || (request.merged_into_id !== null && request.merged_into_id !== undefined)) continue;
    const site = readById(sitesById, request.site_id);
    if (!site?.timezone) throw new TypeError(`Missing site or timezone for request ${request.id}`);
    const createdAt = instantMs(request.created_at, `request ${request.id} created_at`);
    const createdDate = localDateString(createdAt, site.timezone);
    if (createdDate < from || createdDate > to) continue;

    rows.push(calculateRow(request, {
      events: readById(eventsByRequestId, request.id) ?? [],
      site,
      holidays: readById(holidaysBySiteId, request.site_id) ?? [],
      staffById,
    }));
  }

  const responderCounts = new Map();
  for (const row of rows) {
    if (row.responder_id === null) continue;
    const key = String(row.responder_id);
    const staff = readById(staffById, row.responder_id);
    if (!responderCounts.has(key)) {
      responderCounts.set(key, {
        id: row.responder_id,
        name: staff?.name ?? null,
        requests: 0,
        within_target: 0,
        completed_late: 0,
      });
    }
    const counts = responderCounts.get(key);
    counts.requests += 1;
    if (row.within_target === true) counts.within_target += 1;
    if (row.completed_late === true) counts.completed_late += 1;
  }

  return { from, to, requests: rows, responders: [...responderCounts.values()] };
}
