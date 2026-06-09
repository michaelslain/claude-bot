import { homedir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import { mkdir, readFile } from "fs/promises"
import { LAUNCHD_LABEL, PID_FILE, SYSTEMD_SERVICE_NAME } from "./config.ts"

const IS_LINUX = process.platform === "linux"

// ── Paths ────────────────────────────────────────────────────────────────────

export function daemonConfigPath(): string {
  if (IS_LINUX) return join(homedir(), ".config", "systemd", "user", `${SYSTEMD_SERVICE_NAME}.service`)
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
}

// ── Config generation ────────────────────────────────────────────────────────

interface DaemonOpts {
  bunPath: string
  daemonEntry: string
  logsDir: string
  workDir: string
  envPath: string
}

export function generateDaemonConfig(opts: DaemonOpts): string {
  return IS_LINUX ? generateSystemdUnit(opts) : generatePlist(opts)
}

function generatePlist({ bunPath, daemonEntry, logsDir, workDir, envPath }: DaemonOpts): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>${daemonEntry}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>${envPath}</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${join(logsDir, "claude-bot.stdout.log")}</string>
    <key>StandardErrorPath</key><string>${join(logsDir, "claude-bot.stderr.log")}</string>
    <key>WorkingDirectory</key><string>${workDir}</string>
</dict>
</plist>`
}

function generateSystemdUnit({ bunPath, daemonEntry, logsDir, workDir, envPath }: DaemonOpts): string {
  return `[Unit]
Description=claude-bot daemon
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} run ${daemonEntry}
WorkingDirectory=${workDir}
Environment=PATH=${envPath}
Restart=always
RestartSec=5
StandardOutput=append:${join(logsDir, "claude-bot.stdout.log")}
StandardError=append:${join(logsDir, "claude-bot.stderr.log")}

[Install]
WantedBy=default.target`
}

// ── Daemon control ───────────────────────────────────────────────────────────

export async function installDaemon(configPath: string, config: string): Promise<{ ok: boolean; error?: string }> {
  if (IS_LINUX) {
    await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true })
    await Bun.write(configPath, config)
    const reload = spawnSync("systemctl", ["--user", "daemon-reload"])
    if (reload.status !== 0) return { ok: false, error: `daemon-reload failed: ${reload.stderr?.toString()}` }
    const enable = spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_SERVICE_NAME])
    if (enable.status !== 0) return { ok: false, error: `enable failed: ${enable.stderr?.toString()}` }
    return { ok: true }
  }
  await Bun.write(configPath, config)
  const load = spawnSync("launchctl", ["load", configPath])
  if (load.status !== 0) return { ok: false, error: `launchctl load failed: ${load.stderr?.toString()}` }
  return { ok: true }
}

export function unloadDaemon(configPath: string): void {
  if (IS_LINUX) {
    spawnSync("systemctl", ["--user", "stop", SYSTEMD_SERVICE_NAME])
    spawnSync("systemctl", ["--user", "disable", SYSTEMD_SERVICE_NAME])
  } else {
    spawnSync("launchctl", ["unload", configPath])
  }
}

export async function reloadDaemon(configPath: string, config: string): Promise<{ ok: boolean; error?: string }> {
  await Bun.write(configPath, config)
  if (IS_LINUX) {
    spawnSync("systemctl", ["--user", "daemon-reload"])
    const restart = spawnSync("systemctl", ["--user", "restart", SYSTEMD_SERVICE_NAME])
    if (restart.status !== 0) return { ok: false, error: `restart failed: ${restart.stderr?.toString()}` }
    return { ok: true }
  }
  spawnSync("launchctl", ["unload", configPath])
  const load = spawnSync("launchctl", ["load", configPath])
  if (load.status !== 0) return { ok: false, error: `launchctl load failed: ${load.stderr?.toString()}` }
  return { ok: true }
}

/** Restart the running daemon IN PLACE without rewriting its config — for code updates
 *  (after a `git pull` + `bun install`). macOS: `launchctl kickstart -k` bounces the loaded
 *  service; Linux: `systemctl --user restart`. Requires the service already installed. */
export function restartDaemon(): { ok: boolean; error?: string } {
  if (IS_LINUX) {
    const r = spawnSync("systemctl", ["--user", "restart", SYSTEMD_SERVICE_NAME])
    if (r.status !== 0) return { ok: false, error: `systemctl restart failed: ${r.stderr?.toString()}` }
    return { ok: true }
  }
  const uid = process.getuid?.() ?? 0
  const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`])
  if (r.status !== 0) return { ok: false, error: `launchctl kickstart failed: ${r.stderr?.toString()}` }
  return { ok: true }
}

// ── Daemon-process identity ──────────────────────────────────────────────────

/**
 * True only when the calling process IS the daemon (its pid matches PID_FILE).
 *
 * `daemon/process.ts` keeps the `managed` map at module scope, so any process
 * importing it has its own copy. When server.ts is loaded outside the daemon
 * (terminal-launched MCP, plugin cache, dev hot-reload), calling
 * startProcess/spawnProcess from there forks managed children that the actual
 * daemon doesn't track — producing duplicate loops with the same name.
 *
 * Mutating MCP tools must gate on this so only the daemon's MCP surface can
 * change process state. Read-only tools (process_list, status) work everywhere.
 *
 * Accepts an optional override path for testing.
 */
export async function isDaemonProcess(pidFile: string = PID_FILE): Promise<boolean> {
  try {
    const text = await readFile(pidFile, "utf-8")
    const pid = parseInt(text.trim(), 10)
    return Number.isFinite(pid) && pid === process.pid
  } catch {
    return false
  }
}

// ── Notifications ────────────────────────────────────────────────────────────

export function notify(title: string, message: string): void {
  try {
    const trimmed = message.replace(/\s+/g, " ").trim().slice(0, 200)
    if (IS_LINUX) {
      Bun.spawnSync(["notify-send", title, trimmed])
    } else {
      const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      Bun.spawnSync(["osascript", "-e", `display notification "${escaped}" with title "${title}"`])
    }
  } catch (err) {
    console.error("[notify]", err)
  }
}
