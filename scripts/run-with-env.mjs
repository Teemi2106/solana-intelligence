import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const commands = {
  web: { cwd: root, args: [resolve(root, "node_modules/next/dist/bin/next"), "dev", "apps/web"] },
  worker: { cwd: root, args: ["--import", "tsx", "apps/worker/src/main.ts"] },
  "telegram-test": { cwd: root, args: ["apps/worker/dist/telegram-connectivity.js"] },
  "wallet-reprocess": { cwd: root, args: ["--import", "tsx", "scripts/reprocess-wallet.mjs", ...process.argv.slice(3)] },
  "db-generate": { cwd: resolve(root, "packages/db"), args: [resolve(root, "node_modules/drizzle-kit/bin.cjs"), "generate"] },
  "db-migrate": { cwd: resolve(root, "packages/db"), args: ["--import", "tsx", "src/migrate.ts"] },
};
const command = commands[target];
if (!command) throw new Error(`Unknown local command: ${String(target)}`);

const environment = { ...process.env };
for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (!match) continue;
  const [, name, rawValue] = match;
  if (!name || rawValue === undefined || environment[name] !== undefined) continue;
  const quoted = (rawValue.startsWith("'") && rawValue.endsWith("'")) || (rawValue.startsWith('"') && rawValue.endsWith('"'));
  environment[name] = quoted ? rawValue.slice(1, -1) : rawValue;
}

const child = spawn(process.execPath, command.args, { cwd: command.cwd, env: environment, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
