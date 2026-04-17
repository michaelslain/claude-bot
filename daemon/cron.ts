import { join } from "path"
import { readdir, readFile, writeFile, unlink, rename, mkdir } from "fs/promises"
import { execFile } from "child_process"
import { promisify } from "util"
import { sendMessage } from "./session"

const execFileAsync = promisify(execFile)
import { notify } from "../lib/platform"
import { parseFrontmatter } from "../lib/frontmatter"

export { CRONS_DIR } from "../lib/config.ts"
import { CRONS_DIR, PROCESSES_DIR, LAST_FIRED_FILE, RUNNING_FILE, TRIGGER_DIR, DEFAULT_CRON_TIMEOUT, CRON_CHECK_INTERVAL_MS, TRIGGER_CHECK_INTERVAL_MS, SHUTDOWN_POLL_MS } from "../lib/config.ts"

export interface CronExpression {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

export interface CronJob {
  name: string
  schedule: string
  cron: CronExpression
  prompt: string
  catchup: boolean
  enabled: boolean
  notify: boolean
  model?: string
  effort?: string
  /** Session timeout in seconds. Default: 300 (5 min). */
  timeout: number
  /** Process pattern to monitor after session ends (matched via pgrep -f). */
  waitFor?: string
}

function parseCronFrontmatter(name: string, frontmatter: Record<string, string>, body: string): CronJob | null {
  const schedule = frontmatter.schedule
  if (!schedule) return null
  const cron = parseCronExpression(schedule)
  if (!cron) return null
  return {
    name: frontmatter.name ?? name,
    schedule,
    cron,
    prompt: body,
    catchup: frontmatter.catchup === "true",
    enabled: frontmatter.enabled !== "false",
    notify: frontmatter.notify === "true",
    model: frontmatter.model,
    effort: frontmatter.effort,
    timeout: frontmatter.timeout ? parseInt(frontmatter.timeout, 10) : DEFAULT_CRON_TIMEOUT,
    waitFor: frontmatter.waitFor,
  }
}

export function parseCronExpression(expr: string): CronExpression | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const minute = fields[0]!
  const hour = fields[1]!
  const dayOfMonth = fields[2]!
  const month = fields[3]!
  const dayOfWeek = fields[4]!
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

function matchesField(field: string, value: number): boolean {
  if (field === "*") return true

  // Step: */N
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10)
    if (isNaN(step) || step <= 0) return false
    return value % step === 0
  }

  // Range: 1-5 (reject malformed like 1-2-3)
  if (field.includes("-") && !field.includes(",")) {
    const parts = field.split("-")
    if (parts.length !== 2) return false
    const start = Number(parts[0])
    const end = Number(parts[1])
    if (isNaN(start) || isNaN(end)) return false
    return value >= start && value <= end
  }

  // List: 1,5,10
  if (field.includes(",")) {
    return field.split(",").some((part) => {
      const num = parseInt(part.trim(), 10)
      return !isNaN(num) && num === value
    })
  }

  // Exact number
  const num = parseInt(field, 10)
  if (isNaN(num)) return false
  return num === value
}

export function shouldFire(cron: CronExpression, now: Date): boolean {
  return (
    matchesField(cron.minute, now.getMinutes()) &&
    matchesField(cron.hour, now.getHours()) &&
    matchesField(cron.dayOfMonth, now.getDate()) &&
    matchesField(cron.month, now.getMonth() + 1) &&
    matchesField(cron.dayOfWeek, now.getDay())
  )
}

export async function loadCronJobs(): Promise<CronJob[]> {
  let files: string[]
  try {
    files = await readdir(CRONS_DIR)
  } catch {
    return []
  }

  const jobs: CronJob[] = []
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    try {
      const content = await readFile(join(CRONS_DIR, file), "utf-8")
      const { frontmatter, body } = parseFrontmatter(content)
      const job = parseCronFrontmatter(file.replace(/\.md$/, ""), frontmatter, body)
      if (job) jobs.push(job)
    } catch {
      // skip unreadable files
    }
  }
  return jobs
}

let cronInterval: ReturnType<typeof setInterval> | null = null
let triggerInterval: ReturnType<typeof setInterval> | null = null
const runningJobs = new Set<string>()
const jobAbortControllers = new Map<string, AbortController>()

export interface LastFiredEntry {
  timestamp: string
  result: "success" | "failed" | "unknown" | "killed"
}

export async function loadLastFired(): Promise<Record<string, LastFiredEntry>> {
  try {
    const raw = await readFile(LAST_FIRED_FILE, "utf-8")
    const parsed = JSON.parse(raw)
    // Migrate old format (plain string timestamps) to new format
    const result: Record<string, LastFiredEntry> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = { timestamp: value, result: "success" }
      } else {
        result[key] = value as LastFiredEntry
      }
    }
    return result
  } catch {
    return {}
  }
}

// Per-file serial write queue. Without this, two concurrent saves race on the
// shared .tmp filename (ENOENT on rename) AND clobber each other's updates
// (load-modify-save read the same baseline, last writer wins).
const writeQueues = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  writeQueues.set(file, next)
  // Don't leak the chain forever: when this run is the tail, drop the entry.
  next.catch(() => {}).finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  })
  return next
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  // Unique per-write tmp name so even outside the mutex two writers can't collide.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8")
  await rename(tmp, file)
}

/**
 * Read-modify-write LAST_FIRED_FILE under the file's serial queue.
 * Always uses fresh on-disk state so concurrent updates merge instead of clobbering.
 */
async function updateLastFired(name: string, entry: LastFiredEntry): Promise<void> {
  await enqueueWrite(LAST_FIRED_FILE, async () => {
    const data = await loadLastFired()
    data[name] = entry
    await atomicWriteJson(LAST_FIRED_FILE, data)
  })
}

// ── Running crons tracking ──────────────────────────────────────────────────

export interface RunningEntry {
  startedAt: string
}

export async function loadRunning(): Promise<Record<string, RunningEntry>> {
  try {
    const raw = await readFile(RUNNING_FILE, "utf-8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function markRunning(name: string): Promise<void> {
  console.log(`[cron] markRunning: ${name}`)
  await enqueueWrite(RUNNING_FILE, async () => {
    const data = await loadRunning()
    data[name] = { startedAt: new Date().toISOString() }
    await atomicWriteJson(RUNNING_FILE, data)
  })
}

async function markDone(name: string): Promise<void> {
  console.log(`[cron] markDone: ${name}`)
  await enqueueWrite(RUNNING_FILE, async () => {
    const data = await loadRunning()
    delete data[name]
    await atomicWriteJson(RUNNING_FILE, data)
  })
}

function getIntervalMs(cron: CronExpression): number {
  // Estimate the interval from the cron expression for catch-up decisions
  if (cron.minute.startsWith("*/")) return parseInt(cron.minute.slice(2), 10) * 60_000
  if (cron.hour.startsWith("*/")) return parseInt(cron.hour.slice(2), 10) * 3600_000

  // Weekly: specific day-of-week with wildcard day-of-month
  if (cron.dayOfWeek !== "*" && cron.dayOfMonth === "*") return 7 * 24 * 3600_000

  // Monthly: specific day-of-month
  if (cron.dayOfMonth !== "*") return 30 * 24 * 3600_000

  // Daily: specific hour with wildcard days
  if (cron.hour !== "*") return 24 * 3600_000

  // Hourly: specific minute with wildcard hour
  if (cron.minute !== "*") return 3600_000

  // Default: assume every minute
  return 60_000
}

function shouldCatchUp(job: CronJob, lastFired: Record<string, LastFiredEntry>): boolean {
  if (!job.catchup) return false
  const last = lastFired[job.name]
  if (!last) return true // never fired — catch up
  const elapsed = Date.now() - new Date(last.timestamp).getTime()
  const interval = getIntervalMs(job.cron)
  // Missed if more than 1.5x the interval has passed since last fire
  return elapsed > interval * 1.5
}

const CRON_RESULT_INSTRUCTION = `\n\nIMPORTANT: When you are done, print exactly [CRON_RESULT:SUCCESS] if the task completed successfully, or [CRON_RESULT:FAILURE] if it failed. This must be the last thing you print.`

function parseCronResult(output: string): "success" | "failed" | "unknown" {
  // Search from the end for the last marker
  const successIdx = output.lastIndexOf("[CRON_RESULT:SUCCESS]")
  const failureIdx = output.lastIndexOf("[CRON_RESULT:FAILURE]")
  if (successIdx === -1 && failureIdx === -1) return "unknown"
  if (successIdx > failureIdx) return "success"
  return "failed"
}

// ── Protected directory guard ───────────────────────────────────────��──────
// Snapshot .md files in crons/ and processes/ before a cron session runs,
// then restore any that were modified or deleted by the session.

async function snapshotDir(dir: string): Promise<Map<string, string>> {
  const snap = new Map<string, string>()
  try {
    const files = await readdir(dir)
    for (const f of files) {
      if (!f.endsWith(".md")) continue
      try {
        snap.set(f, await readFile(join(dir, f), "utf-8"))
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return snap
}

async function restoreDir(dir: string, snapshot: Map<string, string>, jobName: string): Promise<void> {
  // Restore modified or deleted files
  for (const [file, content] of snapshot) {
    try {
      const current = await readFile(join(dir, file), "utf-8")
      if (current !== content) {
        console.warn(`[cron] Guard: "${jobName}" modified ${dir}/${file} — reverting`)
        await writeFile(join(dir, file), content, "utf-8")
      }
    } catch {
      // File was deleted — restore it
      console.warn(`[cron] Guard: "${jobName}" deleted ${dir}/${file} — restoring`)
      await writeFile(join(dir, file), content, "utf-8")
    }
  }
  // Delete files that were created by the session (not in snapshot)
  try {
    const currentFiles = await readdir(dir)
    for (const f of currentFiles) {
      if (!f.endsWith(".md")) continue
      if (!snapshot.has(f)) {
        console.warn(`[cron] Guard: "${jobName}" created ${dir}/${f} — removing`)
        await unlink(join(dir, f))
      }
    }
  } catch { /* dir doesn't exist */ }
}

// ── Process pattern monitoring ─────────────────────────────────────────────
// After a cron session ends, if `waitFor` is set, poll for matching processes
// via pgrep -f. This catches orphaned processes that get reparented to PID 1.

async function hasMatchingProcesses(pattern: string): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-f", pattern], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function waitForProcessPattern(
  pattern: string,
  timeoutMs: number,
  jobName: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!(await hasMatchingProcesses(pattern))) return
    console.log(`[cron] "${jobName}": waiting for processes matching "${pattern}"`)
    await new Promise(resolve => setTimeout(resolve, 5000))
  }

  if (await hasMatchingProcesses(pattern)) {
    console.warn(`[cron] "${jobName}": timed out waiting for processes matching "${pattern}"`)
  }
}

/**
 * Start a cron job: marks it as running (in-memory + on-disk) synchronously,
 * then runs the session in the background. Callers should await this to ensure
 * .running.json is written before proceeding.
 */
async function fireJob(job: CronJob, lastFired: Record<string, LastFiredEntry>): Promise<void> {
  const ac = new AbortController()
  runningJobs.add(job.name)
  jobAbortControllers.set(job.name, ac)
  const startedAt = Date.now()
  await markRunning(job.name)

  // Guard only the running cron's OWN definition file, not the entire
  // crons directory. The old approach (snapshotDir of all .md) reverted
  // legitimate external edits to sibling crons that happened while this
  // job was running. Self-modification is the real threat.
  const ownCronFile = join(CRONS_DIR, `${job.name}.md`)
  let ownCronContent: string | null = null
  try { ownCronContent = await readFile(ownCronFile, "utf-8") } catch {}
  const procSnap = await snapshotDir(PROCESSES_DIR)

  // Run the actual session in the background (not awaited by caller)
  const sessionPromise = (async () => {
    try {
      const prompt = `[Cron: ${job.name}] ${job.prompt}${CRON_RESULT_INSTRUCTION}`
      const response = await sendMessage(prompt, { model: job.model, effort: job.effort, abortController: ac, timeoutSecs: job.timeout, newSession: true })

      if (job.waitFor) {
        const remainingMs = Math.max(0, job.timeout * 1000 - (Date.now() - startedAt))
        if (remainingMs > 0) {
          await waitForProcessPattern(job.waitFor, remainingMs, job.name)
        }
      }

      const result = parseCronResult(response.result)
      const entry: LastFiredEntry = { timestamp: new Date().toISOString(), result }
      lastFired[job.name] = entry
      await updateLastFired(job.name, entry)
      if (job.notify) {
        const status = result === "success" ? "completed" : result === "failed" ? "failed" : "completed (unknown result)"
        notify(`claude-bot: ${job.name}`, response.result || `Cron job ${status}.`)
      }
    } catch (err) {
      if (ac.signal.aborted) {
        // Record as killed if stopCronJob hasn't already
        if (!lastFired[job.name] || lastFired[job.name].result !== "killed") {
          const entry: LastFiredEntry = { timestamp: new Date().toISOString(), result: "killed" }
          lastFired[job.name] = entry
          await updateLastFired(job.name, entry)
        }
        return
      }
      console.error(`[cron] Failed to fire job "${job.name}":`, err)
      const entry: LastFiredEntry = { timestamp: new Date().toISOString(), result: "failed" }
      lastFired[job.name] = entry
      await updateLastFired(job.name, entry)
      if (job.notify) {
        notify(`claude-bot: ${job.name}`, `Failed: ${err}`)
      }
    } finally {
      // Restore the running cron's own definition if it self-modified.
      // Other crons + external edits are NOT reverted (previous bug).
      if (ownCronContent !== null) {
        try {
          const current = await readFile(ownCronFile, "utf-8")
          if (current !== ownCronContent) {
            console.warn(`[cron] Guard: "${job.name}" modified its own definition — reverting`)
            await writeFile(ownCronFile, ownCronContent, "utf-8")
          }
        } catch {
          // File deleted by session — restore it
          console.warn(`[cron] Guard: "${job.name}" deleted its own definition — restoring`)
          await writeFile(ownCronFile, ownCronContent, "utf-8")
        }
      }
      // Process definitions are still broadly guarded (rarely edited externally)
      await restoreDir(PROCESSES_DIR, procSnap, job.name)
      jobAbortControllers.delete(job.name)
      await markDone(job.name)
      runningJobs.delete(job.name)
    }
  })()

  // Catch unhandled rejections from the background session
  sessionPromise.catch((err) => console.error(`[cron] Unhandled error in "${job.name}":`, err))
}

/**
 * Re-fire any crons that were still in .running.json when the daemon died.
 * MUST be called BEFORE startCronScheduler(): recovery populates runningJobs
 * so the scheduler's catch-up pass skips these jobs. If startCronScheduler()
 * runs first, its catch-up IIFE adds jobs to runningJobs, and the branch below
 * at "!runningJobs.has(name)" flips — the else branch markDone()s live jobs.
 */
export async function recoverInterruptedCrons(): Promise<void> {
  const running = await loadRunning()
  const names = Object.keys(running)
  if (names.length === 0) return

  console.log(`[cron] Recovering interrupted crons: ${names.join(", ")}`)
  const [jobs, lastFired] = await Promise.all([loadCronJobs(), loadLastFired()])
  const jobMap = new Map(jobs.map((j) => [j.name, j]))

  for (const name of names) {
    const job = jobMap.get(name)
    if (job && job.enabled && !runningJobs.has(name)) {
      console.log(`[cron] Re-firing interrupted cron: ${name}`)
      // Await fireJob to ensure .running.json + in-memory state are set before continuing
      await fireJob(job, lastFired)
    } else {
      // Job no longer exists or is disabled — clean up stale entry
      await markDone(name)
    }
  }
}

export function startCronScheduler(): void {
  if (cronInterval !== null) return

  // Run catch-up check immediately on start
  ;(async () => {
    const [jobs, lastFired] = await Promise.all([loadCronJobs(), loadLastFired()])
    for (const job of jobs) {
      if (job.enabled && shouldCatchUp(job, lastFired) && !runningJobs.has(job.name)) {
        console.log(`[cron] Catch-up firing: ${job.name}`)
        await fireJob(job, lastFired) // await ensures .running.json is written before next iteration
      }
    }
  })()

  // Check for MCP trigger files every 5 seconds for fast response
  triggerInterval = setInterval(() => { processTriggers() }, TRIGGER_CHECK_INTERVAL_MS)

  cronInterval = setInterval(async () => {
    const now = new Date()
    const [jobs, lastFired] = await Promise.all([loadCronJobs(), loadLastFired()])
    for (const job of jobs) {
      if (!job.enabled || runningJobs.has(job.name)) continue
      // Fire on schedule OR when overdue (catchup). Without the catchup
      // check here, a missed/failed/killed run waits until the next daemon
      // restart to be retried.
      if (shouldFire(job.cron, now) || shouldCatchUp(job, lastFired)) {
        fireJob(job, lastFired)
      }
    }
  }, CRON_CHECK_INTERVAL_MS)
}

export function stopCronScheduler(): void {
  if (cronInterval !== null) {
    clearInterval(cronInterval)
    cronInterval = null
  }
  if (triggerInterval !== null) {
    clearInterval(triggerInterval)
    triggerInterval = null
  }
}

/**
 * Returns a promise that resolves when all currently running cron jobs finish.
 * Used during graceful shutdown. Resolves after a timeout to prevent hanging.
 */
export async function waitForRunningJobs(timeoutMs: number = 10_000): Promise<void> {
  if (runningJobs.size === 0) return

  console.log(`[cron] Waiting for ${runningJobs.size} running job(s) to finish (timeout: ${timeoutMs}ms)...`)

  const start = Date.now()
  while (runningJobs.size > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS))
  }

  if (runningJobs.size > 0) {
    console.warn(`[cron] Shutdown timeout — ${runningJobs.size} job(s) still running, aborting`)
    for (const [, ac] of jobAbortControllers) {
      ac.abort()
    }
  }
}

// ── Cron CRUD helpers ────────────────────────────────────────────────────────

async function loadCronJob(name: string): Promise<CronJob | null> {
  try {
    const content = await readFile(join(CRONS_DIR, `${name}.md`), "utf-8")
    const { frontmatter, body } = parseFrontmatter(content)
    return parseCronFrontmatter(name, frontmatter, body)
  } catch {
    return null
  }
}

export async function runCronJob(name: string): Promise<{ ok: boolean; error?: string }> {
  if (runningJobs.has(name)) return { ok: false, error: `Cron job "${name}" is already running. Call cron_stop first to kill it.` }

  const job = await loadCronJob(name)
  if (!job) return { ok: false, error: `Cron job "${name}" not found` }

  const lastFired = await loadLastFired()
  await fireJob(job, lastFired) // await ensures .running.json is written before returning
  return { ok: true }
}

/**
 * Write a trigger file so the daemon picks up the run request on its next tick.
 * Used by the MCP server (separate process) instead of runCronJob directly.
 */
export async function requestCronRun(name: string): Promise<{ ok: boolean; error?: string }> {
  const job = await loadCronJob(name)
  if (!job) return { ok: false, error: `Cron job "${name}" not found` }

  await mkdir(TRIGGER_DIR, { recursive: true })
  await writeFile(join(TRIGGER_DIR, name), new Date().toISOString(), "utf-8")
  return { ok: true }
}

/**
 * Check for trigger files written by the MCP server and fire those jobs.
 */
async function processTriggers(): Promise<void> {
  let files: string[]
  try {
    files = await readdir(TRIGGER_DIR)
  } catch {
    return
  }

  const triggers = files.filter(f => !f.startsWith("."))
  if (triggers.length === 0) return

  const lastFired = await loadLastFired()
  for (const name of triggers) {
    try { await unlink(join(TRIGGER_DIR, name)) } catch {}

    if (runningJobs.has(name)) {
      console.log(`[cron] Trigger for "${name}" ignored — already running`)
      continue
    }

    const job = await loadCronJob(name)
    if (!job) {
      console.warn(`[cron] Trigger for unknown job "${name}" — skipping`)
      continue
    }

    console.log(`[cron] Trigger firing: ${name}`)
    await fireJob(job, lastFired)
  }
}

export async function stopCronJob(name: string): Promise<{ ok: boolean; error?: string }> {
  const ac = jobAbortControllers.get(name)
  if (!ac) return { ok: false, error: `Cron job "${name}" is not running` }

  ac.abort()

  // Record as killed
  await updateLastFired(name, { timestamp: new Date().toISOString(), result: "killed" })

  // Clean up running state (fireJob's finally block will also run, but we do it eagerly)
  await markDone(name)

  console.log(`[cron] Stopped running job "${name}"`)
  return { ok: true }
}

function buildCronFile(opts: { name: string; schedule: string; model?: string; effort?: string; catchup?: boolean; notify?: boolean; enabled?: boolean; timeout?: number; waitFor?: string; prompt: string }): string {
  const lines = ["---"]
  lines.push(`name: ${opts.name}`)
  lines.push(`schedule: ${opts.schedule}`)
  if (opts.model) lines.push(`model: ${opts.model}`)
  if (opts.effort) lines.push(`effort: ${opts.effort}`)
  if (opts.timeout && opts.timeout !== DEFAULT_CRON_TIMEOUT) lines.push(`timeout: ${opts.timeout}`)
  if (opts.waitFor) lines.push(`waitFor: ${opts.waitFor}`)
  if (opts.catchup) lines.push(`catchup: true`)
  if (opts.notify) lines.push(`notify: true`)
  if (opts.enabled === false) lines.push(`enabled: false`)
  lines.push("---")
  lines.push("")
  lines.push(opts.prompt)
  lines.push("")
  return lines.join("\n")
}

export async function createCronJob(opts: { name: string; schedule: string; prompt: string; model?: string; effort?: string; catchup?: boolean; notify?: boolean; enabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const cron = parseCronExpression(opts.schedule)
  if (!cron) return { ok: false, error: `Invalid cron schedule: "${opts.schedule}"` }

  const filePath = join(CRONS_DIR, `${opts.name}.md`)
  if (await Bun.file(filePath).exists()) return { ok: false, error: `Cron job "${opts.name}" already exists` }

  await Bun.write(filePath, buildCronFile(opts))
  return { ok: true }
}

export async function deleteCronJob(name: string): Promise<{ ok: boolean; error?: string }> {
  const filePath = join(CRONS_DIR, `${name}.md`)
  try {
    await unlink(filePath)
    return { ok: true }
  } catch {
    return { ok: false, error: `Cron job "${name}" not found` }
  }
}

export async function updateCronJob(name: string, updates: { enabled?: boolean; schedule?: string; model?: string; effort?: string; catchup?: boolean; notify?: boolean; waitFor?: string; prompt?: string }): Promise<{ ok: boolean; error?: string }> {
  const filePath = join(CRONS_DIR, `${name}.md`)
  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return { ok: false, error: `Cron job "${name}" not found` }
  }

  const { frontmatter, body } = parseFrontmatter(content)

  if (updates.schedule !== undefined) {
    if (!parseCronExpression(updates.schedule)) return { ok: false, error: `Invalid cron schedule: "${updates.schedule}"` }
    frontmatter.schedule = updates.schedule
  }
  if (updates.enabled !== undefined) frontmatter.enabled = String(updates.enabled)
  if (updates.model !== undefined) frontmatter.model = updates.model
  if (updates.effort !== undefined) frontmatter.effort = updates.effort
  if (updates.catchup !== undefined) frontmatter.catchup = String(updates.catchup)
  if (updates.notify !== undefined) frontmatter.notify = String(updates.notify)
  if (updates.waitFor !== undefined) frontmatter.waitFor = updates.waitFor

  const newPrompt = updates.prompt ?? body

  await Bun.write(filePath, buildCronFile({
    name,
    schedule: frontmatter.schedule!,
    model: frontmatter.model,
    effort: frontmatter.effort,
    timeout: frontmatter.timeout ? parseInt(frontmatter.timeout, 10) : undefined,
    catchup: frontmatter.catchup === "true",
    notify: frontmatter.notify === "true",
    enabled: frontmatter.enabled !== "false",
    waitFor: frontmatter.waitFor,
    prompt: newPrompt,
  }))
  return { ok: true }
}
