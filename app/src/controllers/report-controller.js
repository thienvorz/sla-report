import { Router } from "express";

class RequestValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function oneString(query, key) {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestValidationError(`${key} must have one value`);
  return value;
}

function validateDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestValidationError(`${name} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RequestValidationError(`${name} must be a valid date`);
  }
  return value;
}

function dateRange(query) {
  const from = validateDate(oneString(query, "from"), "from");
  const to = validateDate(oneString(query, "to"), "to");
  if (from > to) throw new RequestValidationError("from must be on or before to");
  return { from, to };
}

function optionalId(query, key) {
  const value = oneString(query, key);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new RequestValidationError(`${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RequestValidationError(`${key} must be a positive integer`);
  }
  return parsed;
}

function optionalBoolean(query, key) {
  const value = oneString(query, key);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") {
    throw new RequestValidationError(`${key} must be true or false`);
  }
  return value === "true";
}

function optionalPriority(query) {
  const value = oneString(query, "priority");
  if (value === undefined) return undefined;
  if (value === "null") return null;
  if (!["Low", "Medium", "High"].includes(value)) {
    throw new RequestValidationError("priority must be Low, Medium, High, or null");
  }
  return value;
}

export function parseRequestFilters(query) {
  const range = dateRange(query);
  const sort = oneString(query, "sort") ?? "id";
  if (!new Set(["id", "-id", "response_business_minutes", "-response_business_minutes"]).has(sort)) {
    throw new RequestValidationError("sort is invalid");
  }

  return {
    ...range,
    site_id: optionalId(query, "site_id"),
    responder_id: optionalId(query, "responder_id"),
    priority: optionalPriority(query),
    late: optionalBoolean(query, "late"),
    within_target: optionalBoolean(query, "within_target"),
    sort,
  };
}

export function parseRequestListQuery(query) {
  const filters = parseRequestFilters(query);

  const rawLimit = oneString(query, "limit") ?? "50";
  if (!/^\d+$/.test(rawLimit)) throw new RequestValidationError("limit must be an integer from 1 to 200");
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RequestValidationError("limit must be an integer from 1 to 200");
  }

  const cursor = oneString(query, "cursor");
  if (cursor !== undefined && cursor.length === 0) throw new RequestValidationError("cursor is invalid");

  return {
    ...filters,
    limit,
    cursor,
  };
}

const CSV_COLUMNS = [
  "id",
  "site_id",
  "responder_id",
  "responder",
  "response_business_minutes",
  "within_target",
  "completed_late",
];

function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeRequestsCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvField(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function sendError(res, error) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
  const message = status === 502 ? "Unable to retrieve report data" : error.message;
  if (status >= 500) console.error("Reporting request failed:", error.name);
  res.status(status).json({ error: message });
}

export function createReportRouter(reportingService) {
  const router = Router();

  router.get("/api/sla-report", async (req, res) => {
    try {
      const range = dateRange(req.query);
      res.json(await reportingService.getReport(range));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/api/requests.csv", async (req, res) => {
    try {
      const filters = parseRequestFilters(req.query);
      const rows = await reportingService.getAllRequests(filters);
      res
        .type("text/csv")
        .attachment("helpdesk-requests.csv")
        .send(serializeRequestsCsv(rows));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/api/requests", async (req, res) => {
    try {
      const query = parseRequestListQuery(req.query);
      res.json(await reportingService.getRequests(query));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
