import { homedir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { BOT_DIR, LOGS_DIR, PID_FILE, LAUNCHD_LABEL, SYSTEMD_SERVICE_NAME } from "./config.ts"
import { daemonConfigPath, generateDaemonConfig, installDaemon } from "./platform.ts"

/**
 * Non-interactive, idempotent installer (SHARED SETUP CONTRACT v2).
 *
 * Bismuth ships claude-bot as a package and installs/starts the daemon via an
 * explicit user-triggered command. The daemon may already be installed and
 * running on this machine (launchd label com.claude-bot.daemon), so setup MUST
 * be idempotent and ADOPT an existing install — never clobber, duplicate,
 * repoint, or restart the live daemon.
 *
 * This is intentionally self-contained and does NOT touch server.ts's setupBot
 * (the interactive plugin setup): its only job is detect + adopt, plus a minimal
 * daemon (launchd/systemd) install for a fresh machine. The daemon self-creates
 * its state dirs on boot, so the service install alone yields a working daemon.
 *
 * Every system probe is injectable so tests never touch the real launchd/pid.
 */

const IS_LINUX = process.platform === "linux"

export interface InstallStatus {
  installed: boolean
  running: boolean
  daemonLabel: string
  home: string
  plistPath: string
}

export type EnsureAction = "adopted" | "installed" | "would-install"

export interface EnsureResult {
  action: EnsureAction
  status: InstallStatus
}

/** System probes — injected in tests so nothing real is touched. */
export interface InstallProbes {
  /** Is the launchd/systemd service currently loaded? */
  isLoaded: (label: string) => boolean
  /** Does the plist/unit file exist on disk? */
  configExists: (path: string) => boolean
  /** Is the daemon process alive (pid in pidFile responds to signal 0)? */
  pidAlive: (pidFile: string) => boolean
}

function defaultIsLoaded(label: string): boolean {
  try {
    if (IS_LINUX) {
      return spawnSync("systemctl", ["--user", "is-active", SYSTEMD_SERVICE_NAME]).status === 0
    }
    return spawnSync("launchctl", ["list", label]).status === 0
  } catch {
    return false
  }
}

function defaultConfigExists(path: string): boolean {
  return existsSync(path)
}

function defaultPidAlive(pidFile: string): boolean {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const DEFAULT_PROBES: InstallProbes = {
  isLoaded: defaultIsLoaded,
  configExists: defaultConfigExists,
  pidAlive: defaultPidAlive,
}

/** Read-only install status. installed = service loaded OR config file present. */
export function getInstallStatus(probes: InstallProbes = DEFAULT_PROBES): InstallStatus {
  const plistPath = daemonConfigPath()
  const label = IS_LINUX ? SYSTEMD_SERVICE_NAME : LAUNCHD_LABEL
  const installed = probes.configExists(plistPath) || probes.isLoaded(label)
  const running = probes.pidAlive(PID_FILE)
  return { installed, running, daemonLabel: label, home: BOT_DIR, plistPath }
}

function buildPath(): string {
  const essential = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin", join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin")]
  const seen = new Set<string>()
  const merged: string[] = []
  for (const p of [...(process.env.PATH ?? "").split(":"), ...essential]) {
    if (p && !seen.has(p)) { seen.add(p); merged.push(p) }
  }
  return merged.join(":")
}

/** Minimal fresh-machine daemon install via the platform installDaemon path. */
async function defaultPerformInstall(): Promise<{ ok: boolean; error?: string }> {
  const bunPath = Bun.which("bun") ?? (process.platform === "darwin" ? "/opt/homebrew/bin/bun" : join(homedir(), ".bun", "bin", "bun"))
  if (!bunPath) return { ok: false, error: "could not find bun binary — install bun first: https://bun.sh" }
  const config = generateDaemonConfig({
    bunPath,
    daemonEntry: join(import.meta.dir, "..", "daemon", "index.ts"),
    logsDir: LOGS_DIR,
    workDir: BOT_DIR,
    envPath: buildPath(),
  })
  return installDaemon(daemonConfigPath(), config)
}

export interface EnsureOptions {
  dryRun?: boolean
  probes?: InstallProbes
  /** Override the actual install (tests inject a mock; never runs when adopted). */
  performInstall?: () => Promise<{ ok: boolean; error?: string }>
}

/**
 * Ensure the daemon is installed, idempotently:
 *  - already installed => "adopted" (NO side effects — the live daemon is untouched)
 *  - dryRun + not installed => "would-install" (no side effects)
 *  - not installed => perform the install => "installed"
 */
export async function ensureInstalled(opts: EnsureOptions = {}): Promise<EnsureResult> {
  const probes = opts.probes ?? DEFAULT_PROBES
  const status = getInstallStatus(probes)
  if (status.installed) return { action: "adopted", status }
  if (opts.dryRun) return { action: "would-install", status }
  const performInstall = opts.performInstall ?? defaultPerformInstall
  const result = await performInstall()
  if (!result.ok) throw new Error(result.error ?? "daemon install failed")
  return { action: "installed", status: getInstallStatus(probes) }
}
