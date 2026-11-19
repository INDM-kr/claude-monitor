#!/usr/bin/env node
// Prints an opt-in settings fragment; never edits ~/.claude/settings.json.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const config = JSON.parse(await readFile(new URL("./runtime-hook-config.json", import.meta.url), "utf8"));
const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
const command = `${quote(process.execPath)} ${quote(fileURLToPath(new URL("./runtime-hook.mjs", import.meta.url)))}`;
console.log(JSON.stringify({ hooks: Object.fromEntries(config.events.map(event => [event, [{ hooks: [{ type: "command", command, timeout: 2 }] }]])) }, null, 2));
