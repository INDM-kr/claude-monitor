import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CollectorError, DEFAULTS, dataDirectory } from "./config.js";

// Kept free of storage/SQLite imports: the hook process loads this on every Claude hook event.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const MAX_TOKEN_FILE_BYTES = 1024;

export type RuntimeHookToken =
  | { token: string; source: "env" | "file" }
  | { token: null; source: "none"; diagnostic?: string };

/**
 * Environment first (an explicit empty value disables hooks), then the private token file in
 * the data directory. The token value is never part of a diagnostic.
 */
export function resolveRuntimeHookToken(env: NodeJS.ProcessEnv = process.env): RuntimeHookToken {
  const fromEnv = env.CM_RUNTIME_HOOK_TOKEN;
  if (fromEnv !== undefined) return fromEnv ? { token: fromEnv, source: "env" } : { token: null, source: "none" };
  let path: string;
  try { path = join(dataDirectory(env), DEFAULTS.runtimeHookTokenFile); }
  catch (error) { return { token: null, source: "none", diagnostic: error instanceof CollectorError ? error.code : "invalid_data_directory" }; }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { token: null, source: "none" };
    return { token: null, source: "none", diagnostic: "runtime_token_unreadable" };
  }
  try {
    const stat = fstatSync(fd);
    const owner = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (owner !== undefined && stat.uid !== owner)) {
      return { token: null, source: "none", diagnostic: "runtime_token_not_private" };
    }
    if (stat.size > MAX_TOKEN_FILE_BYTES) return { token: null, source: "none", diagnostic: "runtime_token_invalid" };
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, read).toString("utf8").trim();
    return TOKEN_PATTERN.test(token) ? { token, source: "file" } : { token: null, source: "none", diagnostic: "runtime_token_invalid" };
  } finally { closeSync(fd); }
}

/** Creates the token file once (0600 in a 0700 data directory). Never returns or prints the token. */
export function createRuntimeHookToken(env: NodeJS.ProcessEnv = process.env): { created: boolean; path: string } {
  const directory = dataDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) throw new CollectorError("data_directory_not_private");
  const path = join(directory, DEFAULTS.runtimeHookTokenFile);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, path };
    throw error;
  }
  try { writeSync(fd, randomBytes(32).toString("base64url")); fsyncSync(fd); }
  finally { closeSync(fd); }
  return { created: true, path };
}
