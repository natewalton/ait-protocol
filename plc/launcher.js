"use strict";

// Local PLC launcher. It mirrors @did-plc/server's executable setup while
// constraining only this server's Express app to IPv4 loopback.
const { Database, PlcServer } = require("@did-plc/server");
const express = require("express");

// Parse before the upstream app: its error handler assumes its request logger
// ran, but that logger follows JSON parsing. This keeps decoded bodies bounded
// and gives parser failures a stable response without exposing a stack trace.
const createPlcServer = (options) => {
  const plc = PlcServer.create(options);
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(plc.app);
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.too.large") {
      return res.status(413).json({ message: "Request body too large" });
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ message: "Invalid JSON" });
    }
    return res.status(500).json({ message: "Internal Server Error" });
  });
  plc.app = app;
  const listen = app.listen.bind(app);
  app.listen = (port, ...args) => listen(port, "127.0.0.1", ...args);
  return plc;
};

module.exports = { createPlcServer };

const main = async () => {
  const dbUrl = process.env.DATABASE_URL;
  let db;
  if (dbUrl) {
    const pgDb = Database.postgres({ url: dbUrl });
    await pgDb.migrateToLatestOrThrow();
    db = pgDb;
  } else {
    db = Database.mock();
  }
  const envPort = parseInt(process.env.PORT || "", 10);
  const port = Number.isNaN(envPort) ? 2582 : envPort;
  const plc = createPlcServer({ db, port });
  await plc.start();
  console.log(`👤 PLC server is running at http://localhost:${port}`);
};

if (require.main === module) main().catch((err) => {
  console.error("PLC failed to start:", err);
  process.exit(1);
});
