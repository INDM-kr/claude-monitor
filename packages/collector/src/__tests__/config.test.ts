import { expect, it } from "vitest";
import { assertRuntime, diagnosticCode, loadCollectorConfig } from "../config.js";

it("validates runtime, directory, timezone and numeric settings without silently substituting defaults", () => {
  expect(() => assertRuntime("24.11.0")).not.toThrow();
  for (const version of ["18.20.0", "22.0.0", "24.10.0", "25.0.0"]) expect(() => assertRuntime(version)).toThrow("unsupported_node");
  expect(() => loadCollectorConfig({ CM_DATA_DIR: "relative" })).toThrow("invalid_data_directory");
  expect(() => loadCollectorConfig({ CM_TIMEZONE: "invalid/example" })).toThrow("invalid_timezone");
  for (const value of ["0", "-1", "NaN", "1.5", "", "2147483648"]) expect(() => loadCollectorConfig({ CM_COLLECTOR_BATCH_SIZE: value })).toThrow("invalid_config");
  expect(() => loadCollectorConfig({ CM_COLLECTOR_ENABLED: "typo" })).toThrow("invalid_config");
  expect(loadCollectorConfig({ CM_COLLECTOR_ENABLED: "0", CM_DB_BUSY_TIMEOUT_MS: "150" })).toMatchObject({ enabled: false, busyTimeoutMs: 150 });
});

it("diagnostics do not expose filesystem paths or source error messages", () => {
  expect(diagnosticCode(new Error("secret prompt at /private/example"))).toBe("storage_open_failed");
  expect(diagnosticCode({ code: "SQLITE_NOTADB", message: "/private/path" })).toBe("database_corrupt");
  expect(diagnosticCode({ code: "EACCES" })).toBe("storage_permission_denied");
});
