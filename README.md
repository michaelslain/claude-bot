# claude-bot

Persistent Claude Code agent with long-term memory, cron jobs, and a background daemon

## Install

```bash
git clone https://github.com/michaelslain/claude-bot.git
cd claude-bot
bun install
claude plugin marketplace add .
claude plugin install claude-bot@claude-bot-local
```

Restart Claude Code, then run:

```
/claude-bot:setup
```

## What it does

claude-bot runs a persistent Claude Code session as a background daemon via launchd. It has an Obsidian-style memory graph that persists across all sessions and restarts. Any Claude Code session can talk to it, save memories, and trigger cron jobs.

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
| `setup` | First-time install (creates dirs, plist, starts daemon) |
| `restart` | Restart the daemon |
| `stop` | Stop the daemon |
| `uninstall` | Remove the daemon (preserves memory) |

## Examples

### Talk to the bot

```
message_bot({ message: "What do you remember about me?" })
```

### Save a memory

```
remember({
  name: "project-deadline",
  type: "project",
  tags: ["work", "urgent"],
  content: "Ship v2 by Friday. [[client-acme]] is waiting."
})
```

### Search memory

```
recall({ query: "type:project tag:urgent" })
recall({ query: "acme deadline" })
```

### Cron jobs

Persistent file-based crons at `~/.claude-bot/crons/*.md`:

```markdown
---
name: morning-summary
schedule: 0 9 * * *
catchup: true
notify: true
---

Summarize what happened yesterday. Check memory for context.
```

| Frontmatter | Description |
|-------------|-------------|
| `schedule` | Standard 5-field cron expression |
| `catchup` | If `true`, fires once on wake if missed while asleep |
| `notify` | If `true`, sends macOS notification on completion |
| `enabled` | Set to `false` to disable without deleting |

## Architecture

```
claude-bot/
  server.ts          # MCP server (memory, dream, message_bot, setup)
  daemon/
    index.ts          # Daemon entry point
    session.ts        # Agent SDK session wrapper
    cron.ts           # File-based cron scheduler
  memory/
    graph.ts          # Note CRUD, frontmatter, backlinks
    query.ts          # Query parser and executor
    dream.ts          # Memory consolidation
  lib/
    json.ts           # Shared utilities
  skills/
    setup/SKILL.md    # Interactive setup skill

~/.claude-bot/
  CLAUDE.md           # Bot personality
  .mcp.json           # MCP config
  session-id          # Persistent session ID
  memory/             # The graph
  crons/              # Cron job definitions
  logs/               # Daemon logs
```

## Memory Graph

Notes are markdown files with YAML frontmatter and `[[backlinks]]`:

```markdown
---
type: person
tags: [team, engineering]
created: 2026-04-08
updated: 2026-04-08
---

Alice is the tech lead on [[project-atlas]]. Prefers async communication.
```

Note types: `person`, `project`, `workflow`, `fact`, `preference`, `daily`

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude CLI](https://claude.ai/download) installed and authenticated
- macOS (uses launchd for daemon management)

## Development

```bash
git clone https://github.com/michaelslain/claude-bot.git
cd claude-bot
bun install
```

Test locally:

```bash
claude --plugin-dir .
```

Run tests:

```bash
bun test
```

## License

MIT
