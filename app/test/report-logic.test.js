import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlaReport,
  businessSecondsBetween,
  calculateRequestRow,
  effectiveEvents,
} from "../src/domain/report-logic.js";

const singaporeSite = {
  id: 11,
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

const staff = new Map([
  [304, { id: 304, name: "Current Name" }],
  [305, { id: 305, name: "Another Responder" }],
]);

function request(overrides = {}) {
  return {
    id: 1,
    site_id: 11,
    status: "processing",
    priority: "High",
    created_at: "2026-10-05T00:00:00Z",
    deleted_at: null,
    merged_into_id: null,
    ...overrides,
  };
}

function event(id, status, at, overrides = {}) {
  return { id, status, at, actor_id: null, due_at: null, reverts_id: null, ...overrides };
}

test("filters request rows by site-local creation date and excludes canceled, deleted, and merged requests", () => {
  const requests = [
    request({ id: 1, created_at: "2026-10-01T16:30:00Z" }), // Oct 2 in Singapore
    request({ id: 2, created_at: "2026-10-31T16:30:00Z" }), // Nov 1 in Singapore
    request({ id: 3, status: "canceled" }),
    request({ id: 4, deleted_at: "2026-10-06T00:00:00Z" }),
    request({ id: 5, merged_into_id: 9 }),
  ];

  const report = buildSlaReport({
    from: "2026-10-01",
    to: "2026-10-31",
    requests,
    sitesById: new Map([[11, singaporeSite]]),
  });

  assert.deepEqual(report.requests.map((row) => row.id), [1]);
  assert.deepEqual(report.responders, []);
});

test("finds the earliest processing event with an actor after sorting and removing duplicates", () => {
  const events = [
    event(3, "processing", 1791162000, { actor_id: 305, actor_name: "Historical name" }),
    event(2, "processing", 1791161000, { actor_id: null }),
    event(1, "processing", 1791160500, { actor_id: 304 }),
    event(1, "processing", 1791160500, { actor_id: 304 }),
  ];
  const normalized = effectiveEvents(events);
  assert.equal(normalized.length, 3);

  const row = calculateRequestRow(request(), {
    events,
    site: singaporeSite,
    staffById: staff,
  });
  assert.equal(row.responder_id, 304);
  assert.equal(row.responder, "Current Name");
});

test("ignores both an undone event and its reverting event", () => {
  const events = [
    event(1, "processing", 1791160500, { actor_id: 304 }),
    event(2, "processing", 1791160600, { actor_id: 305, reverts_id: 1 }),
    event(3, "processing", 1791161000, { actor_id: 305 }),
  ];
  const row = calculateRequestRow(request(), { events, site: singaporeSite, staffById: staff });
  assert.equal(row.responder_id, 305);
});

test("counts business time across weekend and excludes site holidays", () => {
  const start = Date.parse("2026-10-09T17:30:00+08:00"); // Friday 17:30 local
  const end = Date.parse("2026-10-12T09:30:00+08:00"); // Monday 09:30 local
  assert.equal(businessSecondsBetween(start, end, singaporeSite), 7200);
  assert.equal(businessSecondsBetween(start, end, singaporeSite, [{ date: "12/10/2026" }]), 1800);
});

test("floors accumulated business seconds to minutes and applies priority thresholds", () => {
  const row = calculateRequestRow(request({ priority: "Medium" }), {
    events: [event(1, "processing", Math.floor(Date.parse("2026-10-05T00:02:59Z") / 1000), { actor_id: 304 })],
    site: singaporeSite,
    staffById: staff,
  });
  assert.equal(row.response_business_minutes, 2);
  assert.equal(row.within_target, true);

  const highAtLimit = calculateRequestRow(request(), {
    events: [event(2, "processing", Math.floor(Date.parse("2026-10-05T01:00:00Z") / 1000), { actor_id: 304 })],
    site: singaporeSite,
    staffById: staff,
  });
  assert.equal(highAtLimit.response_business_minutes, 60);
  assert.equal(highAtLimit.within_target, true);
});

test("applies the inclusive response target for every priority including null", () => {
  const cases = [
    ["High", "2026-10-05T01:01:00Z", false],
    ["Medium", "2026-10-05T04:00:00Z", true],
    ["Medium", "2026-10-05T04:01:00Z", false],
    ["Low", "2026-10-05T08:00:00Z", true],
    [null, "2026-10-05T08:01:00Z", false],
  ];
  for (const [priority, responseAt, expected] of cases) {
    const row = calculateRequestRow(request({ priority }), {
      events: [event(1, "processing", Math.floor(Date.parse(responseAt) / 1000), { actor_id: 304 })],
      site: singaporeSite,
      staffById: staff,
    });
    assert.equal(row.within_target, expected, `${priority} at ${responseAt}`);
  }
});

test("clamps a response earlier than creation to zero business minutes", () => {
  const row = calculateRequestRow(request(), {
    events: [event(1, "processing", Math.floor(Date.parse("2026-10-04T23:59:00Z") / 1000), { actor_id: 304 })],
    site: singaporeSite,
    staffById: staff,
  });
  assert.equal(row.response_business_minutes, 0);
  assert.equal(row.within_target, true);
});

test("sets response fields to null when no qualifying response exists", () => {
  const row = calculateRequestRow(request(), {
    events: [event(1, "processing", 1791160500, { actor_id: null })],
    site: singaporeSite,
    staffById: staff,
  });
  assert.equal(row.responder_id, null);
  assert.equal(row.responder, null);
  assert.equal(row.response_business_minutes, null);
  assert.equal(row.within_target, null);
});

test("uses the last complete event and the latest deadline even after a reopen", () => {
  const events = [
    event(4, "processing", 1791165600, { due_at: "05/10/2026 12:00" }), // reopened and deadline extended
    event(3, "complete", 1791162000),
    event(2, "pending", 1791161000, { due_at: "05/10/2026 10:00" }),
    event(1, "complete", 1791160000),
  ];
  const row = calculateRequestRow(request(), { events, site: singaporeSite });
  assert.equal(row.completed_late, false);

  const late = calculateRequestRow(request(), {
    events: [event(1, "complete", Math.floor(Date.parse("2026-10-05T02:01:00Z") / 1000), { due_at: "05/10/2026 10:00" })],
    site: singaporeSite,
  });
  assert.equal(late.completed_late, true);
});

test("deadline comparison is strict and missing completion or deadline yields null", () => {
  const exact = calculateRequestRow(request(), {
    events: [event(1, "complete", Math.floor(Date.parse("2026-10-05T02:00:00Z") / 1000), { due_at: "05/10/2026 10:00" })],
    site: singaporeSite,
  });
  assert.equal(exact.completed_late, false);

  const missingDeadline = calculateRequestRow(request(), {
    events: [event(2, "complete", 1791165600)],
    site: singaporeSite,
  });
  const missingCompletion = calculateRequestRow(request(), {
    events: [event(3, "pending", 1791165600, { due_at: "05/10/2026 10:00" })],
    site: singaporeSite,
  });
  assert.equal(missingDeadline.completed_late, null);
  assert.equal(missingCompletion.completed_late, null);
});

test("uses site-specific time zones and handles a Sydney daylight-saving schedule", () => {
  const sydney = {
    id: 12,
    timezone: "Australia/Sydney",
    business_hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: { open: "01:00", close: "04:00" } },
  };
  const start = Date.parse("2026-10-03T14:00:00Z"); // Sunday 01:00 before DST starts
  const end = Date.parse("2026-10-03T18:00:00Z"); // Sunday 05:00 after the jump
  assert.equal(businessSecondsBetween(start, end, sydney), 7200);
});

test("aggregates responder counts by ID rather than potentially duplicate names", () => {
  const requests = [request({ id: 1 }), request({ id: 2 })];
  const report = buildSlaReport({
    from: "2026-10-01",
    to: "2026-10-31",
    requests,
    eventsByRequestId: new Map([
      [1, [event(1, "processing", 1791160500, { actor_id: 304 })]],
      [2, [event(2, "processing", 1791160500, { actor_id: 305 })]],
    ]),
    sitesById: new Map([[11, singaporeSite]]),
    staffById: new Map([
      [304, { id: 304, name: "Same Name" }],
      [305, { id: 305, name: "Same Name" }],
    ]),
  });
  assert.equal(report.responders.length, 2);
  assert.deepEqual(report.responders.map(({ requests: count }) => count), [1, 1]);
});
