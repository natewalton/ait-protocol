"use strict";

// Local PLC launcher. It mirrors @did-plc/server's executable setup while
// constraining only this server's Express app to IPv4 loopback.
const { Database, PlcServer } = require("@did-plc/server");

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
  const plc = PlcServer.create({ db, port });
  const listen = plc.app.listen.bind(plc.app);
  plc.app.listen = (listenPort, ...args) =>
    listen(listenPort, "127.0.0.1", ...args);
  await plc.start();
  console.log(`👤 PLC server is running at http://localhost:${port}`);
};

main().catch((err) => {
  console.error("PLC failed to start:", err);
  process.exit(1);
});
