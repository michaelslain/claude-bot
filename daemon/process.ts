import { homedir } from "os"
import { join } from "path"
import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises"
import { spawn as nodeSpawn, type ChildProcess } from "child_process"
import { openSync, closeSync } from "fs"
import { parseFrontmatter } from "../lib/frontmatter"
import { isOwner } from "../lib/owner"
import { BOT_DIR, PROCESSES_DIR, PROCESS_TRIGGER_DIR, LOGS_DIR, RESTART_BACKOFF_RESET_MS, RESTART_BACKOFF_MAX_MS, TRIGGER_CHECK_INTERVAL_MS } from "../lib/config.ts"

const PIDS_SUBDIR = ".pids"

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
  /**
   * `running`   — managed and the OS pid is alive
   * `stopped`   — managed but no live child
   * `stale`     — `mp.proc` was set but the OS pid is gone (cleared on observe)
   */
  status: "running" | "stopped" | "stale"
}

/**
 * Surfaced when ps shows a process matching a managed def's argv that is
 * NOT the daemon's current child for that def. Almost always an orphan from
 * a previous daemon instance; surfacing it makes the duplicate-process bug
 * visible instead of silent.
 */
export interface OrphanInfo {
  name: string
  pid: number
  command: string
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
  // Remembered so spawnProcess (called from the exit-handler restart path)
  // and stopProcess can locate the right .pids/<name>.pid file without the
  // caller threading the dir through.
  processesDir: string
}

const managed = new Map<string, ManagedProcess>()

// ── PID files ───────────────────────────────────────────────────────────────
//
// Each spawned child writes its pid to <processesDir>/.pids/<name>.pid. The
// file is the link between a previous daemon's children and a fresh daemon
// boot — without it, a daemon that crashes (or is SIGKILLed by launchctl
// before its own shutdown handler runs) leaves orphans that the next daemon
// has no way to identify. Removed on confirmed exit.

function pidsDirFor(processesDir: string): string {
  return join(processesDir, PIDS_SUBDIR)
}

async function readPidFile(processesDir: string, name: string): Promise<number | null> {
  try {
    const content = await readFile(join(pidsDirFor(processesDir), `${name}.pid`), "utf-8")
    const pid = parseInt(content.trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function writePidFile(processesDir: string, name: string, pid: number): Promise<void> {
  const dir = pidsDirFor(processesDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.pid`), String(pid), "utf-8")
}

async function removePidFile(processesDir: string, name: string): Promise<void> {
  try { await unlink(join(pidsDirFor(processesDir), `${name}.pid`)) } catch {}
}

// ── ps argv scanning ────────────────────────────────────────────────────────
//
// PID files are the primary mechanism, but they go stale if the daemon dies
// uncleanly without removing them, or if a process is spawned outside the
// supervisor. argv-matching is the defensive fallback: scan `ps` for any
// process whose command line matches a managed def, regardless of pid file
// state. Used for unmanaged_orphan surfacing in process_list and as a
// belt-and-suspenders check in spawnProcess.

interface PsRow { pid: number; command: string }

async function scanPs(): Promise<PsRow[]> {
  try {
    const proc = Bun.spawn(["ps", "-ww", "-eo", "pid,command"], { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const rows: PsRow[] = []
    const lines = text.split("\n")
    // Skip header line ("  PID COMMAND")
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim()
      if (!line) continue
      const m = line.match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      rows.push({ pid: parseInt(m[1]!, 10), command: m[2]! })
    }
    return rows
  } catch {
    return []
  }
}

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * True if the given ps command line was spawned from `def`. Tokenises the
 * command line and compares the resolved program name (basename of argv[0])
 * plus the literal arg list. Matching basenames covers `/bin/sleep` vs
 * `sleep`; requiring all args match in order avoids false positives between
 * two defs that share a binary (e.g. two different `bash` scripts).
 */
function defMatchesCommand(def: ProcessDef, cmd: string): boolean {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.length < 1 + def.args.length) return false

  const cmdBase = basename(tokens[0]!)
  const defBase = basename(def.command)
  if (cmdBase !== defBase && tokens[0] !== def.command) return false

  for (let i = 0; i < def.args.length; i++) {
    if (tokens[i + 1] !== def.args[i]) return false
  }
  return true
}

function matchOrphans(def: ProcessDef, knownPid: number | null, rows: PsRow[]): PsRow[] {
  return rows.filter(
    (r) =>
      r.pid !== knownPid &&
      r.pid !== process.pid &&
      defMatchesCommand(def, r.command),
  )
}

async function killAndConfirm(pid: number, timeoutMs: number = 2000): Promise<void> {
  if (!isAlive(pid)) return
  // Try the process group first (children of `detached: true` are in their
  // own group); fall back to the bare pid for processes we didn't spawn.
  try { process.kill(-pid, "SIGTERM") } catch {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
  const softDeadline = Date.now() + timeoutMs
  while (Date.now() < softDeadline) {
    if (!isAlive(pid)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  try { process.kill(-pid, "SIGKILL") } catch {}
  try { process.kill(pid, "SIGKILL") } catch {}
  const hardDeadline = Date.now() + 1000
  while (Date.now() < hardDeadline) {
    if (!isAlive(pid)) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

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

async function spawnProcess(mp: ManagedProcess): Promise<void> {
  const { def, processesDir } = mp

  // Defensive orphan reap before forking: a stale pid file or an argv-match
  // in `ps` means a previous instance of this def is still running. Kill it
  // first — otherwise we'd create a duplicate.
  const stalePid = await readPidFile(processesDir, def.name)
  if (stalePid && stalePid !== mp.proc?.pid && isAlive(stalePid)) {
    console.warn(`[process] Stale pid ${stalePid} for "${def.name}" — killing before spawn`)
    await killAndConfirm(stalePid)
  }
  await removePidFile(processesDir, def.name)

  const psRows = await scanPs()
  const orphans = matchOrphans(def, mp.proc?.pid ?? null, psRows)
  for (const o of orphans) {
    if (!isAlive(o.pid)) continue
    console.warn(`[process] Orphan pid ${o.pid} matches "${def.name}" (${o.command}) — killing before spawn`)
    await killAndConfirm(o.pid)
  }

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
  const spawnedPid = mp.proc.pid
  console.log(`[process] Started "${def.name}" (PID ${spawnedPid})`)

  if (spawnedPid) {
    void writePidFile(processesDir, def.name, spawnedPid).catch((err) => {
      console.error(`[process] Failed to write pid file for "${def.name}": ${err}`)
    })
  }

  // Watch for exit
  mp.proc.on("exit", (code, signal) => {
    void removePidFile(processesDir, def.name)
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
      if (!mp.stopping) void spawnProcess(mp)
    }, mp.backoff)
  })
}

function registerDef(def: ProcessDef, processesDir: string = PROCESSES_DIR): ManagedProcess {
  const existing = managed.get(def.name)
  if (existing) {
    existing.def = def
    existing.processesDir = processesDir
    return existing
  }
  const mp: ManagedProcess = {
    def,
    proc: null,
    restarts: 0,
    lastStart: 0,
    backoff: def.restartDelay,
    stopping: false,
    processesDir,
  }
  managed.set(def.name, mp)
  return mp
}

export async function startProcesses(dir: string = PROCESSES_DIR): Promise<void> {
  const defs = await loadProcessDefs(dir)
  for (const def of defs) {
    const wasRegistered = managed.has(def.name)
    const mp = registerDef(def, dir)
    // Only auto-spawn if enabled. Disabled defs sit in `managed` ready for
    // a runtime process_start; re-running startProcesses doesn't relaunch
    // already-running children.
    if (def.enabled && !wasRegistered) await spawnProcess(mp)
  }
}

/**
 * Reap processes left behind by a previous daemon instance. Run on daemon
 * boot BEFORE startProcesses(): the new daemon's `managed` map is empty, so
 * if we don't reap first, startProcesses() forks fresh children alongside
 * the orphans and we end up supervising one while three actually run.
 *
 * Two-pass: (1) trust pid files for fast common case, (2) argv-scan ps as a
 * safety net for the case where the pid file was lost or the orphan was
 * spawned outside the supervisor.
 */
export async function reapOrphans(dir: string = PROCESSES_DIR): Promise<void> {
  const defs = await loadProcessDefs(dir)
  if (defs.length === 0) return

  for (const def of defs) {
    const stalePid = await readPidFile(dir, def.name)
    if (stalePid && isAlive(stalePid)) {
      console.warn(`[process] Reaping orphan pid ${stalePid} for "${def.name}" (stale pid file)`)
      await killAndConfirm(stalePid)
    }
    await removePidFile(dir, def.name)
  }

  const psRows = await scanPs()
  for (const def of defs) {
    const orphans = matchOrphans(def, null, psRows)
    for (const o of orphans) {
      if (!isAlive(o.pid)) continue
      console.warn(`[process] Reaping orphan pid ${o.pid} for "${def.name}" (argv match: ${o.command})`)
      await killAndConfirm(o.pid)
    }
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

  // Final confirmation: poll until SIGKILL'd children are actually gone
  // before clearing in-memory state. "Signal sent" ≠ "process dead"; if we
  // clear too eagerly the next daemon boot can't tie pid file → managed.
  const hardDeadline = Date.now() + 2000
  while (Date.now() < hardDeadline) {
    const stillAlive = active.filter((mp) => mp.proc?.pid && isAlive(mp.proc.pid))
    if (stillAlive.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  for (const mp of active) {
    await removePidFile(mp.processesDir, mp.def.name)
  }

  managed.clear()
}

export function startProcess(name: string): { ok: boolean; error?: string } {
  const mp = managed.get(name)
  if (!mp) return { ok: false, error: `No process definition found for "${name}"` }
  if (mp.proc) return { ok: false, error: `"${name}" is already running` }

  mp.stopping = false
  mp.backoff = mp.def.restartDelay
  void spawnProcess(mp)
  return { ok: true }
}

/**
 * Send SIGTERM, poll for actual exit, then escalate to SIGKILL on timeout.
 * Returns only after the kernel confirms the pid is gone, then clears
 * `mp.proc` and the pid file so a subsequent process_start works.
 *
 * Async because the previous sync version returned the moment SIGTERM was
 * sent — callers (notably disableProcess) then proceeded as if the child
 * were dead while in reality it kept running for seconds.
 */
export async function stopProcess(name: string, timeoutMs: number = 3000): Promise<{ ok: boolean; error?: string }> {
  const mp = managed.get(name)
  if (!mp) return { ok: false, error: `No process definition found for "${name}"` }
  const proc = mp.proc
  if (!proc) return { ok: false, error: `"${name}" is not running` }
  const pid = proc.pid
  if (!pid) {
    mp.proc = null
    return { ok: true }
  }

  mp.stopping = true
  killProcessGroup(mp)

  const softDeadline = Date.now() + timeoutMs
  while (Date.now() < softDeadline) {
    if (!isAlive(pid)) break
    await new Promise((r) => setTimeout(r, 100))
  }

  if (isAlive(pid)) {
    console.warn(`[process] "${name}" (PID ${pid}) did not exit on SIGTERM — sending SIGKILL`)
    forceKill(mp)
    const hardDeadline = Date.now() + 2000
    while (Date.now() < hardDeadline) {
      if (!isAlive(pid)) break
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  mp.proc = null
  await removePidFile(mp.processesDir, name)
  return { ok: true }
}

/**
 * Returns the supervisor's view of managed processes plus any unmanaged
 * orphans matching a managed def's argv. Cross-references the in-memory
 * `managed` map against `ps` so:
 *   - a `mp.proc` entry whose pid is dead reports `status: "stale"` and
 *     gets cleared (so the next process_start can succeed)
 *   - a process in `ps` that matches a def's argv but isn't `mp.proc.pid`
 *     surfaces as an unmanaged_orphan, making the duplicate-process bug
 *     visible to operators instead of silent.
 */
export async function listProcesses(): Promise<{ processes: ProcessInfo[]; orphans: OrphanInfo[] }> {
  const psRows = await scanPs()
  const processes: ProcessInfo[] = []
  const orphans: OrphanInfo[] = []

  for (const mp of managed.values()) {
    let pid: number | null = null
    let running = false
    let status: ProcessInfo["status"] = "stopped"

    if (mp.proc?.pid) {
      if (isAlive(mp.proc.pid)) {
        pid = mp.proc.pid
        running = true
        status = "running"
      } else {
        // Child died but exit handler hasn't fired (or was missed). Clear
        // the stale ref so process_start can succeed.
        console.warn(`[process] "${mp.def.name}" pid ${mp.proc.pid} no longer alive — clearing stale ref`)
        mp.proc = null
        status = "stale"
        await removePidFile(mp.processesDir, mp.def.name)
      }
    }

    processes.push({
      name: mp.def.name,
      pid,
      running,
      enabled: mp.def.enabled,
      restart: mp.def.restart,
      restarts: mp.restarts,
      status,
    })

    for (const o of matchOrphans(mp.def, pid, psRows)) {
      orphans.push({ name: mp.def.name, pid: o.pid, command: o.command })
    }
  }

  return { processes, orphans }
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

  registerDef({ ...def, enabled: true }, dir)
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
  // CRITICAL: must `await` — the previous sync version sent SIGTERM and
  // returned, leaving the bash child to outlive the disable call (and keep
  // firing its inner loop) until something else killed it.
  registerDef({ ...def, enabled: false }, dir)
  const mp = managed.get(name)
  if (mp?.proc) await stopProcess(name)

  const isDisabled = frontmatter.enabled === "false"
  if (!isDisabled) {
    frontmatter.enabled = "false"
    await writeProcessFile(filePath, frontmatter, body)
  }

  return { ok: true }
}

// ── Process trigger port ──────────────────────────────────────────────────────
//
// The symmetric counterpart of the cron trigger port (cron.ts: requestCronRun /
// processTriggers). A generic on-disk control surface: an external program flips
// a process's frontmatter (enabled: true|false) and drops a trigger file named
// by the process's FILE BASENAME; the daemon reconciles that one process's live
// runtime to match its (already-updated) on-disk frontmatter, then deletes the
// trigger. Reuses the existing enable/disable/start functions — no duplicate
// spawn/stop logic.

let triggerInterval: ReturnType<typeof setInterval> | null = null

// Use the configured trigger dir for the real processes dir; derive a sibling
// .triggers for test/injected dirs (mirrors pidsDirFor).
function triggerDirFor(processesDir: string): string {
  return processesDir === PROCESSES_DIR ? PROCESS_TRIGGER_DIR : join(processesDir, ".triggers")
}

/** True when a managed process with this name has a live OS child. */
function isRunning(name: string): boolean {
  const mp = managed.get(name)
  return !!(mp?.proc?.pid && isAlive(mp.proc.pid))
}

/**
 * Write a trigger file so the daemon reconciles this process on its next poll.
 * Symmetric counterpart of requestCronRun — used by the MCP server / external
 * tools (which may also just drop the file directly) as a first-class API.
 */
export async function requestProcessRun(name: string, dir: string = PROCESSES_DIR): Promise<{ ok: boolean; error?: string }> {
  let content: string
  try {
    content = await readFile(join(dir, `${name}.md`), "utf-8")
  } catch {
    return { ok: false, error: `No process definition found for "${name}"` }
  }
  const def = parseProcessFrontmatter(name, parseFrontmatter(content).frontmatter)
  if (!def) return { ok: false, error: `Process "${name}" is missing required "command" field` }

  const triggerDir = triggerDirFor(dir)
  await mkdir(triggerDir, { recursive: true })
  await writeFile(join(triggerDir, name), new Date().toISOString(), "utf-8")
  return { ok: true }
}

/**
 * Check for trigger files dropped by an external program and reconcile each
 * named process's runtime to its on-disk frontmatter. Symmetric counterpart of
 * cron's processTriggers: owner-gated (non-owner consumes triggers without
 * acting), unlinks each trigger before acting, and never throws out of the loop.
 */
export async function processProcessTriggers(dir: string = PROCESSES_DIR, home: string = BOT_DIR): Promise<void> {
  const triggerDir = triggerDirFor(dir)
  let files: string[]
  try {
    files = await readdir(triggerDir)
  } catch {
    return
  }

  const triggers = files.filter(f => !f.startsWith("."))
  if (triggers.length === 0) return

  // Not the owner device: idle. Consume the trigger files so they don't pile
  // up, but don't start/stop. Unclaimed => isOwner true => normal behavior.
  if (!(await isOwner(home))) {
    for (const name of triggers) {
      try { await unlink(join(triggerDir, name)) } catch {}
    }
    return
  }

  for (const name of triggers) {
    try { await unlink(join(triggerDir, name)) } catch {}

    // Defense-in-depth: the trigger filename addresses a .md file by basename,
    // so reject anything with path separators that could escape the dir.
    if (name.includes("/") || name.includes("\\")) {
      console.warn(`[process] Trigger with invalid name "${name}" — skipping`)
      continue
    }

    // Resolve the basename to a def by reading its .md directly (reload from
    // disk so we see the fresh `enabled`). Tolerate unknown/removed defs.
    let content: string
    try {
      content = await readFile(join(dir, `${name}.md`), "utf-8")
    } catch {
      console.warn(`[process] Trigger for unknown process "${name}" — skipping`)
      continue
    }
    const def = parseProcessFrontmatter(name, parseFrontmatter(content).frontmatter)
    if (!def) {
      console.warn(`[process] Trigger for "${name}" missing required "command" — skipping`)
      continue
    }

    // Reconcile runtime ↔ disk using the existing enable/disable/start funcs.
    const running = isRunning(def.name)
    if (def.enabled && !running) {
      console.log(`[process] Trigger starting: ${name}`)
      await enableProcess(name, dir)
      startProcess(def.name)
    } else if (!def.enabled && running) {
      console.log(`[process] Trigger stopping: ${name}`)
      await disableProcess(name, dir)
    }
    // else: runtime already matches disk — no-op
  }
}

/**
 * Start polling for process trigger files. Mirror of the cron trigger loop in
 * startCronScheduler — a single interval that reconciles triggered processes.
 */
export function startProcessTriggers(dir: string = PROCESSES_DIR): void {
  if (triggerInterval !== null) return
  triggerInterval = setInterval(() => { processProcessTriggers(dir) }, TRIGGER_CHECK_INTERVAL_MS)
}

/** Stop the process trigger poll loop. Mirror of stopCronScheduler's clear. */
export function stopProcessTriggers(): void {
  if (triggerInterval !== null) {
    clearInterval(triggerInterval)
    triggerInterval = null
  }
}
