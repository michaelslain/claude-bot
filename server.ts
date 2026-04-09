import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { sendMessage, getSessionId } from "./daemon/session.ts"
import { loadCronJobs } from "./daemon/cron.ts"
import { listProcesses, startProcess, stopProcess } from "./daemon/process.ts"
import { writeNote, deleteNote, listNotes } from "./memory/graph.ts"
import type { NoteType } from "./memory/graph.ts"
import { query } from "./memory/query.ts"
import { dream, getDreamConfig, updateDreamConfig } from "./memory/dream.ts"
import { today } from "./lib/json.ts"
import { daemonConfigPath, generateDaemonConfig, installDaemon, unloadDaemon, reloadDaemon } from "./lib/platform.ts"
import { homedir } from "os"
import { join } from "path"
import { mkdir } from "fs/promises"

// ── Tool result helper ────────────────────────────────────────────────────────

function toResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

const BOT_DIR = join(homedir(), ".claude-bot")
const DAEMON_PATH = daemonConfigPath()
const SERVER_PATH = join(import.meta.dir, "server.ts")

function buildPath(): string {
  const essential = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin", join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin")]
  const parts = (process.env.PATH ?? "").split(":")
  const seen = new Set<string>()
  const merged: string[] = []
  for (const p of [...parts, ...essential]) {
    if (p && !seen.has(p)) { seen.add(p); merged.push(p) }
  }
  return merged.join(":")
}

const CLAUDE_MD = `# Claude Bot

You are a persistent Claude Code daemon running as a background service. You have long-term memory that persists across all sessions and restarts. You are the user's always-on AI assistant.

## CRITICAL: You MUST use your MCP memory tools

You have MCP tools from the "claude-bot-memory" server. You MUST actively use them:

### remember
Call this tool to save important information. Do this EVERY time someone tells you something worth keeping.

Example: When user says "I prefer dark mode", immediately call:
\`\`\`
remember({ name: "user-prefers-dark-mode", type: "preference", tags: ["ui"], content: "User prefers dark mode for all applications." })
\`\`\`

Parameters:
- \`name\` (required): kebab-case filename for the note
- \`content\` (required): markdown content, can include [[backlinks]] to other notes
- \`type\`: one of person, project, workflow, fact, preference, daily, auto (default: fact)
- \`tags\`: array of lowercase tags

### recall
Call this tool to search your memory BEFORE answering questions. Always check if you already know something relevant.

Example queries:
- \`recall({ query: "type:person" })\` — find all people
- \`recall({ query: "tag:project" })\` — find by tag
- \`recall({ query: "bun node preference" })\` — keyword search
- \`recall({ query: "type:preference tag:tooling" })\` — combined filters

### forget
Call this to remove outdated or incorrect memories:
\`\`\`
forget({ name: "old-note-name" })
\`\`\`

### dream_run
Call this to consolidate memory — merges duplicates, improves notes, removes stale entries. Do this periodically.

## When to use memory

ALWAYS remember:
- User's name, role, preferences
- Decisions made in conversation
- Project details and context
- Action items and commitments
- Facts that would be useful later

ALWAYS recall before answering:
- When someone asks you something — check if you already know
- At the start of every conversation — recall recent context
- When a topic comes up — search for related memories

## Note types
- \`person\` — info about people (name, role, preferences)
- \`project\` — ongoing projects and their status
- \`workflow\` — recurring processes and procedures
- \`fact\` — standalone facts worth remembering
- \`preference\` — user preferences and settings
- \`daily\` — daily summaries and logs

## Behavior
- Be direct and concise — you're a daemon, not a chatbot
- ALWAYS use remember/recall tools — this is your primary differentiator
- Check memory before every response
- Save new information proactively without being asked
- Use [[backlinks]] in note content to connect related memories
- When unsure if something is worth remembering, remember it anyway
`

async function isInstalled(): Promise<boolean> {
  return Bun.file(DAEMON_PATH).exists()
}

async function getDaemonPid(): Promise<number | null> {
  try {
    const text = await Bun.file(join(BOT_DIR, "daemon.pid")).text()
    const pid = parseInt(text.trim(), 10)
    if (!isNaN(pid)) { process.kill(pid, 0); return pid }
  } catch {}
  return null
}

function daemonOpts() {
  return {
    bunPath: Bun.which("bun") ?? (process.platform === "darwin" ? "/opt/homebrew/bin/bun" : join(homedir(), ".bun", "bin", "bun")),
    daemonEntry: join(import.meta.dir, "daemon", "index.ts"),
    logsDir: join(BOT_DIR, "logs"),
    workDir: BOT_DIR,
    envPath: buildPath(),
  }
}

async function setupBot(): Promise<{ ok: boolean; message: string }> {
  if (await isInstalled()) {
    return { ok: false, message: "Already installed. Use 'restart' to reload, or 'uninstall' first to reinstall." }
  }

  const logsDir = join(BOT_DIR, "logs")
  await mkdir(logsDir, { recursive: true })
  await mkdir(join(BOT_DIR, "memory"), { recursive: true })
  await mkdir(join(BOT_DIR, "crons"), { recursive: true })
  await mkdir(join(BOT_DIR, "processes"), { recursive: true })

  // Write default dream cron (every 6 hours)
  const dreamCronPath = join(BOT_DIR, "crons", "dream.md")
  if (!(await Bun.file(dreamCronPath).exists())) {
    await Bun.write(dreamCronPath, `---\nname: dream\nschedule: 0 */6 * * *\n---\n\nRun dream_run to consolidate and improve memory. Merge duplicates, add backlinks, remove stale notes.\n`)
  }

  // Write CLAUDE.md only if it doesn't exist AND skill hasn't written one
  const claudeMdPath = join(BOT_DIR, "CLAUDE.md")
  if (!(await Bun.file(claudeMdPath).exists())) {
    await Bun.write(claudeMdPath, CLAUDE_MD) // fallback if setup called without skill
  }

  // Write .mcp.json only if it doesn't exist
  const mcpJsonPath = join(BOT_DIR, ".mcp.json")
  if (!(await Bun.file(mcpJsonPath).exists())) {
    await Bun.write(mcpJsonPath, JSON.stringify({
      mcpServers: {
        "claude-bot-memory": { command: "bun", args: ["run", SERVER_PATH] }
      }
    }, null, 2) + "\n")
  }

  // Write permissions for the bot's OWN session (runs in ~/.claude-bot/).
  // This only affects the daemon's agent session, not the user's Claude Code sessions.
  // The daemon needs bypass to operate autonomously (memory tools, file access, bash for crons).
  const settingsDir = join(BOT_DIR, ".claude")
  await mkdir(settingsDir, { recursive: true })
  const settingsPath = join(settingsDir, "settings.local.json")
  if (!(await Bun.file(settingsPath).exists())) {
    await Bun.write(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          "mcp__claude-bot-memory__remember",
          "mcp__claude-bot-memory__recall",
          "mcp__claude-bot-memory__forget",
          "mcp__claude-bot-memory__dream_run",
          "mcp__claude-bot-memory__dream_status",
          "mcp__claude-bot-memory__dream_config",
          "mcp__claude-bot-memory__message_bot",
          "mcp__claude-bot-memory__setup",
          "mcp__claude-bot-memory__restart",
          "mcp__claude-bot-memory__stop",
          "mcp__claude-bot-memory__uninstall",
          "mcp__claude-bot-memory__status",
          "mcp__claude-bot-memory__process_list",
          "mcp__claude-bot-memory__process_start",
          "mcp__claude-bot-memory__process_stop",
          "Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)"
        ]
      }
    }, null, 2) + "\n")
  }

  // Write and load daemon config
  const config = generateDaemonConfig(daemonOpts())
  const result = await installDaemon(DAEMON_PATH, config)
  if (!result.ok) return { ok: false, message: result.error ?? "Failed to install daemon" }

  return { ok: true, message: `Installed and started. Bot running in ${BOT_DIR}.` }
}

async function restartBot(): Promise<{ ok: boolean; message: string }> {
  if (!(await isInstalled())) {
    return { ok: false, message: "Not installed. Run 'setup' first." }
  }

  const config = generateDaemonConfig(daemonOpts())
  const result = reloadDaemon(DAEMON_PATH, config)
  if (!result.ok) return { ok: false, message: result.error ?? "Failed to restart daemon" }

  return { ok: true, message: "Daemon restarted." }
}

async function stopBot(): Promise<{ ok: boolean; message: string }> {
  const pid = await getDaemonPid()
  if (!pid) {
    return { ok: false, message: "Daemon is not running." }
  }

  unloadDaemon(DAEMON_PATH)
  return { ok: true, message: `Daemon stopped (PID ${pid}).` }
}

async function uninstallBot(): Promise<{ ok: boolean; message: string }> {
  unloadDaemon(DAEMON_PATH)
  try {
    const { unlink } = await import("fs/promises")
    await unlink(DAEMON_PATH)
  } catch {}
  return { ok: true, message: `Uninstalled. Daemon config removed. Memory and config in ${BOT_DIR} preserved.` }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "claude-bot", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description: "Save a note to the memory graph",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Note name (used as filename)" },
          type: {
            type: "string",
            description: "Note type: person | project | workflow | fact | preference | daily | auto",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for the note",
          },
          content: {
            type: "string",
            description: "Markdown content of the note (can include [[backlinks]])",
          },
        },
        required: ["name", "content"],
      },
    },
    {
      name: "forget",
      description: "Remove a note from the memory graph",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the note to forget" },
        },
        required: ["name"],
      },
    },
    {
      name: "recall",
      description:
        "Search the memory graph (supports tag:, type:, keyword:, link:, after:, before: filters)",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Query string, e.g. 'type:person tag:active' or 'auth module'",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "dream_run",
      description:
        "Trigger a manual dream cycle — consolidates, deduplicates, and improves memory notes",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "dream_status",
      description: "Get dreaming (memory consolidation) status and config",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "dream_config",
      description: "Update dreaming configuration",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Enable or disable dreaming" },
          intervalMs: {
            type: "number",
            description: "Interval between dream cycles in milliseconds",
          },
        },
      },
    },
    {
      name: "status",
      description: "Get claude-bot daemon status — whether it's running, session ID, uptime, memory note count, cron job count",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "message_bot",
      description: "Send a message to the claude-bot. Runs a Claude Code session in ~/.claude-bot/ with the bot's CLAUDE.md and memory tools.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message to send to the bot" },
          model: { type: "string", description: "Model to use: opus, sonnet, haiku (default: haiku)" },
          effort: { type: "string", description: "Thinking effort: low, medium, high" },
        },
        required: ["message"],
      },
    },
    {
      name: "process_list",
      description: "List all managed background processes and their status",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "process_start",
      description: "Start a stopped background process",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the process to start" },
        },
        required: ["name"],
      },
    },
    {
      name: "process_stop",
      description: "Stop a running background process",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the process to stop" },
        },
        required: ["name"],
      },
    },
    {
      name: "setup",
      description: "First-time install of claude-bot. Creates ~/.claude-bot/ directory, CLAUDE.md, MCP config, crons, and daemon service. Only runs once — fails if already installed.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "restart",
      description: "Restart the claude-bot daemon. Use after changing code or config.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "stop",
      description: "Stop the claude-bot daemon.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "uninstall",
      description: "Uninstall claude-bot. Stops the daemon and removes the service config.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case "remember": {
      const { name: noteName, type, tags, content } = args as {
        name: string
        type?: string
        tags?: string[]
        content: string
      }
      const date = today()
      await writeNote(
        noteName,
        {
          type: (type as NoteType) ?? "fact",
          tags: tags ?? [],
          created: date,
          updated: date,
        },
        content
      )
      return toResult({ ok: true, name: noteName })
    }

    case "forget": {
      const { name: noteName } = args as { name: string }
      const deleted = await deleteNote(noteName)
      return toResult({ ok: deleted, name: noteName })
    }

    case "recall": {
      const { query: queryString } = args as { query: string }
      const results = await query(queryString)
      return toResult({ ok: true, count: results.length, notes: results })
    }

    case "dream_run": {
      const result = await dream()
      return toResult({ ok: true, ...result })
    }

    case "dream_status":
      return toResult({ ok: true, ...getDreamConfig() })

    case "dream_config": {
      const config = args as Partial<{ enabled: boolean; intervalMs: number }>
      updateDreamConfig(config)
      return toResult({ ok: true, ...getDreamConfig() })
    }

    case "status": {
      const daemonPid = await getDaemonPid()
      const noteCount = (await listNotes()).length
      const cronJobs = await loadCronJobs()
      const sessionId = await getSessionId()
      const processes = listProcesses()

      return toResult({
        ok: true,
        daemon: { running: daemonPid !== null, pid: daemonPid },
        session: sessionId ?? null,
        memory: { noteCount },
        crons: cronJobs.map((c) => ({ name: c.name, schedule: c.schedule })),
        processes,
      })
    }

    case "process_list":
      return toResult({ ok: true, processes: listProcesses() })

    case "process_start": {
      const { name: procName } = args as { name: string }
      return toResult(startProcess(procName))
    }

    case "process_stop": {
      const { name: procName } = args as { name: string }
      return toResult(stopProcess(procName))
    }

    case "message_bot": {
      if (!(await isInstalled())) {
        return toResult({ ok: false, error: "claude-bot is not set up yet. Run /claude-bot:setup or call the setup tool first." })
      }
      const { message, model, effort } = args as { message: string; model?: string; effort?: string }
      try {
        const response = await sendMessage(message, { model, effort })
        return toResult({ ok: true, response: response.result, sessionId: response.sessionId })
      } catch (err) {
        return toResult({ ok: false, error: String(err) })
      }
    }

    case "setup": {
      try {
        return toResult(await setupBot())
      } catch (err) {
        return toResult({ ok: false, error: String(err) })
      }
    }

    case "restart": {
      try {
        return toResult(await restartBot())
      } catch (err) {
        return toResult({ ok: false, error: String(err) })
      }
    }

    case "stop": {
      try {
        return toResult(await stopBot())
      } catch (err) {
        return toResult({ ok: false, error: String(err) })
      }
    }

    case "uninstall": {
      try {
        return toResult(await uninstallBot())
      } catch (err) {
        return toResult({ ok: false, error: String(err) })
      }
    }

    default:
      return toResult({ ok: false, error: `Unknown tool: ${name}` })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

// Ensure memory hook is registered in global Claude settings
interface HookEntry { hooks?: Array<{ type?: string; command?: string }> }
interface ClaudeSettings {
  hooks?: { UserPromptSubmit?: HookEntry[] }
  [key: string]: unknown
}

try {
  const globalSettingsPath = join(homedir(), ".claude", "settings.json")
  let settings: ClaudeSettings = {}
  try {
    settings = JSON.parse(await Bun.file(globalSettingsPath).text()) as ClaudeSettings
  } catch {
    // File may not exist yet — start with empty settings
  }

  const hookCommand = `bun run ${join(import.meta.dir, "bin", "memory-hook.ts")}`

  if (!settings.hooks) settings.hooks = {}
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = []

  const existing = settings.hooks.UserPromptSubmit.some((entry) =>
    entry.hooks?.some((h) => h.command?.includes("memory-hook.ts"))
  )

  if (!existing) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command: hookCommand }],
    })
    await Bun.write(globalSettingsPath, JSON.stringify(settings, null, 2) + "\n")
  }
} catch (err) {
  console.error("[server] Failed to register memory hook:", err)
}

const transport = new StdioServerTransport()
await server.connect(transport)
