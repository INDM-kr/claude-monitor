import { Worker } from "node:worker_threads";
import type { CollectorStatus } from "@claude-monitor/core";
import { diagnosticCode, CollectorError, DEFAULTS, type CollectorConfig } from "./config.js";

export class CollectorController {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private requests = new Map<number, {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  request<T = unknown>(method:string, payload?:unknown):Promise<T> {
    if(!this.worker || this.statusValue.state!=="ready") return Promise.reject(new CollectorError(this.statusValue.diagnostic??"collector_unavailable"));
    const requestId=++this.nextRequestId;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.requests.delete(requestId);reject(new CollectorError("request_timeout"));},DEFAULTS.requestTimeoutMs);
      this.requests.set(requestId,{resolve:resolve as (v:unknown)=>void,reject,timer});
      this.worker!.postMessage({type:"request",requestId,method,payload});
    });
  }
  private startPromise: Promise<CollectorStatus> | null = null;
  private stopPromise: Promise<void> | null = null;
  private statusValue: CollectorStatus;

  constructor(readonly config: CollectorConfig) {
    this.statusValue = { state: config.enabled ? "stopped" : "disabled", ingestionState: "not_started",
      workerId: null, schemaVersion: null, deviceId: null, diagnostic: null };
  }

  status(): CollectorStatus { return { ...this.statusValue }; }

  start(): Promise<CollectorStatus> {
    if (this.startPromise) return this.startPromise;
    if (!this.config.enabled || this.statusValue.state === "error" || this.stopPromise) return Promise.resolve(this.status());
    this.statusValue = { ...this.statusValue, state: "starting", diagnostic: null, deviceId: null, schemaVersion: null };
    this.startPromise = new Promise(resolve => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: this.config });
      } catch (error) {
        this.statusValue = { ...this.statusValue, state: "error", diagnostic: diagnosticCode(error) };
        resolve(this.status()); return;
      }
      this.worker = worker;
      this.statusValue.workerId = worker.threadId;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true; clearTimeout(timeout); resolve(this.status());
      };
      const timeout = setTimeout(() => {
        if (settled || this.statusValue.state === "stopping") return;
        this.statusValue = { ...this.statusValue, state: "error", diagnostic: this.statusValue.diagnostic ?? "worker_start_timeout" };
        void worker.terminate(); // exit handler resolves only after the lock is released
      }, this.config.startupTimeoutMs);
      worker.on("message", (message: { type: string; diagnostic?: string; schemaVersion?: number; deviceId?: string; requestId?: number; result?: unknown; error?: string; progress?: Partial<CollectorStatus> }) => {
        if(message.type === "response") { const pending=this.requests.get(message.requestId!);if(pending){clearTimeout(pending.timer);this.requests.delete(message.requestId!);message.error?pending.reject(new CollectorError(message.error)):pending.resolve(message.result);}return; }
        if(message.type === "progress") {this.statusValue={...this.statusValue,...message.progress};return;}
        if (this.statusValue.state !== "starting") return;
        if (message.type === "ready") {
          this.statusValue = { ...this.statusValue, state: "ready", schemaVersion: message.schemaVersion!, deviceId: message.deviceId! };
          finish();
        } else if (message.type === "error") {
          this.statusValue = { ...this.statusValue, state: "error", diagnostic: message.diagnostic ?? "worker_failed" };
          // Wait for exit before allowing a restart of a failed initialization.
        }
      });
      worker.on("error", () => {
        this.statusValue = { ...this.statusValue, state: "error", diagnostic: this.statusValue.diagnostic ?? "worker_failed" };
      });
      worker.on("exit", () => {
        for(const pending of this.requests.values()){clearTimeout(pending.timer);pending.reject(new CollectorError("worker_exited"));}this.requests.clear();
        this.worker = null;
        this.startPromise = null;
        const expected = this.statusValue.state === "stopping";
        this.statusValue = { ...this.statusValue, workerId: null, state: expected ? "stopped" : "error",
          diagnostic: expected ? null : this.statusValue.diagnostic ?? "worker_exited" };
        finish();
      });
      worker.unref();
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const worker = this.worker;
    if (!worker) { this.startPromise = null; return Promise.resolve(); }
    this.statusValue.state = "stopping";
    this.stopPromise = new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        this.statusValue = { ...this.statusValue, state: "error", diagnostic: "worker_shutdown_timeout" };
        void worker.terminate();
      }, this.config.shutdownTimeoutMs);
      worker.once("exit", () => { clearTimeout(timeout); resolve(); });
      worker.postMessage({ type: "stop" });
    }).finally(() => { this.startPromise = null; this.stopPromise = null; });
    return this.stopPromise;
  }

  async restart(): Promise<CollectorStatus> {
    await this.stop();
    this.statusValue = { ...this.statusValue, state: this.config.enabled ? "stopped" : "disabled", diagnostic: null };
    return this.start();
  }
}
