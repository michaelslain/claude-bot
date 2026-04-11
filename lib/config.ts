import { homedir } from "os"
import { join } from "path"

// ── Root ────────────────────────────────────────────────────────────────────

export const BOT_DIR = join(homedir(), ".claude-bot")

// ── Subdirectories ──────────────────────────────────────────────────────────

export const MEMORY_DIR = join(BOT_DIR, "memory")
export const CRONS_DIR = join(BOT_DIR, "crons")
export const PROCESSES_DIR = join(BOT_DIR, "processes")
export const LOGS_DIR = join(BOT_DIR, "logs")

// ── Files ───────────────────────────────────────────────────────────────────

export const PID_FILE = join(BOT_DIR, "daemon.pid")
export const SESSION_FILE = join(BOT_DIR, "session-id")
export const LAST_FIRED_FILE = join(CRONS_DIR, ".last-fired.json")
export const RUNNING_FILE = join(CRONS_DIR, ".running.json")
export const TRIGGER_DIR = join(CRONS_DIR, ".triggers")

// ── Timeouts & intervals ────────────────────────────────────────────────────

/** Default cron job session timeout in seconds */
export const DEFAULT_CRON_TIMEOUT = 300

/** Dream consolidation interval (6 hours) */
export const DEFAULT_DREAM_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How often the cron scheduler checks for jobs to fire */
export const CRON_CHECK_INTERVAL_MS = 60_000

/** How often to check for manual trigger files */
export const TRIGGER_CHECK_INTERVAL_MS = 5_000

/** How long to wait for running jobs during shutdown */
export const SHUTDOWN_TIMEOUT_MS = 10_000

/** Polling interval during shutdown wait */
export const SHUTDOWN_POLL_MS = 500

/** Process restart backoff reset threshold */
export const RESTART_BACKOFF_RESET_MS = 5 * 60_000

/** Max backoff cap for process restarts */
export const RESTART_BACKOFF_MAX_MS = 60_000

// ── Platform service names ──────────────────────────────────────────────────

export const LAUNCHD_LABEL = "com.claude-bot.daemon"
export const SYSTEMD_SERVICE_NAME = "claude-bot"
