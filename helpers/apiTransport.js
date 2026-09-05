const https = require("node:https");
const path = require("node:path");

// Explicit bootstrap opt-in. No POST retry or public-NLB fallback after enable.
function apiTransport(endpoint) {
  if (!["/zero/news/process", "/zero/reward/card"].includes(endpoint)) {
    throw new Error("Unsupported Zero API endpoint");
  }
  const appDirectory = process.env.TWINKLE_API_HOST_DIRECTORY;
  if (!appDirectory) return { url: `${process.env.API_URL}${endpoint}`, config: {} };
  if (appDirectory !== "/home/ec2-user/server") throw new Error("Invalid Zero API host directory");
  const helper = require(path.join(appDirectory, ".runtime-current/dist/runtimeHostConfig.js"));
  const host = helper.readRuntimeHostConfig(appDirectory);
  if (!host || host.role !== "primary") throw new Error("Zero requires the primary host configuration");
  helper.verifyConfiguredHostIdentity(host);
  const destination = helper.readRuntimeServingHost(appDirectory);
  const address = destination === "primary" ? host.primaryAddress : host.targetAddress;
  return {
    url: `https://api.twinkle.network:8443${endpoint}`,
    config: {
      proxy: false,
      maxRedirects: 0,
      httpsAgent: new https.Agent({
        keepAlive: false,
        rejectUnauthorized: true,
        servername: "api.twinkle.network",
        lookup: (hostname, options, callback) => {
          if (hostname !== "api.twinkle.network") return callback(new Error("Invalid API destination"));
          if (options.all) return callback(null, [{ address, family: 4 }]);
          callback(null, address, 4);
        },
      }),
    },
  };
}

module.exports = { apiTransport };
