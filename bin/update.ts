#!/usr/bin/env bun
// claude-bot self-update entrypoint. Prints exactly ONE line of JSON to stdout so a parent
// process (Bismuth's "Update claude-bot daemon…" command) can spawn it and parse the result.
//   --check     -> getUpdateStatus(): { available, behind, local, remote }
//   --dry-run   -> runUpdate({ dryRun: true }): { action: "would-update"|"up-to-date"|… }
//   (default)   -> runUpdate(): git pull --ff-only + bun install + restart the daemon
import { runUpdate, getUpdateStatus } from "../lib/update.ts"

const args = new Set(Bun.argv.slice(2))

try {
  if (args.has("--check")) {
    console.log(JSON.stringify(await getUpdateStatus()))
  } else {
    console.log(JSON.stringify(await runUpdate({ dryRun: args.has("--dry-run") })))
  }
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
}
