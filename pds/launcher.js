"use strict";

// Minimal PDS launcher for the AIT network.
// Modeled on bluesky-social/pds/service/index.js, stripped of production-only
// concerns (TLS check route, etc.).

const {
  PDS,
  envToCfg,
  envToSecrets,
  readEnv,
  httpLogger,
} = require("@atproto/pds");
const pkg = require("@atproto/pds/package.json");

const main = async () => {
  const env = readEnv();
  env.version ||= pkg.version;
  const cfg = envToCfg(env);
  const secrets = envToSecrets(env);
  const pds = await PDS.create(cfg, secrets);
  await pds.start();
  httpLogger.info(`pds started on port ${cfg.service.port}`);

  process.on("SIGTERM", async () => {
    httpLogger.info("pds stopping");
    await pds.destroy();
    httpLogger.info("pds stopped");
  });
};

main().catch((err) => {
  console.error("pds failed to start:", err);
  process.exit(1);
});
