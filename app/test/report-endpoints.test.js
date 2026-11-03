import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { InvalidCursorError, ReportingService } from "../src/services/reporting-service.js";

const site = {
  id: 11,
  name: "Test Site",
  timezone: "Asia/Singapore",
  business_hours: {
    mon: { open: "08:00", close: "18:00" },
    tue: { open: "08:00", close: "18:00" },
    wed: { open: "08:00", close: "18:00" },
    thu: { open: "08:00", close: "18:00" },
    fri: { open: "08:00", close: "18:00" },
    sat: null,
    sun: null,
  },
};

const createdAt = "2026-10-05T00:00:00Z";
const baseAt = 1791158400;

function request(id, overrides = {}) {
  return {
    id,
    site_id: 11,
    status: "processing",
    priority: "High",
    created_at: createdAt,
    deleted_at: null,
    merged_into_id: null,
    ...overrides,
  };
}

const requests = [
  request(1),
  request(2, { status: "pending", priority: null }),
  request(3, { status: "complete", priority: "Low" }),
];

const events = [
  { id: 101, status: "pending", at: baseAt + 900, actor_id: null, due_at: "05/10/2026 09:00", reverts_id: null },
  { id: 102, status: "processing", at: baseAt + 1800, actor_id: 304, actor_name: "Old Name", due_at: null, reverts_id: null },
  { id: 103, status: "complete", at: baseAt + 7200, actor_id: 304, due_at: null, reverts_id: null },
  { id: 301, status: "processing", at: baseAt + 3600, actor_id: 305, due_at: null, reverts_id: null },
];

class FakeHelpdeskClient {
  async get(pathname, params = {}) {
    if (pathname === "/v1/sites") return { data: [site] };
    if (pathname === "/v1/sites/11/holidays") return { data: [] };
    if (pathname === "/v1/staff") {
      return { data: [{ id: 304, name: "Current Name" }, { id: 305, name: "Same Name" }] };
    }
    if (pathname === "/v1/changes") {
      assert.equal(params.limit, 500);
      return {
        data: [
          ...requests.map((value) => ({ seq: value.id, type: "request.created", request: value })),
          ...events.slice(0, 3).map((value) => ({ seq: value.id, type: "event.created", request_id: 1, event: value })),
          { seq: 301, type: "event.created", request_id: 3, event: events[3] },
        ],
        next_cursor: "initial-feed-cursor",
        has_more: false,
      };
    }
    throw new Error(`Unexpected API path: ${pathname}`);
  }
}

class MemoryStateStore {
  constructor() {
    this.snapshot = null;
    this.checkpoint = null;
  }

  async load() {
    if (!this.snapshot) return null;
    const saved = structuredClone(this.snapshot);
    return {
      ...saved,
      cursor: this.checkpoint?.cursor ?? saved.cursor,
      savedAt: this.checkpoint?.savedAt ?? saved.savedAt,
    };
  }

  async saveSnapshot(data, cursor, savedAt) {
    this.snapshot = { ...structuredClone(data), cursor, savedAt };
  }

  async saveCheckpoint(cursor, savedAt) {
    this.checkpoint = { cursor, savedAt };
  }
}

async function makeTestServer(t, service = new ReportingService({
  client: new FakeHelpdeskClient(),
  store: new MemoryStateStore(),
  logger: { error() {} },
})) {
  const app = createApp({ reportingService: service });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    service.stop?.();
    server.close();
  });
  return { app, service, base: `http://127.0.0.1:${server.address().port}` };
}

test("health is immediate and readiness reflects initial data sync", async (t) => {
  const { base, service } = await makeTestServer(t);
  let response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  response = await fetch(`${base}/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ready: false });

  await service.initialize();
  response = await fetch(`${base}/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
});

test("GET /api/sla-report matches the contract structure and business calculations", async (t) => {
  const { base, service } = await makeTestServer(t);
  await service.initialize();

  const response = await fetch(`${base}/api/sla-report?from=2026-10-01&to=2026-10-31`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    from: "2026-10-01",
    to: "2026-10-31",
    requests: [
      {
        id: 1,
        site_id: 11,
        responder_id: 304,
        responder: "Current Name",
        response_business_minutes: 30,
        within_target: true,
        completed_late: true,
      },
      {
        id: 2,
        site_id: 11,
        responder_id: null,
        responder: null,
        response_business_minutes: null,
        within_target: null,
        completed_late: null,
      },
      {
        id: 3,
        site_id: 11,
        responder_id: 305,
        responder: "Same Name",
        response_business_minutes: 60,
        within_target: true,
        completed_late: null,
      },
    ],
    responders: [
      { id: 304, name: "Current Name", requests: 1, within_target: 1, completed_late: 1 },
      { id: 305, name: "Same Name", requests: 1, within_target: 1, completed_late: 0 },
    ],
  });
});

test("report endpoint returns 400 for missing, malformed, impossible, or reversed dates", async (t) => {
  const { base, service } = await makeTestServer(t);
  await service.initialize();

  for (const query of [
    "to=2026-10-31",
    "from=2026-02-30&to=2026-10-31",
    "from=10-01-2026&to=2026-10-31",
    "from=2026-10-02&to=2026-10-01",
  ]) {
    const response = await fetch(`${base}/api/sla-report?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("GET /api/requests applies filters, sort, and stable opaque cursor pages", async (t) => {
  const { base, service } = await makeTestServer(t);
  await service.initialize();
  service.requests.set(4, request(4, { priority: "High" }));
  service.eventsByRequestId.set(4, [
    { id: 401, status: "processing", at: baseAt + 1800, actor_id: 305, due_at: null, reverts_id: null },
  ]);

  const filtered = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&site_id=11&responder_id=304&priority=High&late=true&within_target=true&sort=-response_business_minutes&limit=2`);
  assert.equal(filtered.status, 200);
  const filteredBody = await filtered.json();
  assert.deepEqual(filteredBody.data.map((row) => row.id), [1]);
  assert.equal(filteredBody.next_cursor, null);
  assert.deepEqual(Object.keys(filteredBody.data[0]).sort(), [
    "completed_late",
    "id",
    "responder",
    "responder_id",
    "response_business_minutes",
    "site_id",
    "within_target",
  ]);

  const ascendingMinutes = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=response_business_minutes&limit=10`);
  assert.equal(ascendingMinutes.status, 200);
  assert.deepEqual((await ascendingMinutes.json()).data.map((row) => row.id), [1, 4, 3, 2]);

  const descendingMinutes = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=-response_business_minutes&limit=10`);
  assert.equal(descendingMinutes.status, 200);
  assert.deepEqual((await descendingMinutes.json()).data.map((row) => row.id), [3, 1, 4, 2]);

  const unprioritized = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&site_id=11&priority=null&sort=id`);
  assert.equal(unprioritized.status, 200);
  assert.deepEqual((await unprioritized.json()).data.map((row) => row.id), [2]);

  const lowPriority = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&priority=Low&responder_id=305&sort=id`);
  assert.equal(lowPriority.status, 200);
  assert.deepEqual((await lowPriority.json()).data.map((row) => row.id), [3]);

  const priorityPageOne = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&priority=High&sort=id&limit=1`);
  const priorityFirstBody = await priorityPageOne.json();
  assert.deepEqual(priorityFirstBody.data.map((row) => row.id), [1]);
  service.requests.get(4).priority = "Low"; // The cursor keeps the original filter snapshot.
  const priorityPageTwo = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&priority=High&sort=id&limit=1&cursor=${encodeURIComponent(priorityFirstBody.next_cursor)}`);
  assert.deepEqual((await priorityPageTwo.json()).data.map((row) => row.id), [4]);

  const first = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=-id&limit=1`);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.data.map((row) => row.id), [4]);
  assert.equal(typeof firstBody.next_cursor, "string");

  service.requests.set(5, request(5)); // New data is outside this walk's snapshot.
  const second = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=-id&limit=1&cursor=${encodeURIComponent(firstBody.next_cursor)}`);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(secondBody.data.map((row) => row.id), [3]);
  assert.equal(typeof secondBody.next_cursor, "string");

  const third = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=-id&limit=1&cursor=${encodeURIComponent(secondBody.next_cursor)}`);
  assert.equal(third.status, 200);
  const thirdBody = await third.json();
  assert.deepEqual(thirdBody.data.map((row) => row.id), [2]);
  assert.equal(typeof thirdBody.next_cursor, "string");

  const fourth = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&sort=-id&limit=1&cursor=${encodeURIComponent(thirdBody.next_cursor)}`);
  const fourthBody = await fourth.json();
  assert.deepEqual(fourthBody.data.map((row) => row.id), [1]);
  assert.equal(fourthBody.next_cursor, null);
});

test("GET /api/requests.csv exports all filtered rows in order with standard CSV escaping", async (t) => {
  const { base, service } = await makeTestServer(t);
  await service.initialize();
  service.staffById.set(304, { id: 304, name: 'Finance, "Ops"' });

  const response = await fetch(`${base}/api/requests.csv?from=2026-10-01&to=2026-10-31&site_id=11&sort=-id&limit=1&cursor=ignored`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/csv(?:;|$)/);
  assert.match(response.headers.get("content-disposition"), /attachment; filename="helpdesk-requests\.csv"/);
  assert.equal(await response.text(), [
    "id,site_id,responder_id,responder,response_business_minutes,within_target,completed_late",
    "3,11,305,Same Name,60,true,",
    "2,11,,,,,",
    '1,11,304,"Finance, ""Ops""",30,true,true',
    "",
  ].join("\r\n"));

  const filtered = await fetch(`${base}/api/requests.csv?from=2026-10-01&to=2026-10-31&responder_id=304&priority=High&within_target=true&sort=-id&limit=invalid&cursor=not-issued`);
  assert.equal(filtered.status, 200);
  const filteredLines = (await filtered.text()).trim().split("\r\n");
  assert.equal(filteredLines.length, 2);
  assert.equal(filteredLines[1], '1,11,304,"Finance, ""Ops""",30,true,true');
});

test("report cache reuses rows across ranges and invalidates when the change feed advances", async () => {
  const service = new ReportingService({
    client: new FakeHelpdeskClient(),
    store: new MemoryStateStore(),
    logger: { error() {} },
  });
  await service.initialize();
  const october = await service.getReport({ from: "2026-10-01", to: "2026-10-31" });
  const octoberAgain = await service.getReport({ from: "2026-10-01", to: "2026-10-31" });
  assert.strictEqual(octoberAgain, october);

  service.reportCache.clear(); // Force a new range calculation without clearing per-request rows.
  const sixMonths = await service.getReport({ from: "2026-05-01", to: "2026-10-31" });
  assert.strictEqual(sixMonths.requests[0], october.requests[0]);

  await service.refreshChanges();
  const refreshed = await service.getReport({ from: "2026-10-01", to: "2026-10-31" });
  assert.notStrictEqual(refreshed, october);
});

test("request-list invalid values and cursors return 400; unknown parameters are ignored", async (t) => {
  const { base, service } = await makeTestServer(t);
  await service.initialize();

  for (const query of [
    "from=2026-10-01&to=2026-10-31&limit=0",
    "from=2026-10-01&to=2026-10-31&sort=title",
    "from=2026-10-01&to=2026-10-31&late=yes",
    "from=2026-10-01&to=2026-10-31&site_id=abc",
    "from=2026-10-01&to=2026-10-31&priority=urgent",
    "from=2026-10-01&to=2026-10-31&cursor=not-issued",
  ]) {
    const response = await fetch(`${base}/api/requests?${query}`);
    assert.equal(response.status, 400, query);
  }

  const unknownIgnored = await fetch(`${base}/api/requests?from=2026-10-01&to=2026-10-31&extra=value&limit=1`);
  assert.equal(unknownIgnored.status, 200);
});

test("upstream failures map to a sanitized 502 response", async (t) => {
  const service = {
    ready: true,
    async getReport() { throw new Error("upstream response includes private details"); },
    async getRequests() { throw new InvalidCursorError(); },
  };
  const { base } = await makeTestServer(t, service);
  const response = await fetch(`${base}/api/sla-report?from=2026-10-01&to=2026-10-31`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Unable to retrieve report data" });
});
