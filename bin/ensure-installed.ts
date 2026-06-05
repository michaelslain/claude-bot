#!/usr/bin/env bun
// Non-interactive, idempotent installer entrypoint for claude-bot.
// Prints exactly ONE line of JSON to stdout, so a parent process (Bismuth) can
// spawn it and parse the result.
//   --status    -> getInstallStatus(): { installed, running, daemonLabel, home, plistPath }
//   (default)   -> ensureInstalled():  { action: "adopted"|"installed"|"would-install", status }
//   --dry-run   -> ensureInstalled({ dryRun: true })
import { getInstallStatus, ensureInstalled } from "../lib/install.ts"

const args = new Set(Bun.argv.slice(2))

try {
  if (args.has("--status")) {
    console.log(JSON.stringify(getInstallStatus()))
  } else {
    console.log(JSON.stringify(await ensureInstalled({ dryRun: args.has("--dry-run") })))
  }
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
}
