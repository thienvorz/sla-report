import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HelpdeskClient } from "./services/helpdesk.js";
import { createReportRouter } from "./controllers/report-controller.js";
import { ReportingService } from "./services/reporting-service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  reportingService = new ReportingService({ client: new HelpdeskClient() }),
} = {}) {
  const app = express();
  app.locals.reportingService = reportingService;

  app.use(express.static(path.join(here, "..", "public")));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", (req, res) => {
    if (reportingService.ready) return res.json({ ready: true });
    return res.status(503).json({ ready: false });
  });

  app.use(createReportRouter(reportingService));

  return app;
}
