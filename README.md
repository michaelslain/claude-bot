# claude-bot

> Persistent Claude Code agent with long-term memory, cron jobs, and a background daemon

Your AI assistant that actually remembers. claude-bot runs a persistent Claude Code session as a background daemon, with an Obsidian-style memory graph that persists across all sessions and restarts. Ask it about your projects, deadlines, and decisions from any Claude Code session — it knows the context.

---

## Install

```bash
git clone https://github.com/michaelslain/claude-bot.git
cd claude-bot
bun install
claude plugin marketplace add .
claude plugin install claude-bot@claude-bot-local
```

Restart Claude Code, then run `/claude-bot:setup` to personalize your bot.

### Requirements

- [Bun](https://bun.sh) runtime
- [Claude CLI](https://claude.ai/download) installed and authenticated
- macOS (uses launchd for daemon management)

---

## Usage

Just talk to Claude naturally. The bot tools are available in every Claude Code session.

> "Ask the bot what tasks are due this week"
>
> "Tell the bot I decided to go with Postgres over SQLite"
>
> "What does the bot remember about the auth migration?"
>
> "Remember that Alice prefers async communication"
>
> "Search my memory for anything about project deadlines"
>
> "Ask the bot to summarize my current projects — use sonnet for this one"
>
> "Run a dream cycle to clean up memory"
>
> "What's the bot's status?"

The default model is `haiku`. You can ask for `opus` or `sonnet` when you need more depth.

---

## Cron Jobs

Persistent file-based crons at `~/.claude-bot/crons/*.md`. They survive daemon restarts because they're just files on disk.

```markdown
---
name: morning-briefing
schedule: 0 9 * * *
catchup: true
notify: true
model: sonnet
effort: medium
---

Check memory for my current projects, upcoming deadlines, and open tasks.
Give me a brief morning summary of what I should focus on today.
```

| Frontmatter | Default  | Description                                |
| ----------- | -------- | ------------------------------------------ |
| `name`      | filename | Job name                                   |
| `schedule`  | required | 5-field cron expression                    |
| `model`     | `haiku`  | Model: `opus`, `sonnet`, `haiku`           |
| `effort`    |          | Thinking effort: `low`, `medium`, `high`   |
| `catchup`   | `false`  | Fire once on wake if missed while asleep   |
| `notify`    | `false`  | macOS notification on completion/failure   |
| `enabled`   | `true`   | Set to `false` to disable without deleting |

---

## MCP Tools

| Tool           | Description                                   |
| -------------- | --------------------------------------------- |
| `remember`     | Save a note to the memory graph               |
| `recall`       | Search memory with filters                    |
| `forget`       | Remove a memory note                          |
| `message_bot`  | Send a message to the bot                     |
| `dream_run`    | Trigger memory consolidation                  |
| `dream_status` | Get dreaming config                           |
| `dream_config` | Update dreaming interval/enabled              |
| `status`       | Bot status, session ID, note count, cron jobs |
| `setup`        | First-time install via launchd                |
| `restart`      | Restart the bot                               |
| `stop`         | Stop the bot                                  |
| `uninstall`    | Remove the bot (preserves memory)             |

---

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

**Note types:** `person` `project` `workflow` `fact` `preference` `daily`

**Dreaming** consolidates memory automatically — merging duplicates, improving notes, removing stale entries. Runs as a cron (default: every 6 hours) or manually via `dream_run`.

---

## Architecture

```
claude-bot/
  server.ts            MCP server (memory, dream, message_bot, setup)
  daemon/
    index.ts            Daemon entry point
    session.ts          Agent SDK session wrapper
    cron.ts             File-based cron scheduler
  memory/
    graph.ts            Note CRUD, frontmatter, backlinks
    query.ts            Query parser and executor
    dream.ts            Memory consolidation
  lib/
    json.ts             Shared utilities
  skills/
    setup/SKILL.md      Interactive setup skill

~/.claude-bot/
  CLAUDE.md             Bot personality
  .mcp.json             MCP config
  session-id            Persistent session ID
  memory/               The graph
  crons/                Cron job definitions
  logs/                 Daemon logs
```

---

## Development

```bash
git clone https://github.com/michaelslain/claude-bot.git
cd claude-bot
bun install
claude --plugin-dir .    # test locally
bun test                 # run tests
```

## License

MIT
