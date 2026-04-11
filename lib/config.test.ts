import { describe, test, expect } from "bun:test"
import { homedir } from "os"
import { join } from "path"

describe("config", () => {
  test("BOT_DIR points to ~/.claude-bot", async () => {
    const { BOT_DIR } = await import("./config.ts")
    expect(BOT_DIR).toBe(join(homedir(), ".claude-bot"))
  })

  test("all subdirs are under BOT_DIR", async () => {
    const c = await import("./config.ts")
    expect(c.MEMORY_DIR).toBe(join(c.BOT_DIR, "memory"))
    expect(c.CRONS_DIR).toBe(join(c.BOT_DIR, "crons"))
    expect(c.PROCESSES_DIR).toBe(join(c.BOT_DIR, "processes"))
    expect(c.LOGS_DIR).toBe(join(c.BOT_DIR, "logs"))
    expect(c.PID_FILE).toBe(join(c.BOT_DIR, "daemon.pid"))
    expect(c.SESSION_FILE).toBe(join(c.BOT_DIR, "session-id"))
  })

  test("cron paths are under CRONS_DIR", async () => {
    const c = await import("./config.ts")
    expect(c.LAST_FIRED_FILE).toBe(join(c.CRONS_DIR, ".last-fired.json"))
    expect(c.RUNNING_FILE).toBe(join(c.CRONS_DIR, ".running.json"))
    expect(c.TRIGGER_DIR).toBe(join(c.CRONS_DIR, ".triggers"))
  })

  test("defaults have expected values", async () => {
    const c = await import("./config.ts")
    expect(c.DEFAULT_CRON_TIMEOUT).toBe(300)
    expect(c.DEFAULT_DREAM_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
    expect(c.CRON_CHECK_INTERVAL_MS).toBe(60_000)
    expect(c.TRIGGER_CHECK_INTERVAL_MS).toBe(5_000)
    expect(c.SHUTDOWN_TIMEOUT_MS).toBe(10_000)
    expect(c.SHUTDOWN_POLL_MS).toBe(500)
  })

  test("platform constants are defined", async () => {
    const c = await import("./config.ts")
    expect(c.LAUNCHD_LABEL).toBe("com.claude-bot.daemon")
    expect(c.SYSTEMD_SERVICE_NAME).toBe("claude-bot")
  })
})
