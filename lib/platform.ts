import { homedir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import { mkdir } from "fs/promises"

const IS_LINUX = process.platform === "linux"
const LABEL = "com.claude-bot.daemon"
const SERVICE_NAME = "claude-bot"

// ── Paths ────────────────────────────────────────────────────────────────────

export function daemonConfigPath(): string {
  if (IS_LINUX) return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`)
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
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
    <key>Label</key><string>${LABEL}</string>
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
    const enable = spawnSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME])
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
    spawnSync("systemctl", ["--user", "stop", SERVICE_NAME])
    spawnSync("systemctl", ["--user", "disable", SERVICE_NAME])
  } else {
    spawnSync("launchctl", ["unload", configPath])
  }
}

export async function reloadDaemon(configPath: string, config: string): Promise<{ ok: boolean; error?: string }> {
  await Bun.write(configPath, config)
  if (IS_LINUX) {
    spawnSync("systemctl", ["--user", "daemon-reload"])
    const restart = spawnSync("systemctl", ["--user", "restart", SERVICE_NAME])
    if (restart.status !== 0) return { ok: false, error: `restart failed: ${restart.stderr?.toString()}` }
    return { ok: true }
  }
  spawnSync("launchctl", ["unload", configPath])
  const load = spawnSync("launchctl", ["load", configPath])
  if (load.status !== 0) return { ok: false, error: `launchctl load failed: ${load.stderr?.toString()}` }
  return { ok: true }
}

// ── Notifications ────────────────────────────────────────────────────────────

export function notify(title: string, message: string): void {
  try {
    const trimmed = message.slice(0, 200)
    if (IS_LINUX) {
      Bun.spawnSync(["notify-send", title, trimmed])
    } else {
      const escaped = trimmed.replace(/"/g, '\\"').replace(/\n/g, " ")
      Bun.spawnSync(["osascript", "-e", `display notification "${escaped}" with title "${title}"`])
    }
  } catch (err) {
    console.error("[notify]", err)
  }
}
