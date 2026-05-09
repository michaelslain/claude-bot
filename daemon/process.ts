import { homedir } from "os"
import { join } from "path"
import { readdir, readFile } from "fs/promises"
import { spawn as nodeSpawn, type ChildProcess } from "child_process"
import { openSync, closeSync } from "fs"
import { parseFrontmatter } from "../lib/frontmatter"
import { PROCESSES_DIR, LOGS_DIR, RESTART_BACKOFF_RESET_MS, RESTART_BACKOFF_MAX_MS } from "../lib/config.ts"

export interface ProcessDef {
  name: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  restart: "always" | "on-failure" | "never"
  restartDelay: number
  enabled: boolean
}

export interface ProcessInfo {
  name: string
  pid: number | null
  running: boolean
  enabled: boolean
  restart: string
  restarts: number
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return []
  // Handle JSON array or space-separated
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) } catch {}
  }
  return trimmed.split(/\s+/).filter(Boolean)
}

function parseEnv(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const trimmed = raw.trim()
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed) } catch {}
  }
  return {}
}

function parseProcessFrontmatter(name: string, frontmatter: Record<string, string>): ProcessDef | null {
  const command = frontmatter.command
  if (!command) return null

  const args = parseArgs(frontmatter.args)
  const cwd = frontmatter.cwd ?? homedir()
  const env = parseEnv(frontmatter.env)
  const restart = (frontmatter.restart ?? "on-failure") as ProcessDef["restart"]
  const restartDelay = parseInt(frontmatter.restartDelay ?? "1000", 10)
  const enabled = frontmatter.enabled !== "false"

  return { name: frontmatter.name ?? name, command, args, cwd, env, restart, restartDelay, enabled }
}

/**
 * Load all process definitions from disk. Returns ALL defs including disabled
 * ones — callers decide what to do with `enabled`. (Boot path skips spawning
 * disabled entries; runtime API still registers them so process_start works.)
 */
export async function loadProcessDefs(dir: string = PROCESSES_DIR): Promise<ProcessDef[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const defs: ProcessDef[] = []
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    try {
      const content = await readFile(join(dir, file), "utf-8")
      const { frontmatter } = parseFrontmatter(content)
      const def = parseProcessFrontmatter(file.replace(/\.md$/, ""), frontmatter)
      if (def) defs.push(def)
    } catch {
      // skip unreadable files
    }
  }
  return defs
}

/**
 * Rewrite a process .md file with updated frontmatter. Preserves the body and
 * the original frontmatter field ordering (parseFrontmatter returns the keys
 * in insertion order). Used by enable/disable to flip the `enabled` flag.
 */
async function writeProcessFile(filePath: string, frontmatter: Record<string, string>, body: string): Promise<void> {
  const lines = ["---"]
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push("---")
  lines.push("")
  if (body) lines.push(body)
  await Bun.write(filePath, lines.join("\n") + "\n")
}

interface ManagedProcess {
  def: ProcessDef
  proc: ChildProcess | null
  restarts: number
  lastStart: number
  backoff: number
  stopping: boolean
}

const managed = new Map<string, ManagedProcess>()

function killProcessGroup(mp: ManagedProcess): void {
  const pid = mp.proc?.pid
  if (!pid) return
  // Try the process group first (detached: true gives each child its own).
  // Fall back to direct pid if the group-kill fails (EPERM, ESRCH, etc.) —
  // belt-and-suspenders so a single errno doesn't orphan the child.
  try { process.kill(-pid, "SIGTERM") } catch {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
  // Note: intentionally do NOT clear mp.proc here. The exit handler needs it,
  // and stopProcesses polls mp.proc.pid to confirm actual exit before SIGKILL.
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function forceKill(mp: ManagedProcess): void {
  const pid = mp.proc?.pid
  if (!pid) return
  try { process.kill(-pid, "SIGKILL") } catch {}
  try { process.kill(pid, "SIGKILL") } catch {}
}

function spawnProcess(mp: ManagedProcess): void {
  const { def } = mp
  const stdoutPath = join(LOGS_DIR, `${def.name}.stdout.log`)
  const stderrPath = join(LOGS_DIR, `${def.name}.stderr.log`)

  const stdoutFd = openSync(stdoutPath, "a")
  const stderrFd = openSync(stderrPath, "a")

  mp.proc = nodeSpawn(def.command, def.args, {
    cwd: def.cwd,
    env: { ...process.env, ...def.env },
    stdio: ["ignore", stdoutFd, stderrFd],
    detached: true,
  })

  // Parent's copies of the fds — child inherited its own via spawn
  closeSync(stdoutFd)
  closeSync(stderrFd)

  mp.proc.unref()
  mp.lastStart = Date.now()
  console.log(`[process] Started "${def.name}" (PID ${mp.proc.pid})`)

  // Watch for exit
  mp.proc.on("exit", (code, signal) => {
    if (mp.stopping) return
    const exitInfo = signal ? `signal ${signal}` : `code ${code}`
    console.log(`[process] "${def.name}" exited with ${exitInfo}`)
    mp.proc = null

    const exitCode = signal ? 1 : (code ?? 0)
    const shouldRestart =
      def.restart === "always" ||
      (def.restart === "on-failure" && exitCode !== 0)

    if (!shouldRestart) return

    mp.restarts++

    // Reset backoff after 5 min of stable running
    const uptime = Date.now() - mp.lastStart
    if (uptime >= RESTART_BACKOFF_RESET_MS) {
      mp.backoff = def.restartDelay
    } else {
      mp.backoff = Math.min(mp.backoff * 2, RESTART_BACKOFF_MAX_MS)
    }

    console.log(`[process] Restarting "${def.name}" in ${mp.backoff}ms (restart #${mp.restarts})`)
    setTimeout(() => {
      if (!mp.stopping) spawnProcess(mp)
    }, mp.backoff)
  })
}

function registerDef(def: ProcessDef): ManagedProcess {
  const existing = managed.get(def.name)
  if (existing) {
    existing.def = def
    return existing
  }
  const mp: ManagedProcess = {
    def,
    proc: null,
    restarts: 0,
    lastStart: 0,
    backoff: def.restartDelay,
    stopping: false,
  }
  managed.set(def.name, mp)
  return mp
}

export async function startProcesses(dir: string = PROCESSES_DIR): Promise<void> {
  const defs = await loadProcessDefs(dir)
  for (const def of defs) {
    const wasRegistered = managed.has(def.name)
    const mp = registerDef(def)
    // Only auto-spawn if enabled. Disabled defs sit in `managed` ready for
    // a runtime process_start; re-running startProcesses doesn't relaunch
    // already-running children.
    if (def.enabled && !wasRegistered) spawnProcess(mp)
  }
}

/**
 * Send SIGTERM to all managed children, wait up to `timeoutMs` for them to exit,
 * then SIGKILL any survivor. Without this, a daemon shutdown that completes
 * before the kernel delivers SIGTERM can orphan the child — it reparents to
 * PID 1 and keeps running. Multiple daemon restarts then accumulate orphans.
 */
export async function stopProcesses(timeoutMs: number = 3000): Promise<void> {
  const active = Array.from(managed.values()).filter((mp) => mp.proc?.pid)

  for (const mp of active) {
    mp.stopping = true
    killProcessGroup(mp)
  }

  // Poll until all children exit, or timeout hits
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stillAlive = active.filter((mp) => mp.proc?.pid && isAlive(mp.proc.pid))
    if (stillAlive.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // Escalate to SIGKILL for any survivors
  for (const mp of active) {
    if (mp.proc?.pid && isAlive(mp.proc.pid)) {
      console.warn(`[process] "${mp.def.name}" (PID ${mp.proc.pid}) did not exit on SIGTERM — sending SIGKILL`)
      forceKill(mp)
    }
  }

  managed.clear()
}

export function startProcess(name: string): { ok: boolean; error?: string } {
  const mp = managed.get(name)
  if (!mp) return { ok: false, error: `No process definition found for "${name}"` }
  if (mp.proc) return { ok: false, error: `"${name}" is already running` }

  mp.stopping = false
  mp.backoff = mp.def.restartDelay
  spawnProcess(mp)
  return { ok: true }
}

export function stopProcess(name: string): { ok: boolean; error?: string } {
  const mp = managed.get(name)
  if (!mp) return { ok: false, error: `No process definition found for "${name}"` }
  if (!mp.proc) return { ok: false, error: `"${name}" is not running` }

  mp.stopping = true
  killProcessGroup(mp)
  return { ok: true }
}

export function listProcesses(): ProcessInfo[] {
  return Array.from(managed.values()).map((mp) => ({
    name: mp.def.name,
    pid: mp.proc?.pid ?? null,
    running: mp.proc !== null,
    enabled: mp.def.enabled,
    restart: mp.def.restart,
    restarts: mp.restarts,
  }))
}

/**
 * Flip `enabled: true` on disk and register the process if not already known
 * to the daemon. Does NOT spawn — caller must call startProcess to actually
 * run it. Idempotent: succeeds even if already enabled.
 */
export async function enableProcess(name: string, dir: string = PROCESSES_DIR): Promise<{ ok: boolean; error?: string }> {
  const filePath = join(dir, `${name}.md`)
  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return { ok: false, error: `No process definition found for "${name}"` }
  }

  const { frontmatter, body } = parseFrontmatter(content)
  const def = parseProcessFrontmatter(name, frontmatter)
  if (!def) return { ok: false, error: `Process "${name}" is missing required "command" field` }

  const isEnabled = frontmatter.enabled === "true"
  if (!isEnabled) {
    frontmatter.enabled = "true"
    await writeProcessFile(filePath, frontmatter, body)
  }

  registerDef({ ...def, enabled: true })
  return { ok: true }
}

/**
 * Flip `enabled: false` on disk. If the process is currently running, stop it
 * first. Keeps the entry in `managed` so process_start still works at runtime.
 * Idempotent: succeeds even if already disabled.
 */
export async function disableProcess(name: string, dir: string = PROCESSES_DIR): Promise<{ ok: boolean; error?: string }> {
  const filePath = join(dir, `${name}.md`)
  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return { ok: false, error: `No process definition found for "${name}"` }
  }

  const { frontmatter, body } = parseFrontmatter(content)
  const def = parseProcessFrontmatter(name, frontmatter)
  if (!def) return { ok: false, error: `Process "${name}" is missing required "command" field` }

  // Stop first if running. stopProcess only works for entries in `managed`,
  // so register the def before stopping (no-op if already registered).
  registerDef({ ...def, enabled: false })
  const mp = managed.get(name)
  if (mp?.proc) stopProcess(name)

  const isDisabled = frontmatter.enabled === "false"
  if (!isDisabled) {
    frontmatter.enabled = "false"
    await writeProcessFile(filePath, frontmatter, body)
  }

  return { ok: true }
}
