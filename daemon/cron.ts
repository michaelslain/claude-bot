import { homedir } from "os"
import { join } from "path"
import { readdir, readFile, writeFile, unlink } from "fs/promises"
import { sendMessage } from "./session"
import { notify } from "../lib/platform"
import { parseFrontmatter } from "../lib/frontmatter"

export const CRONS_DIR = join(homedir(), ".claude-bot", "crons")
const LAST_FIRED_FILE = join(CRONS_DIR, ".last-fired.json")

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

  // Range: 1-5
  if (field.includes("-") && !field.includes(",")) {
    const parts = field.split("-")
    const start = Number(parts[0])
    const end = Number(parts[1])
    if (isNaN(start) || isNaN(end)) return false
    return value >= start && value <= end
  }

  // List: 1,5,10
  if (field.includes(",")) {
    return field.split(",").some((part) => {
      const num = parseInt(part, 10)
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

      const name = frontmatter.name ?? file.replace(/\.md$/, "")
      const schedule = frontmatter.schedule
      if (!schedule) continue

      const cron = parseCronExpression(schedule)
      if (!cron) {
        console.error(`[cron] Invalid schedule "${schedule}" in ${file}, skipping`)
        continue
      }

      const catchup = frontmatter.catchup === "true"
      const enabled = frontmatter.enabled !== "false"  // default true
      const notify = frontmatter.notify === "true"
      const model = frontmatter.model
      const effort = frontmatter.effort
      jobs.push({ name, schedule, cron, prompt: body, catchup, enabled, notify, model, effort })
    } catch {
      // skip unreadable files
    }
  }
  return jobs
}

let cronInterval: ReturnType<typeof setInterval> | null = null
const runningJobs = new Set<string>()

async function loadLastFired(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(LAST_FIRED_FILE, "utf-8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function saveLastFired(data: Record<string, string>): Promise<void> {
  await writeFile(LAST_FIRED_FILE, JSON.stringify(data, null, 2), "utf-8")
}

function getIntervalMs(cron: CronExpression): number {
  // Estimate the interval from the cron expression for catch-up decisions
  if (cron.minute.startsWith("*/")) return parseInt(cron.minute.slice(2), 10) * 60_000
  if (cron.hour.startsWith("*/")) return parseInt(cron.hour.slice(2), 10) * 3600_000
  if (cron.hour !== "*" && cron.dayOfMonth === "*") return 24 * 3600_000 // daily
  return 24 * 3600_000 // default: assume daily
}

function shouldCatchUp(job: CronJob, lastFired: Record<string, string>): boolean {
  if (!job.catchup) return false
  const last = lastFired[job.name]
  if (!last) return true // never fired — catch up
  const elapsed = Date.now() - new Date(last).getTime()
  const interval = getIntervalMs(job.cron)
  // Missed if more than 1.5x the interval has passed since last fire
  return elapsed > interval * 1.5
}

async function fireJob(job: CronJob, lastFired: Record<string, string>): Promise<void> {
  runningJobs.add(job.name)
  try {
    const response = await sendMessage(`[Cron: ${job.name}] ${job.prompt}`, { model: job.model, effort: job.effort })
    lastFired[job.name] = new Date().toISOString()
    await saveLastFired(lastFired)
    if (job.notify) {
      notify(`claude-bot: ${job.name}`, response.result || "Cron job completed.")
    }
  } catch (err) {
    console.error(`[cron] Failed to fire job "${job.name}":`, err)
    if (job.notify) {
      notify(`claude-bot: ${job.name}`, `Failed: ${err}`)
    }
  } finally {
    runningJobs.delete(job.name)
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
        await fireJob(job, lastFired)
      }
    }
  })()

  cronInterval = setInterval(async () => {
    const now = new Date()
    const [jobs, lastFired] = await Promise.all([loadCronJobs(), loadLastFired()])
    for (const job of jobs) {
      if (job.enabled && shouldFire(job.cron, now) && !runningJobs.has(job.name)) {
        fireJob(job, lastFired)
      }
    }
  }, 60_000)
}

export function stopCronScheduler(): void {
  if (cronInterval !== null) {
    clearInterval(cronInterval)
    cronInterval = null
  }
}

// ── Cron CRUD helpers ────────────────────────────────────────────────────────

async function loadCronJob(name: string): Promise<CronJob | null> {
  const filePath = join(CRONS_DIR, `${name}.md`)
  try {
    const content = await readFile(filePath, "utf-8")
    const { frontmatter, body } = parseFrontmatter(content)
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
    }
  } catch {
    return null
  }
}

export async function runCronJob(name: string): Promise<{ ok: boolean; error?: string }> {
  if (runningJobs.has(name)) return { ok: false, error: `Cron job "${name}" is already running` }

  const job = await loadCronJob(name)
  if (!job) return { ok: false, error: `Cron job "${name}" not found` }

  const lastFired = await loadLastFired()
  fireJob(job, lastFired)
  return { ok: true }
}

function buildCronFile(opts: { name: string; schedule: string; model?: string; effort?: string; catchup?: boolean; notify?: boolean; enabled?: boolean; prompt: string }): string {
  const lines = ["---"]
  lines.push(`name: ${opts.name}`)
  lines.push(`schedule: ${opts.schedule}`)
  if (opts.model) lines.push(`model: ${opts.model}`)
  if (opts.effort) lines.push(`effort: ${opts.effort}`)
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

export async function updateCronJob(name: string, updates: { enabled?: boolean; schedule?: string; model?: string; effort?: string; catchup?: boolean; notify?: boolean; prompt?: string }): Promise<{ ok: boolean; error?: string }> {
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

  const newPrompt = updates.prompt ?? body

  await Bun.write(filePath, buildCronFile({
    name,
    schedule: frontmatter.schedule!,
    model: frontmatter.model,
    effort: frontmatter.effort,
    catchup: frontmatter.catchup === "true",
    notify: frontmatter.notify === "true",
    enabled: frontmatter.enabled !== "false",
    prompt: newPrompt,
  }))
  return { ok: true }
}
