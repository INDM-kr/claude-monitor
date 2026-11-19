#!/usr/bin/env node
// Creates the private hook token file once (0600 in the data directory). Never prints the token value.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
const { createRuntimeHookToken } = await import(pathToFileURL(requireWeb.resolve("@claude-monitor/collector/runtime-token")).href);
const { created, path } = createRuntimeHookToken(process.env);
console.log(`${created ? "created" : "unchanged (already exists)"}: ${path}`);
console.log("The server and hooks read this file whenever CM_RUNTIME_HOOK_TOKEN is unset; no restart is needed.");
