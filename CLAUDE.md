# claude-bot

Persistent Claude Code agent with long-term memory. A thin Bun daemon keeps adapter connections and cron jobs alive, routing all messages through one persistent Claude Code session via the agent SDK.

Default to using Bun instead of Node.js. Bun automatically loads .env, so don't use dotenv.

## Architecture

### Three layers

1. **MCP Server** (`server.ts`) — provides memory tools (`remember`/`recall`/`forget`), dreaming tools, `message_bot` (talk to the bot), and `setup` (install via launchd). Registered globally so every Claude Code session has access.
2. **Thin Daemon** (`daemon/`) — Bun process kept alive by launchd. Manages one persistent agent SDK session, runs the cron scheduler. Adapters plug in here later.
3. **Memory Graph** (`memory/`) — Obsidian-style markdown vault at `~/.claude-bot/memory/` with [[backlinks]], YAML frontmatter, and a query engine.

### How it works

All roads lead to one Claude Code session:
- `message_bot` MCP tool → `sendMessage()` → `query({ resume: sessionId })`
- Cron fires → `sendMessage()` → same session
- Adapter message (future) → `sendMessage()` → same session

The session has access to memory MCP tools, full Claude Code capabilities (bash, files, crons, subagents), and a CLAUDE.md personality in `~/.claude-bot/`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `remember` | Save a note to the memory graph |
| `recall` | Search memory (tag:, type:, keyword:, link:, after:, before:) |
| `forget` | Remove a memory note |
| `message_bot` | Send a message to the persistent bot session |
| `dream_run` | Trigger memory consolidation |
| `dream_status` | Get dreaming config |
| `dream_config` | Update dreaming interval/enabled |
| `status` | Daemon status, session ID, note count, cron jobs |
| `setup` | Install the daemon via launchd (first-time only) |
| `restart` | Restart the daemon |
| `stop` | Stop the daemon |
| `uninstall` | Remove launchd plist (preserves memory) |

## Memory Graph

Lives at `~/.claude-bot/memory/`. Notes are markdown with YAML frontmatter:

```markdown
---
type: person | project | workflow | fact | preference | daily
tags: [tag1, tag2]
created: 2026-04-08
updated: 2026-04-08
---

Content with [[backlinks]] to other notes.
```

### Dreaming

Memory consolidation uses `sendMessage()` to ask the bot to review notes in batches. Merges duplicates, improves content, removes stale entries. Runs as a cron job (default: every 6 hours) and can be triggered manually via `dream_run`.

## Cron Jobs

Persistent file-based crons at `~/.claude-bot/crons/*.md`:

```markdown
---
name: morning-summary
schedule: 0 9 * * *
catchup: true
notify: true
enabled: true
---

Summarize what happened yesterday. Check memory for context.
```

Standard 5-field cron expressions. The daemon checks every 60 seconds and fires matching jobs via `sendMessage()`. Crons survive daemon restarts because they're files on disk.

| Frontmatter | Default | Description |
|-------------|---------|-------------|
| `name` | filename | Job name |
| `schedule` | required | 5-field cron expression |
| `catchup` | `false` | Fire once on wake if missed while asleep |
| `notify` | `false` | macOS notification on completion/failure |
| `enabled` | `true` | Set to `false` to disable without deleting |

## Project Structure

```
claude-bot/
  server.ts          # MCP server (memory, dream, message_bot, setup)
  daemon/
    index.ts          # daemon entry point (session init, cron start)
    session.ts        # agent SDK session wrapper (create, resume, send)
    cron.ts           # file-based cron scheduler
    cron.test.ts      # cron tests
  memory/
    graph.ts          # note CRUD, frontmatter, backlinks
    graph.test.ts     # tests
    query.ts          # query parser and executor
    query.test.ts     # tests
    dream.ts          # memory consolidation via bot session
  lib/
    json.ts           # shared JSON parsing, date utils
  skills/
    setup/SKILL.md    # interactive setup skill
  package.json
  tsconfig.json
```

## Bot Directory (~/.claude-bot/)

```
~/.claude-bot/
  CLAUDE.md           # bot personality and behavior
  .mcp.json           # MCP config (memory server)
  session-id          # persistent session ID
  daemon.pid          # daemon PID
  memory/             # the graph
  crons/              # persistent cron job definitions
  logs/               # stdout/stderr
```

## Tech Stack

- **Runtime**: Bun
- **AI**: `@anthropic-ai/claude-agent-sdk`
- **MCP**: `@modelcontextprotocol/sdk`
- **Daemon**: launchd (macOS)
- **Memory**: Markdown files with frontmatter
