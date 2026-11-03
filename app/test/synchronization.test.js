import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { HelpdeskApiError, HelpdeskClient } from "../src/services/helpdesk.js";
import { ReportingService } from "../src/services/reporting-service.js";
import { FileStateStore } from "../src/store/state-store.js";

const site = {
  id: 11,
  timezone: "Asia/Singapore",
  business_hours: { mon: { open: "08:00", close: "18:00" } },
};

function request(id, status = "pending") {
  return {
    id,
    site_id: 11,
    status,
    priority: "High",
    created_at: "2026-10-05T00:00:00Z",
    deleted_at: null,
    merged_into_id: null,
  };
}

function changeResponse(data, nextCursor, hasMore = false) {
  return { data, next_cursor: nextCursor, has_more: hasMore };
}

class MemoryStateStore {
  constructor() {
    this.snapshot = null;
    this.checkpoint = null;
    this.failNextSnapshot = false;
  }

  async load() {
    if (!this.snapshot) return null;
    const state = structuredClone(this.snapshot);
    return {
      ...state,
      cursor: this.checkpoint?.cursor ?? state.cursor,
      savedAt: this.checkpoint?.savedAt ?? state.savedAt,
    };
  }

  async saveSnapshot(state, cursor, savedAt) {
    if (this.failNextSnapshot) {
      this.failNextSnapshot = false;
      throw new Error("disk write failed");
    }
    this.snapshot = { ...structuredClone(state), cursor, savedAt };
  }

  async saveCheckpoint(cursor, savedAt) {
    this.checkpoint = { cursor, savedAt };
  }
}

class FakeHelpdeskClient {
  constructor() {
    this.changeHandler = async () => changeResponse([], "cursor-1");
    this.calls = [];
    this.sites = [site];
    this.holidaysBySite = new Map([[11, []]]);
    this.staff = [{ id: 304, name: "Current responder" }];
  }

  async get(pathname, params = {}) {
    this.calls.push({ pathname, params });
    if (pathname === "/v1/sites") return { data: this.sites };
    if (pathname.startsWith("/v1/sites/") && pathname.endsWith("/holidays")) {
      const siteId = Number(pathname.split("/")[3]);
      return { data: this.holidaysBySite.get(siteId) ?? [] };
    }
    if (pathname === "/v1/staff") return { data: this.staff };
    if (pathname === "/v1/changes") return this.changeHandler(params);
    throw new Error(`Unexpected endpoint ${pathname}`);
  }
}

function serviceFixture({ client = new FakeHelpdeskClient(), store = new MemoryStateStore(), now } = {}) {
  return {
    client,
    store,
    service: new ReportingService({ client, store, logger: { error() {} }, now }),
  };
}

test("initial sync upserts updated requests and deduplicates repeated events", async () => {
  const { client, store, service } = serviceFixture();
  const firstEvent = { id: 20, status: "processing", at: 1791160200, actor_id: 304, note: "first" };
  const duplicateEvent = { ...firstEvent, note: "latest copy" };
  client.changeHandler = async (params) => {
    assert.equal(params.cursor, undefined);
    return changeResponse([
      { seq: 1, type: "request.created", request: request(1) },
      { seq: 2, type: "request.updated", request: request(1, "complete") },
      { seq: 3, type: "event.created", request_id: 1, event: firstEvent },
      { seq: 4, type: "event.created", request_id: 1, event: duplicateEvent },
    ], "cursor-1");
  };

  await service.initialize();
  assert.equal(service.requests.get(1).status, "complete");
  assert.equal(service.eventsByRequestId.get(1).length, 1);
  assert.equal(service.eventsByRequestId.get(1)[0].note, "latest copy");
  assert.equal(service.changeCursor, "cursor-1");
  assert.equal(store.checkpoint.cursor, "cursor-1");
  assert.equal(service.ready, true);
});

test("failed multi-page sync publishes neither partial changes nor an advanced checkpoint, then retries safely", async () => {
  const { client, store, service } = serviceFixture();
  const initialEvent = { id: 20, status: "processing", at: 1791160200, actor_id: 304 };
  const nextEvent = { id: 21, status: "complete", at: 1791162000, actor_id: 304 };
  client.changeHandler = async () => changeResponse([
    { seq: 1, type: "request.created", request: request(1) },
    { seq: 2, type: "event.created", request_id: 1, event: initialEvent },
  ], "cursor-1");
  await service.initialize();

  let failSecondPage = true;
  client.changeHandler = async (params) => {
    if (params.cursor === "cursor-1") {
      return changeResponse([
        { seq: 3, type: "request.updated", request: request(1, "complete") },
        { seq: 4, type: "event.created", request_id: 1, event: nextEvent },
      ], "cursor-2", true);
    }
    if (params.cursor === "cursor-2") {
      if (failSecondPage) throw new Error("temporary API outage");
      return changeResponse([
        { seq: 4, type: "event.created", request_id: 1, event: nextEvent },
        { seq: 4, type: "event.created", request_id: 1, event: nextEvent },
      ], "cursor-3");
    }
    assert.equal(params.cursor, "cursor-1");
    return changeResponse([
      { seq: 3, type: "request.updated", request: request(1, "complete") },
      { seq: 4, type: "event.created", request_id: 1, event: nextEvent },
    ], "cursor-2", true);
  };

  await assert.rejects(service.refreshChanges(), /temporary API outage/);
  assert.equal(service.requests.get(1).status, "pending");
  assert.equal(service.eventsByRequestId.get(1).length, 1);
  assert.equal(service.changeCursor, "cursor-1");
  assert.equal(store.checkpoint.cursor, "cursor-1");

  failSecondPage = false;
  await service.refreshChanges();
  assert.equal(service.requests.get(1).status, "complete");
  assert.equal(service.eventsByRequestId.get(1).length, 2);
  assert.equal(service.changeCursor, "cursor-3");
  assert.equal(store.checkpoint.cursor, "cursor-3");
});

test("failed durable write leaves the published snapshot and cursor unchanged", async () => {
  const { client, store, service } = serviceFixture();
  client.changeHandler = async (params) => params.cursor === undefined
    ? changeResponse([{ seq: 1, type: "request.created", request: request(1) }], "cursor-1")
    : changeResponse([{ seq: 2, type: "request.updated", request: request(1, "complete") }], "cursor-2");
  await service.initialize();

  store.failNextSnapshot = true;
  await assert.rejects(service.refreshChanges(), /disk write failed/);
  assert.equal(service.requests.get(1).status, "pending");
  assert.equal(service.changeCursor, "cursor-1");
  assert.equal(store.checkpoint.cursor, "cursor-1");

  await service.refreshChanges();
  assert.equal(service.requests.get(1).status, "complete");
  assert.equal(service.changeCursor, "cursor-2");
});

test("restart restores its file-backed snapshot and resumes from the persisted cursor", async (t) => {
  const temporaryRoot = path.join(process.cwd(), "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "sla-report-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStateStore(path.join(directory, "report-state.json"));
  const firstClient = new FakeHelpdeskClient();
  firstClient.changeHandler = async () => changeResponse([
    { seq: 1, type: "request.created", request: request(1) },
  ], "cursor-1");
  const first = serviceFixture({ client: firstClient, store }).service;
  await first.initialize();

  const resumedClient = new FakeHelpdeskClient();
  resumedClient.changeHandler = async (params) => {
    assert.equal(params.cursor, "cursor-1");
    return changeResponse([
      { seq: 2, type: "request.updated", request: request(1, "complete") },
    ], "cursor-2");
  };
  const resumed = serviceFixture({ client: resumedClient, store }).service;
  await resumed.initialize();

  assert.equal(resumed.ready, true);
  assert.equal(resumed.requests.get(1).status, "complete");
  assert.equal(resumed.changeCursor, "cursor-2");
  assert.equal(resumedClient.calls.some((call) => call.pathname === "/v1/changes" && call.params.cursor === undefined), false);
});

test("site, holiday, and current staff metadata is refreshed without replaying the change history", async () => {
  let now = 1_000;
  const client = new FakeHelpdeskClient();
  const store = new MemoryStateStore();
  const service = new ReportingService({ client, store, logger: { error() {} }, now: () => now });
  client.changeHandler = async () => changeResponse([
    { seq: 1, type: "request.created", request: request(1) },
  ], "cursor-1");
  await service.initialize();

  client.sites = [{ ...site, business_hours: { mon: { open: "07:00", close: "19:00" } } }];
  client.holidaysBySite.set(11, [{ date: "10/10/2026", name: "New holiday" }]);
  client.staff = [{ id: 304, name: "Renamed responder" }];
  client.changeHandler = async (params) => {
    assert.equal(params.cursor, "cursor-1");
    return changeResponse([], "cursor-2");
  };
  now += 36_000;
  await service.refreshChanges();

  assert.equal(service.sitesById.get(11).business_hours.mon.open, "07:00");
  assert.deepEqual(service.holidaysBySiteId.get(11), [{ date: "10/10/2026", name: "New holiday" }]);
  assert.equal(service.staffById.get(304).name, "Renamed responder");
  const changeCalls = client.calls.filter((call) => call.pathname === "/v1/changes");
  assert.equal(changeCalls.length, 2);
  assert.equal(changeCalls[0].params.cursor, undefined);
  assert.equal(changeCalls[1].params.cursor, "cursor-1");
});

test("expired change-feed cursor triggers a full staged rebuild while the old snapshot remains published", async () => {
  const { client, service } = serviceFixture();
  client.changeHandler = async () => changeResponse([
    { seq: 1, type: "request.created", request: request(1) },
  ], "cursor-1");
  await service.initialize();

  let releaseFullSync;
  let fullSyncStarted;
  const started = new Promise((resolve) => { fullSyncStarted = resolve; });
  const waitingForFullSync = new Promise((resolve) => { releaseFullSync = resolve; });
  client.changeHandler = async (params) => {
    if (params.cursor === "cursor-1") throw new HelpdeskApiError(410, "/v1/changes");
    assert.equal(params.cursor, undefined);
    fullSyncStarted();
    await waitingForFullSync;
    return changeResponse([
      { seq: 1, type: "request.created", request: request(1, "complete") },
      { seq: 2, type: "request.created", request: request(2) },
    ], "cursor-rebuilt");
  };

  const sync = service.refreshChanges();
  await started;
  assert.equal(service.requests.get(1).status, "pending");
  assert.equal(service.requests.has(2), false);
  releaseFullSync();
  await sync;
  assert.equal(service.requests.get(1).status, "complete");
  assert.equal(service.requests.has(2), true);
  assert.equal(service.changeCursor, "cursor-rebuilt");
});

test("helpdesk client honors Retry-After and retries a rate-limited synchronization request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
    return new Response(JSON.stringify({ data: [], next_cursor: "cursor-1", has_more: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const client = new HelpdeskClient({ baseUrl: "https://practice.example.test", token: "test-token" });
    const response = await client.get("/v1/changes", { limit: 500 });
    assert.equal(calls, 2);
    assert.equal(response.next_cursor, "cursor-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
