import { homedir } from "os"
import { join } from "path"
import { readdir, readFile } from "fs/promises"
import { spawn, type Subprocess } from "bun"
import { parseFrontmatter } from "../lib/frontmatter"

const PROCESSES_DIR = join(homedir(), ".claude-bot", "processes")
const LOGS_DIR = join(homedir(), ".claude-bot", "logs")

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

export async function loadProcessDefs(): Promise<ProcessDef[]> {
  let files: string[]
  try {
    files = await readdir(PROCESSES_DIR)
  } catch {
    return []
  }

  const defs: ProcessDef[] = []
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    try {
      const content = await readFile(join(PROCESSES_DIR, file), "utf-8")
      const { frontmatter } = parseFrontmatter(content)

      const name = frontmatter.name ?? file.replace(/\.md$/, "")
      const command = frontmatter.command
      if (!command) continue

      const args = parseArgs(frontmatter.args)
      const cwd = frontmatter.cwd ?? homedir()
      const env = parseEnv(frontmatter.env)
      const restart = (frontmatter.restart ?? "on-failure") as ProcessDef["restart"]
      const restartDelay = parseInt(frontmatter.restartDelay ?? "1000", 10)
      const enabled = frontmatter.enabled !== "false"

      defs.push({ name, command, args, cwd, env, restart, restartDelay, enabled })
    } catch {
      // skip unreadable files
    }
  }
  return defs
}

interface ManagedProcess {
  def: ProcessDef
  proc: Subprocess | null
  restarts: number
  lastStart: number
  backoff: number
  stopping: boolean
}

const managed = new Map<string, ManagedProcess>()

function spawnProcess(mp: ManagedProcess): void {
  const { def } = mp
  const stdoutPath = join(LOGS_DIR, `${def.name}.stdout.log`)
  const stderrPath = join(LOGS_DIR, `${def.name}.stderr.log`)

  const stdout = Bun.file(stdoutPath)
  const stderr = Bun.file(stderrPath)

  mp.proc = spawn({
    cmd: [def.command, ...def.args],
    cwd: def.cwd,
    env: { ...process.env, ...def.env },
    stdout,
    stderr,
  })

  mp.lastStart = Date.now()
  console.log(`[process] Started "${def.name}" (PID ${mp.proc.pid})`)

  // Watch for exit
  mp.proc.exited.then((code) => {
    if (mp.stopping) return
    console.log(`[process] "${def.name}" exited with code ${code}`)
    mp.proc = null

    const shouldRestart =
      def.restart === "always" ||
      (def.restart === "on-failure" && code !== 0)

    if (!shouldRestart) return

    mp.restarts++

    // Reset backoff after 5 min of stable running
    const uptime = Date.now() - mp.lastStart
    if (uptime >= 5 * 60_000) {
      mp.backoff = def.restartDelay
    } else {
      mp.backoff = Math.min(mp.backoff * 2, 60_000)
    }

    console.log(`[process] Restarting "${def.name}" in ${mp.backoff}ms (restart #${mp.restarts})`)
    setTimeout(() => {
      if (!mp.stopping) spawnProcess(mp)
    }, mp.backoff)
  })
}

export async function startProcesses(): Promise<void> {
  const defs = await loadProcessDefs()
  for (const def of defs) {
    if (!def.enabled) continue
    if (managed.has(def.name)) continue

    const mp: ManagedProcess = {
      def,
      proc: null,
      restarts: 0,
      lastStart: 0,
      backoff: def.restartDelay,
      stopping: false,
    }
    managed.set(def.name, mp)
    spawnProcess(mp)
  }
}

export function stopProcesses(): void {
  for (const [, mp] of managed) {
    mp.stopping = true
    if (mp.proc) {
      mp.proc.kill()
      mp.proc = null
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
  mp.proc.kill()
  mp.proc = null
  return { ok: true }
}

export function listProcesses(): ProcessInfo[] {
  return Array.from(managed.values()).map((mp) => ({
    name: mp.def.name,
    pid: mp.proc?.pid ?? null,
    running: mp.proc !== null,
    restart: mp.def.restart,
    restarts: mp.restarts,
  }))
}
