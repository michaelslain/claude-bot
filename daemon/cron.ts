import { homedir } from "os"
import { join } from "path"
import { readdir, readFile, writeFile } from "fs/promises"
import { sendMessage } from "./session"
import { notify } from "../lib/platform"

const CRONS_DIR = join(homedir(), ".claude-bot", "crons")
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

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content.trim() }

  const frontmatter: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    frontmatter[key] = value
  }

  return { frontmatter, body: match[2]!.trim() }
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
    const jobs = await loadCronJobs()
    const lastFired = await loadLastFired()
    for (const job of jobs) {
      if (job.enabled && shouldCatchUp(job, lastFired) && !runningJobs.has(job.name)) {
        console.log(`[cron] Catch-up firing: ${job.name}`)
        await fireJob(job, lastFired)
      }
    }
  })()

  cronInterval = setInterval(async () => {
    const now = new Date()
    const jobs = await loadCronJobs()
    const lastFired = await loadLastFired()
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
