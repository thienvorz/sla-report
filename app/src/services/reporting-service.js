import { randomBytes } from "node:crypto";
import { HelpdeskApiError } from "./helpdesk.js";
import { buildSlaReport, calculateRequestRow } from "../domain/report-logic.js";
import { FileStateStore } from "../store/state-store.js";

const CHANGE_PAGE_SIZE = 500;
const REFRESH_INTERVAL_MS = 20_000;
const METADATA_REFRESH_INTERVAL_MS = 35_000;
const CURSOR_TTL_MS = 15 * 60_000;
const REPORT_CACHE_TTL_MS = 15_000;
const MAX_CACHED_REPORTS = 8;

export class ReportNotReadyError extends Error {
  constructor() {
    super("Report data is not ready");
    this.name = "ReportNotReadyError";
    this.statusCode = 503;
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid or expired cursor");
    this.name = "InvalidCursorError";
    this.statusCode = 400;
  }
}

function compareIdAscending(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

function filterRows(rows, filters, requestsById) {
  return rows.filter((row) => {
    if (filters.site_id !== undefined && String(row.site_id) !== String(filters.site_id)) return false;
    if (filters.responder_id !== undefined && String(row.responder_id) !== String(filters.responder_id)) return false;
    if (filters.priority !== undefined) {
      const request = requestsById.get(row.id) ?? requestsById.get(String(row.id));
      if ((request?.priority ?? null) !== filters.priority) return false;
    }
    if (filters.late !== undefined && row.completed_late !== filters.late) return false;
    if (filters.within_target !== undefined && row.within_target !== filters.within_target) return false;
    return true;
  });
}

function sortRows(rows, sort) {
  const sorted = [...rows];
  sorted.sort((left, right) => {
    if (sort === "id" || sort === "-id") {
      const comparison = compareIdAscending(left.id, right.id);
      return sort === "-id" ? -comparison : comparison;
    }

    const a = left.response_business_minutes;
    const b = right.response_business_minutes;
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    if (a !== null && b !== null && a !== b) {
      return sort === "-response_business_minutes" ? b - a : a - b;
    }
    return compareIdAscending(left.id, right.id);
  });
  return sorted;
}

function emptyData() {
  return {
    requests: new Map(),
    eventsByRequestId: new Map(),
    sitesById: new Map(),
    holidaysBySiteId: new Map(),
    staffById: new Map(),
  };
}

function cloneData(data) {
  return {
    requests: new Map(data.requests),
    eventsByRequestId: new Map([...data.eventsByRequestId]
      .map(([requestId, events]) => [requestId, [...events]])),
    sitesById: new Map(data.sitesById),
    holidaysBySiteId: new Map(data.holidaysBySiteId),
    staffById: new Map(data.staffById),
  };
}

function metadataFingerprint(data) {
  const entries = (map) => [...map]
    .sort(([left], [right]) => compareIdAscending(left, right));
  return JSON.stringify({
    sites: entries(data.sitesById),
    holidays: entries(data.holidaysBySiteId),
    staff: entries(data.staffById),
  });
}

export class ReportingService {
  constructor({ client, store = new FileStateStore(), logger = console, now = Date.now } = {}) {
    if (!client) throw new TypeError("A helpdesk API client is required");
    this.client = client;
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.ready = false;
    this.lastSyncAt = 0;
    this.lastMetadataRefreshAt = 0;
    this.changeCursor = undefined;
    this.requests = new Map();
    this.eventsByRequestId = new Map();
    this.sitesById = new Map();
    this.holidaysBySiteId = new Map();
    this.staffById = new Map();
    this.syncPromise = null;
    this.initializationPromise = null;
    this.refreshTimer = null;
    this.requestCursors = new Map();
    this.reportCache = new Map();
    this.rowCache = new Map();
    this.dataRevision = 0;
  }

  start() {
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        const task = this.ready ? this.refreshChanges() : this.initialize();
        task.catch((error) => this.logger.error("Helpdesk data refresh failed:", error.message));
      }, REFRESH_INTERVAL_MS);
      this.refreshTimer.unref?.();
    }
    return this.initialize();
  }

  stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async initialize() {
    if (this.ready) return;
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      let saved;
      try {
        saved = await this.store.load();
      } catch (error) {
        this.logger.error("Persisted report state could not be loaded:", error.message);
        saved = null;
      }

      if (saved) {
        this.installData(saved);
        this.changeCursor = saved.cursor;
        this.lastSyncAt = Number(saved.savedAt) || 0;
        this.lastMetadataRefreshAt = 0;
        this.ready = true;
        await this.refreshChanges();
      } else {
        this.ready = false;
        await this.fullSync();
      }
    })().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  async loadMetadata(data) {
    const siteResponse = await this.client.get("/v1/sites");
    const sites = siteResponse.data ?? [];
    data.sitesById = new Map(sites.map((site) => [site.id, site]));
    data.holidaysBySiteId = new Map();
    for (const site of sites) {
      const response = await this.client.get(`/v1/sites/${encodeURIComponent(site.id)}/holidays`);
      data.holidaysBySiteId.set(site.id, response.data ?? []);
    }
  }

  async loadCurrentStaff(data) {
    const response = await this.client.get("/v1/staff");
    data.staffById = new Map((response.data ?? []).map((staff) => [staff.id, staff]));
  }

  installData(data) {
    this.requests = data.requests;
    this.eventsByRequestId = data.eventsByRequestId;
    this.sitesById = data.sitesById;
    this.holidaysBySiteId = data.holidaysBySiteId;
    this.staffById = data.staffById;
    this.reportCache.clear();
    this.rowCache.clear();
    this.dataRevision += 1;
  }

  applyChange(change, data) {
    if (change.request && change.request.id !== undefined) {
      data.requests.set(change.request.id, change.request);
    }
    if (change.type === "event.created" && change.event && change.request_id !== undefined) {
      const key = change.request_id;
      if (!data.eventsByRequestId.has(key)) data.eventsByRequestId.set(key, []);
      const events = data.eventsByRequestId.get(key);
      const existingIndex = change.event.id === undefined || change.event.id === null
        ? -1
        : events.findIndex((event) => String(event.id) === String(change.event.id));
      if (existingIndex < 0) events.push(change.event);
      else events[existingIndex] = change.event;
    }
    if (change.type === "staff.updated" && change.staff) {
      data.staffById.set(change.staff.id, change.staff);
    }
  }

  async readChangesInto(data, startCursor) {
    let cursor = startCursor;
    let count = 0;
    while (true) {
      const params = { limit: CHANGE_PAGE_SIZE };
      if (cursor !== undefined) params.cursor = cursor;
      const response = await this.client.get("/v1/changes", params);
      const changes = response.data ?? [];
      if (!Array.isArray(changes)) throw new TypeError("Helpdesk changes response must contain a data array");
      for (const change of changes) this.applyChange(change, data);
      count += changes.length;
      if (typeof response.next_cursor !== "string") {
        throw new TypeError("Helpdesk changes response omitted its next_cursor");
      }
      cursor = response.next_cursor;
      if (!response.has_more) return { cursor, count };
    }
  }

  async fullSync() {
    const staged = emptyData();
    let result;
    try {
      result = await this.readChangesInto(staged, undefined);
    } catch (error) {
      if (!(error instanceof HelpdeskApiError) || error.status !== 410) throw error;
      const retry = emptyData();
      result = await this.readChangesInto(retry, undefined);
      await this.loadMetadata(retry);
      await this.loadCurrentStaff(retry);
      return this.persistAndPublish(retry, result.cursor, this.now());
    }
    await this.loadMetadata(staged);
    await this.loadCurrentStaff(staged);
    return this.persistAndPublish(staged, result.cursor, this.now());
  }

  async persistAndPublish(data, cursor, savedAt) {
    await this.store.saveSnapshot(data, cursor, savedAt);
    await this.store.saveCheckpoint(cursor, savedAt);
    this.installData(data);
    this.changeCursor = cursor;
    this.lastSyncAt = savedAt;
    this.lastMetadataRefreshAt = savedAt;
    this.ready = true;
  }

  async refreshChanges() {
    if (!this.ready) return this.initialize();
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = (async () => {
      const staged = cloneData({
        requests: this.requests,
        eventsByRequestId: this.eventsByRequestId,
        sitesById: this.sitesById,
        holidaysBySiteId: this.holidaysBySiteId,
        staffById: this.staffById,
      });
      try {
        const refreshMetadata = this.now() - this.lastMetadataRefreshAt >= METADATA_REFRESH_INTERVAL_MS;
        const previousMetadata = refreshMetadata ? metadataFingerprint(staged) : null;
        const result = await this.readChangesInto(staged, this.changeCursor);
        if (refreshMetadata) {
          await this.loadMetadata(staged);
          await this.loadCurrentStaff(staged);
        }
        const savedAt = this.now();
        const metadataChanged = refreshMetadata && metadataFingerprint(staged) !== previousMetadata;
        const dataChanged = result.count > 0 || metadataChanged;
        if (dataChanged) await this.store.saveSnapshot(staged, result.cursor, savedAt);
        await this.store.saveCheckpoint(result.cursor, savedAt);
        if (dataChanged) this.installData(staged);
        this.changeCursor = result.cursor;
        this.lastSyncAt = savedAt;
        if (refreshMetadata) this.lastMetadataRefreshAt = savedAt;
      } catch (error) {
        if (!(error instanceof HelpdeskApiError) || error.status !== 410) throw error;
        await this.fullSync();
      }
    })().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async refreshIfStale() {
    if (!this.ready) throw new ReportNotReadyError();
    if (this.now() - this.lastSyncAt >= REFRESH_INTERVAL_MS) await this.refreshChanges();
    if (!this.ready) throw new ReportNotReadyError();
  }

  async reportSnapshot({ from, to }) {
    await this.refreshIfStale();
    const requestsById = this.requests;
    const revision = this.dataRevision;
    const key = `${from}\u0000${to}`;
    const cached = this.reportCache.get(key);
    if (cached && cached.revision === revision && cached.expiresAt > this.now()) {
      return { report: cached.report, requestsById: cached.requestsById };
    }

    const report = buildSlaReport({
      from,
      to,
      requests: [...requestsById.values()],
      eventsByRequestId: this.eventsByRequestId,
      sitesById: this.sitesById,
      holidaysBySiteId: this.holidaysBySiteId,
      staffById: this.staffById,
      calculateRow: (request, context) => this.getCachedRow(request, context),
    });
    this.reportCache.set(key, {
      report,
      requestsById,
      revision,
      expiresAt: this.now() + REPORT_CACHE_TTL_MS,
    });
    if (this.reportCache.size > MAX_CACHED_REPORTS) {
      this.reportCache.delete(this.reportCache.keys().next().value);
    }
    return { report, requestsById };
  }

  async reportRows(range) {
    return (await this.reportSnapshot(range)).report;
  }

  getCachedRow(request, context) {
    const key = String(request.id);
    const cached = this.rowCache.get(key);
    if (cached?.revision === this.dataRevision) return cached.row;
    const row = calculateRequestRow(request, context);
    this.rowCache.set(key, { revision: this.dataRevision, row });
    return row;
  }

  async getReport({ from, to }) {
    return this.reportRows({ from, to });
  }

  async getRequests(query) {
    await this.refreshIfStale();
    const fingerprint = JSON.stringify({
      from: query.from,
      to: query.to,
      site_id: query.site_id,
      responder_id: query.responder_id,
      priority: query.priority,
      late: query.late,
      within_target: query.within_target,
      sort: query.sort,
      limit: query.limit,
    });

    let rows;
    let offset = 0;
    if (query.cursor !== undefined) {
      const stored = this.requestCursors.get(query.cursor);
      if (!stored || stored.expiresAt < this.now() || stored.fingerprint !== fingerprint) {
        throw new InvalidCursorError();
      }
      rows = stored.rows;
      offset = stored.offset;
    } else {
      const snapshot = await this.reportSnapshot(query);
      rows = sortRows(filterRows(snapshot.report.requests, query, snapshot.requestsById), query.sort);
    }

    const data = rows.slice(offset, offset + query.limit);
    const nextOffset = offset + data.length;
    let nextCursor = null;
    if (nextOffset < rows.length) {
      nextCursor = randomBytes(24).toString("base64url");
      this.requestCursors.set(nextCursor, {
        fingerprint,
        rows,
        offset: nextOffset,
        expiresAt: this.now() + CURSOR_TTL_MS,
      });
    }
    this.pruneCursors();
    return { data, next_cursor: nextCursor };
  }

  async getAllRequests(filters) {
    const snapshot = await this.reportSnapshot(filters);
    return sortRows(filterRows(snapshot.report.requests, filters, snapshot.requestsById), filters.sort);
  }

  pruneCursors() {
    const now = this.now();
    for (const [cursor, value] of this.requestCursors) {
      if (value.expiresAt < now) this.requestCursors.delete(cursor);
    }
  }
}

export { sortRows };
