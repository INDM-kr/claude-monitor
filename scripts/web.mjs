import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkRuntime } from "./check-runtime.mjs";

// Official Next custom-server API: one owner for HTTP, worker startup and shutdown.
checkRuntime();
const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) throw new Error("Usage: node scripts/web.mjs dev|start");
process.env.NODE_ENV = mode === "dev" ? "development" : "production";
const defaults = JSON.parse(readFileSync(new URL("./web-config.json", import.meta.url), "utf8"));
const directory = fileURLToPath(new URL("../packages/web/", import.meta.url));
const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
const next = requireWeb("next");
const { getProcessCollector } = await import(pathToFileURL(requireWeb.resolve("@claude-monitor/collector")).href);
const bindHost = process.env.HOSTNAME || defaults.hostname;
const port = Number(process.env.PORT || defaults.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1..65535");
const collector = getProcessCollector();
const app = next({ dev: mode === "dev", dir: directory, hostname: bindHost, port });
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
  void handler(request, response).catch(() => {
    console.error("[web] request_failed");
    if (!response.headersSent) { response.statusCode = 500; response.end("Internal server error"); }
    else response.destroy();
  });
});
// NextCustomServer attaches its WebSocket handler on the first HTTP request.
let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    console.error("[web] shutdown_timeout");
    process.exit(1);
  }, Math.max(defaults.shutdownGraceMs, collector.config.shutdownTimeoutMs + 1000));
  server.close();
  server.closeAllConnections();
  const outcomes = await Promise.allSettled([collector.stop(), app.close()]);
  const status = collector.status();
  console.log(`[collector] ${status.state}${status.diagnostic ? ` ${status.diagnostic}` : ""}`);
  clearTimeout(deadline);
  const workerFailed = ["worker_shutdown_timeout", "worker_failed", "worker_exited"].includes(status.diagnostic);
  process.exit(outcomes.some(r => r.status === "rejected") || workerFailed ? 1 : exitCode);
}
// Keep handlers installed: pnpm/shell process groups can forward the same signal twice.
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

try {
  const status = await collector.start();
  console.log(`[collector] ${status.state}${status.diagnostic ? ` ${status.diagnostic}` : ""}`);
  await app.prepare();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bindHost, resolve); });
  console.log(`[web] ${mode} listening on ${bindHost}:${port}`);
} catch (error) {
  // Next startup failures (for example a missing production build) must be actionable.
  // Storage/source failures are separately reduced to safe collector diagnostic codes.
  console.error(`[web] start_failed ${error.code || "initialization"}: ${error.message}`);
  await shutdown(1);
}
