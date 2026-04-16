import { mkdir, writeFile, unlink } from "fs/promises"
import { sendMessage, getSessionId } from "./session.ts"
import { startCronScheduler, stopCronScheduler, recoverInterruptedCrons, waitForRunningJobs } from "./cron.ts"
import { startProcesses, stopProcesses } from "./process.ts"
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

  // Start background processes immediately — they're standalone scripts,
  // independent of the bot session
  await startProcesses()
  log("Process manager started")

  // Recover crons that were interrupted by the previous shutdown BEFORE starting
  // the scheduler. Recovery re-fires interrupted jobs and populates the in-memory
  // runningJobs set; the scheduler's catch-up pass then correctly skips them via
  // the `!runningJobs.has(job.name)` guard. Reversing this order causes catch-up
  // to markRunning first, after which recovery sees those jobs already running
  // and markDone's them — wiping live entries from .running.json.
  // Safe to run before session init because fireJob uses newSession: true.
  await recoverInterruptedCrons()

  // Start cron scheduler (tick loop only — crons wait for session on fire)
  startCronScheduler()
  log("Cron scheduler started")

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

  // Graceful shutdown
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch(async (err) => {
  console.error(`Fatal error: ${err}`)
  process.exit(1)
})
