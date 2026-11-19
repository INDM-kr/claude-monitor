import { afterEach, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { CollectorController } from "../../dist/controller.js";
import { openStorage } from "../storage.js";
import { testConfig } from "./helpers.js";

const controllers: CollectorController[] = [], directories: string[] = [], children: ChildProcess[] = [];
function controller() {
  const c = new CollectorController(testConfig()); controllers.push(c); directories.push(c.config.dataDir); return c;
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  await Promise.all(controllers.splice(0).map(c => c.stop()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  delete globalThis.__claudeMonitorCollector;
});

it("coalesces starts, stops cleanly and reopens with the same persistent device", async () => {
  const c = controller();
  expect(c.start()).toBe(c.start());
  const ready = await c.start(); expect(ready.state).toBe("ready");
  expect(ready.ingestionState).toBe("not_started");
  await c.stop(); expect(c.status().state).toBe("stopped");
  expect((await c.start()).deviceId).toBe(ready.deviceId);
  await c.stop();
  const reopened = await openStorage(c.config); reopened.close();
});

it("stops during initialization without leaving a writer behind", async () => {
  const c = controller();
  await Promise.all([c.start(), c.stop()]);
  expect(c.status().state).toBe("stopped");
  const storage = await openStorage(c.config); storage.close();
});

it("reports unexpected worker exit and permits explicit recovery", async () => {
  const c = controller(); await c.start();
  // Terminate only the worker created by this test; no product kill endpoint exists.
  await (c as unknown as { worker: Worker }).worker.terminate();
  expect(c.status()).toMatchObject({ state: "error", diagnostic: "worker_exited", workerId: null });
  expect(await c.start()).toMatchObject({ state: "error", diagnostic: "worker_exited" });
  expect((await c.restart()).state).toBe("ready");
});

it("rejects another OS process writer, then recovers the OS lock after that process dies", async () => {
  const c = controller();
  const child = fork(new URL("./fixtures/host.mjs", import.meta.url), [], {
    execArgv: [], env: { ...process.env, CM_DATA_DIR: c.config.dataDir, CM_COLLECTOR_ENABLED: "true", CLAUDE_PROJECTS_DIR: c.config.projectsDir, CM_CODEX_DIR: c.config.codexDir! },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  const [first] = await once(child, "message"); expect(first.state).toBe("ready");
  expect(await c.start()).toMatchObject({ state: "error", diagnostic: "writer_busy" });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  expect((await c.restart()).state).toBe("ready");
});

it("preserves the process singleton across module reloads", async () => {
  const c = testConfig(); directories.push(c.dataDir);
  const firstModule = await import("../../dist/singleton.js");
  const first = firstModule.getProcessCollector(c); controllers.push(first);
  const ready = await first.start();
  vi.resetModules();
  const reloaded = await import("../../dist/singleton.js");
  const second = reloaded.getProcessCollector();
  expect(second).toBe(first);
  expect((await second.start()).workerId).toBe(ready.workerId);
});

it("disabled mode neither creates a database nor starts a worker", async () => {
  const c = controller();
  const disabled = new CollectorController({ ...c.config, enabled: false, dataDir: join(c.config.dataDir, "unused") });
  controllers.push(disabled);
  expect(await disabled.start()).toMatchObject({ state: "disabled", workerId: null });
  expect(existsSync(disabled.config.dataDir)).toBe(false);
});

it("bounds startup time and reclaims the worker before reporting timeout", async () => {
  const c = controller();
  const limited = new CollectorController({ ...c.config, startupTimeoutMs: 1 }); controllers.push(limited);
  expect(await limited.start()).toMatchObject({ state: "error", diagnostic: "worker_start_timeout", workerId: null });
  const storage = await openStorage(c.config); storage.close();
});
