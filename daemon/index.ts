import { homedir } from "os"
import { join } from "path"
import { mkdir, writeFile, unlink } from "fs/promises"
import { sendMessage, getSessionId } from "./session.ts"
import { startCronScheduler, stopCronScheduler } from "./cron.ts"
import { startProcesses, stopProcesses } from "./process.ts"

const BOT_DIR = join(homedir(), ".claude-bot")
const PID_FILE = join(BOT_DIR, "daemon.pid")
const LOGS_DIR = join(BOT_DIR, "logs")

function log(message: string): void {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`)
}

async function ensureDirs(): Promise<void> {
  await mkdir(BOT_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })
  await mkdir(join(BOT_DIR, "crons"), { recursive: true })
  await mkdir(join(BOT_DIR, "memory"), { recursive: true })
  await mkdir(join(BOT_DIR, "processes"), { recursive: true })
}

async function writePid(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid), "utf-8")
}

async function removePid(): Promise<void> {
  try { await unlink(PID_FILE) } catch {}
}

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down...`)
  stopProcesses()
  stopCronScheduler()
  await removePid()
  log("Daemon stopped")
  process.exit(0)
}

async function main(): Promise<void> {
  await ensureDirs()
  await writePid()
  log(`Daemon starting (PID ${process.pid})`)

  // Initialize bot session
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

  // Start cron scheduler
  startCronScheduler()
  log("Cron scheduler started")

  // Start background processes
  await startProcesses()
  log("Process manager started")

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
