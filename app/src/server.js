import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8080);

const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
  app.locals.reportingService.start().catch((error) => {
    console.error("Initial helpdesk sync failed:", error.message);
  });
});
