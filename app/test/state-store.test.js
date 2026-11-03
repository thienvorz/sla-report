import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { FileStateStore } from "../src/store/state-store.js";

test("file state store atomically persists report data and the latest cursor checkpoint", async (t) => {
  const temporaryRoot = path.join(process.cwd(), "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "sla-report-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStateStore(path.join(directory, "state.json"));
  const state = {
    requests: new Map([[1, { id: 1, status: "pending" }]]),
    eventsByRequestId: new Map([[1, [{ id: 10, status: "processing" }]]]),
    sitesById: new Map([[11, { id: 11, timezone: "Asia/Singapore" }]]),
    holidaysBySiteId: new Map([[11, [{ date: "01/01/2026" }]]]),
    staffById: new Map([[304, { id: 304, name: "Current name" }]]),
  };

  await store.saveSnapshot(state, "snapshot-cursor", 100);
  await store.saveCheckpoint("latest-cursor", 200);
  const restored = await store.load();

  assert.equal(restored.cursor, "latest-cursor");
  assert.equal(restored.savedAt, 200);
  assert.deepEqual(restored.requests.get(1), { id: 1, status: "pending" });
  assert.deepEqual(restored.eventsByRequestId.get(1), [{ id: 10, status: "processing" }]);
  assert.deepEqual(restored.sitesById.get(11), { id: 11, timezone: "Asia/Singapore" });
  assert.deepEqual(restored.holidaysBySiteId.get(11), [{ date: "01/01/2026" }]);
  assert.deepEqual(restored.staffById.get(304), { id: 304, name: "Current name" });
});
