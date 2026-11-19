import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function satisfies(version, range) {
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const bounds = /^>=(\d+)(?:\.(\d+)\.(\d+))? <(\d+)$/.exec(range);
  if (!actual || !bounds) return false;
  const parts = actual.slice(1).map(Number);
  const minimum = [Number(bounds[1]), Number(bounds[2] ?? 0), Number(bounds[3] ?? 0)];
  if (parts[0] >= Number(bounds[4])) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

export function checkRuntime(nodeVersion = process.versions.node, pnpmVersion) {
  if (!satisfies(nodeVersion, engines.node)) throw new Error(`Node ${engines.node} required; found ${nodeVersion}`);
  if (pnpmVersion === undefined) {
    const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`pnpm ${engines.pnpm} required; pnpm was not found or failed`);
    pnpmVersion = result.stdout.trim();
  }
  if (!satisfies(pnpmVersion, engines.pnpm)) throw new Error(`pnpm ${engines.pnpm} required; found ${pnpmVersion}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { checkRuntime(); console.log("Runtime requirements satisfied"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
