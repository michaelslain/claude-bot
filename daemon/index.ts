import { mkdir, writeFile, unlink } from "fs/promises"
import { sendMessage, getSessionId } from "./session.ts"
import { startCronScheduler, stopCronScheduler, recoverInterruptedCrons, waitForRunningJobs } from "./cron.ts"
import { startProcesses, stopProcesses, reapOrphans, startProcessTriggers, stopProcessTriggers } from "./process.ts"
import { heartbeatDevice, isOwner } from "../lib/owner.ts"
import { BOT_DIR, PID_FILE, LOGS_DIR, SHUTDOWN_TIMEOUT_MS, CRONS_DIR, MEMORY_DIR, PROCESSES_DIR } from "../lib/config.ts"

function log(message: string): void {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`)
}

async function ensureDirs(): Promise<void> {
  await mkdir(BOT_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })
  await mkdir(CRONS_DIR, { recursive: true })
  await mkdir(MEMORY_DIR, { recursive: true })
  await mkdir(PROCESSES_DIR, { recursive: true })
}

async function writePid(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid), "utf-8")
}

async function removePid(): Promise<void> {
  try { await unlink(PID_FILE) } catch {}
}

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down...`)
  stopCronScheduler()
  stopProcessTriggers()
  await waitForRunningJobs(SHUTDOWN_TIMEOUT_MS)
  await stopProcesses()
  await removePid()
  log("Daemon stopped")
  process.exit(0)
}

async function main(): Promise<void> {
  await ensureDirs()
  await writePid()
  log(`Daemon starting (PID ${process.pid})`)

  // Reap orphans from a previous daemon instance BEFORE starting fresh
  // children. Without this, processes that survived the previous daemon's
  // exit (because launchctl SIGKILL'd it before its shutdown handler
  // finished, or because it crashed) end up running alongside the new
  // children we're about to spawn — accumulating duplicates per restart.
  await reapOrphans()
  log("Orphan reaping complete")

  // Start background processes immediately — they're standalone scripts,
  // independent of the bot session
  await startProcesses()
  log("Process manager started")

  // Start polling for process trigger files (the symmetric counterpart of the
  // cron trigger loop). An external program flips a process's frontmatter and
  // drops a trigger file; this loop reconciles its runtime to match disk.
  startProcessTriggers()
  log("Process trigger watcher started")

  // Recover crons that were interrupted by the previous shutdown BEFORE starting
  // the scheduler. Recovery re-fires interrupted jobs and populates the in-memory
  // runningJobs set; the scheduler's catch-up pass then correctly skips them via
  // the `!runningJobs.has(job.name)` guard. Reversing this order causes catch-up
  // to markRunning first, after which recovery sees those jobs already running
  // and markDone's them — wiping live entries from .running.json.
  // Safe to run before session init because fireJob uses newSession: true.
  await recoverInterruptedCrons()

  // Heartbeat this device immediately so it's selectable before the first tick.
  await heartbeatDevice()

  // Start cron scheduler (tick loop only — crons wait for session on fire).
  // The tick keeps heartbeating and gates cron firing on ownership, so the
  // scheduler runs on every device; only the owner fires jobs.
  startCronScheduler()
  log("Cron scheduler started")

  // Only the owner device starts/keeps the persistent bot session active. A
  // non-owner daemon idles (but keeps heartbeating via the cron tick). When
  // unclaimed (no owner.json) isOwner() is true => behaves exactly as before.
  if (await isOwner()) {
    // Initialize bot session (can take 30+ seconds)
    log("Initializing bot session...")
    try {
      const response = await sendMessage(
        "You are now running as a background daemon. Check memory for any prior context. Set up any crons you need."
      )
      log(`Bot session initialized (session: ${response.sessionId})`)
    } catch (err) {
      log(`Warning: Failed to initialize bot session: ${err}`)
      log("Continuing anyway — session will be created on first message")
    }

    const sessionId = await getSessionId()
    log(`Daemon ready (session: ${sessionId ?? "pending"})`)
  } else {
    log("Not the owner device — idling (heartbeating only, no session, no crons)")
  }

  // Graceful shutdown
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch(async (err) => {
  console.error(`Fatal error: ${err}`)
  process.exit(1)
})
