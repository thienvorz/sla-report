import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function arrayEntries(value, key) {
  if (!Array.isArray(value)) throw new TypeError(`Invalid persisted ${key}`);
  return value;
}

function asMap(value, key) {
  return new Map(arrayEntries(value, key));
}

export class FileStateStore {
  constructor(filePath = process.env.REPORT_STATE_PATH
    || path.resolve(process.cwd(), "data", "report-state.json")) {
    this.filePath = path.resolve(filePath);
    this.checkpointPath = `${this.filePath}.cursor.json`;
  }

  async load() {
    const saved = await readJsonIfPresent(this.filePath);
    if (saved === null) return null;
    if (saved.version !== STATE_VERSION) throw new TypeError("Unsupported persisted report state version");

    const checkpoint = await readJsonIfPresent(this.checkpointPath);
    if (checkpoint && checkpoint.version !== STATE_VERSION) {
      throw new TypeError("Unsupported persisted synchronization checkpoint version");
    }
    const cursor = checkpoint ? checkpoint.cursor : saved.cursor;
    if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
      throw new TypeError("Invalid persisted synchronization cursor");
    }

    return {
      cursor,
      savedAt: checkpoint?.savedAt ?? saved.savedAt ?? 0,
      requests: asMap(saved.requests, "requests"),
      eventsByRequestId: asMap(saved.eventsByRequestId, "eventsByRequestId"),
      sitesById: asMap(saved.sitesById, "sitesById"),
      holidaysBySiteId: asMap(saved.holidaysBySiteId, "holidaysBySiteId"),
      staffById: asMap(saved.staffById, "staffById"),
    };
  }

  async saveSnapshot(state, cursor, savedAt) {
    const snapshot = {
      version: STATE_VERSION,
      cursor,
      savedAt,
      requests: [...state.requests],
      eventsByRequestId: [...state.eventsByRequestId],
      sitesById: [...state.sitesById],
      holidaysBySiteId: [...state.holidaysBySiteId],
      staffById: [...state.staffById],
    };
    await atomicWrite(this.filePath, JSON.stringify(snapshot));
  }

  async saveCheckpoint(cursor, savedAt) {
    const checkpoint = { version: STATE_VERSION, cursor, savedAt };
    await atomicWrite(this.checkpointPath, JSON.stringify(checkpoint));
  }
}
