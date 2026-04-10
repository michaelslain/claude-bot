# claude-bot

Claude Code plugin that turns Claude into a personal assistant.
Long-term graph memory, scheduled tasks, and a background daemon.

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
- [Claude Code](https://claude.ai/download) installed and authenticated
- **macOS:** launchd (automatic)
- **Linux:** systemd (automatic)
- **Windows:** _Not yet supported_

---

## Usage

Just talk to Claude naturally, or use the MCP tools (listed below). The bot tools are available in every Claude Code session.

**Quick note:** Tools are available right after you install the plugin. Run `/claude-bot:setup` only if you want scheduled cron jobs and automatic memory consolidation.

### Examples

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

### MCP Tools

| Tool           | Description                                   |
| -------------- | --------------------------------------------- |
| `remember`     | Save a note to the memory graph               |
| `recall`       | Search memory with filters                    |
| `forget`       | Remove a memory note                          |
| `cron_list`    | List all cron jobs with status and config     |
| `cron_create`  | Create a new cron job                         |
| `cron_run`     | Trigger a cron job immediately                |
| `cron_update`  | Update a cron job (enable/disable, schedule)  |
| `cron_delete`  | Delete a cron job                             |
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

## Cron Jobs

Persistent file-based crons at `~/.claude-bot/crons/*.md`. They survive daemon restarts because they're just files on disk.

### Example

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

### Parameters

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

## Memory Graph

Notes are markdown files with YAML frontmatter and `[[backlinks]]`:

### Example

```markdown
---
type: person
tags: [team, engineering]
created: 2026-04-08
updated: 2026-04-08
---

I like chicken.
```

### Note Types

`person` `project` `workflow` `fact` `preference` `daily` `auto`

`auto` notes are created by the automatic prompt collector — raw conversation snippets that dreaming processes and consolidates into typed notes.

### Dreaming

Consolidates memory automatically — merging duplicates, improving notes, extracting value from `auto` notes, removing stale entries. Runs hourly via cron or manually via `dream_run`.

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

## Dev

```bash
git clone https://github.com/michaelslain/claude-bot.git
cd claude-bot
bun install
claude --plugin-dir .    # test locally
bun test                 # run tests
```

## License

MIT
