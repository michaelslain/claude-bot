# claude-bot

Persistent Claude Code daemon with long-term memory, intelligent consolidation, and scheduled tasks. One always-on agent session + file-based cron scheduling + memory graph with folder organization.

---

## Install

```bash
git clone https://github.com/michaelslain/claude-bot.git
cd claude-bot
bun install
claude plugin marketplace add ./
claude plugin install claude-bot@claude-bot-local
```

Restart Claude Code, then run `/claude-bot:setup` to initialize the daemon.

### Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/download) installed and authenticated
- **macOS:** launchd (automatic)
- **Linux:** systemd (automatic)
- **Windows:** _Not yet supported_

---

## Usage

Memory tools are available in every Claude Code session via MCP. Talk to Claude naturally or use the tools directly.

### Remember & Recall

Save notes to your persistent memory graph:

```
remember({ 
  name: "react-hooks-rules", 
  type: "fact", 
  tags: ["react", "rules"], 
  content: "Custom hooks must follow Rules of Hooks...",
  folder: "projects"  // optional, single-level
})
```

Search all notes or scoped to a folder:

```
recall({ query: "type:project tag:active" })
recall({ query: "tag:active", folder: "projects" })  // folder scoped
```

Query syntax: `type:`, `tag:`, `keyword:`, `link:`, `after:`, `before:` (all optional, combine with spaces)

Delete notes:

```
forget({ name: "projects/old-idea" })  // folder-prefixed
forget({ name: "note" })                // from root
```

### Organizing with Folders

Optional single-level folders organize related notes:

- By project: `projects/auth`, `projects/api`
- By domain: `team/alice`, `infrastructure/kubernetes`
- By time: `daily/2026-05-09`, `archive/2024`
- By topic: `books/`, `research/`, `conferences/`

**Rules:**
- Alphanumeric, dash, underscore only: `[a-zA-Z0-9_-]+`
- Single-level only (no nesting)
- Backlinks are folder-agnostic (resolve across folders)

```
remember({
  name: "voting-standards",
  folder: "moltbook",  // creates moltbook/voting-standards
  content: "Voting rules for [[decision-making]]..."  // links to any folder
})
```

### Cron Jobs

Define recurring tasks as markdown files:

```markdown
---
name: morning-summary
schedule: 0 9 * * *
model: sonnet
---

Summarize yesterday's notes. What are today's top 3 priorities?
```

Manage via tools:

```
cron_create({ name: "daily", schedule: "0 18 * * *", prompt: "Review today" })
cron_list()
cron_run({ name: "daily" })
cron_update({ name: "daily", enabled: false })
```

### Memory Consolidation

The bot automatically consolidates memory hourly (or manually):

```
dream_run()  // trigger consolidation
dream_config({ intervalMs: 3600000 })  // 1 hour
dream_status()
```

Consolidation merges duplicates, improves clarity, removes stale notes, and **respects folder boundaries** (never merges across folders).

---

## Examples

### Project Knowledge Base

Organize project-specific notes in a folder:

```
remember({
  name: "architecture",
  folder: "auth-system",
  type: "project",
  content: "JWT + refresh rotation pattern"
})

remember({
  name: "JWT-tokens",
  folder: "auth-system",
  type: "fact",
  content: "Stateless tokens with exp claim"
})

# Later: search only auth project
recall({ query: "type:project", folder: "auth-system" })
```

### Daily Log

Auto-collected session notes (type: `auto`) + manual promotion to daily log:

```
remember({
  name: "2026-05-09",
  folder: "daily",
  type: "daily",
  tags: ["completed"],
  content: "✓ Shipped feature X\n→ Fix bug Y tomorrow"
})

recall({ query: "type:daily", folder: "daily" })
```

### Team Context

Capture team knowledge with cross-folder links:

```
remember({
  name: "alice",
  folder: "team",
  type: "person",
  tags: ["backend", "lead"],
  content: "Lead engineer, owns [[auth-system]]. Async communication only."
})

# auth-system is in projects/ folder — link still works
```

---

## Memory Graph

Lives at `~/.claude-bot/memory/`. Notes are markdown with YAML frontmatter:

```markdown
---
type: person | project | workflow | fact | preference | daily | auto
tags: [tag1, tag2]
created: 2026-05-08
updated: 2026-05-09
---

Content with [[backlinks]] to other notes.
```

### Backlinks

Notes link to other notes via `[[note-name]]`. Links are **folder-agnostic** — a note in any folder can link to any other note by bare name:

```markdown
[[auth-system]]        # links to auth-system in any folder
[[database-design]]    # resolves across all folders
```

Use `findBacklinks()` to discover all notes referencing a target.

### Memory Decay

During consolidation, stale, isolated notes (old dates + no backlinks) are candidates for deletion. Connected notes survive because they're part of the knowledge graph.

---

## Architecture

```
~/.claude-bot/                # Daemon home directory
├── CLAUDE.md                 # Bot personality / behavior rules
├── .mcp.json                 # MCP server config
├── session-id                # Persistent session ID
├── daemon.pid                # Daemon process ID
├── memory/                   # Note storage
│   ├── root-note.md
│   ├── projects/
│   │   ├── auth.md
│   │   └── api.md
│   ├── team/
│   │   └── alice.md
│   └── ...
├── crons/                    # Cron job definitions
│   ├── morning-summary.md
│   └── ...
└── logs/                     # Daemon stdout/stderr

src/
├── server.ts                 # MCP server
├── daemon/
│   ├── index.ts              # Daemon entry point
│   ├── session.ts            # Agent SDK session wrapper
│   ├── cron.ts               # Cron scheduler
│   └── process.ts            # Background process manager
├── memory/
│   ├── graph.ts              # Note CRUD + folder support
│   ├── query.ts              # Query parser/executor
│   ├── search.ts             # Keyword scoring
│   └── dream.ts              # Memory consolidation
└── lib/
    └── config.ts             # Configuration
```

---

## MCP Tools Reference

### remember

```ts
remember({
  name: string,           // required
  content: string,        // required
  type?: NoteType,        // default: "fact"
  tags?: string[],        // default: []
  folder?: string         // optional: single-level folder
})
→ { ok: boolean, name: string, error?: string }
```

### recall

```ts
recall({
  query: string,         // required: filters like "type:project tag:active"
  folder?: string        // optional: restrict to one folder
})
→ { ok: boolean, count: number, notes: MemoryNote[], error?: string }
```

**Query syntax:**
- `type:fact` — filter by type
- `tag:active` — filter by tag (multiple = AND)
- `keyword:auth` — search content/name/tags
- `link:other-note` — find notes linking to another
- `after:2026-05-01` — updated on or after (inclusive)
- `before:2026-05-10` — updated before (exclusive)

### forget

```ts
forget({
  name: string           // note name (may be folder-prefixed)
})
→ { ok: boolean, name: string, error?: string }
```

### cron_create

```ts
cron_create({
  name: string,          // required
  schedule: string,      // required: 5-field cron expression
  prompt: string,        // required: task instructions
  model?: "opus"|"sonnet"|"haiku",  // default: "haiku"
  effort?: "low"|"medium"|"high",
  catchup?: boolean,     // default: false
  notify?: boolean       // default: false
})
```

### cron_list, cron_run, cron_update, cron_delete

See CLAUDE.md for full details.

### dream_run, dream_config, dream_status

Consolidation tools. `dream_run()` triggers immediately; `dream_config()` updates interval; `dream_status()` shows current state.

---

## Guarantees & Constraints

| Guarantee | Detail |
|-----------|--------|
| **Folder isolation** | Notes never merge across folders during consolidation |
| **Backlink scope** | Backlinks resolve by bare name across all folders |
| **Atomic writes** | All note operations are atomic via `Bun.write()` |
| **Path safety** | Directory traversal attacks prevented; all paths validated |
| **Single-level folders** | Nesting auto-flattened (`a/b/c` → `a-b-c`) |
| **Folder name validation** | Regex `[a-zA-Z0-9_-]+` enforced |

---

## Development

### Setup

```bash
bun install
bun test  # Run tests (116+ test cases)
bunx tsc --noEmit  # Type check
```

### Running Locally

```bash
bun run server.ts  # Start MCP server on stdio
```

### Tech Stack

- **Runtime:** Bun
- **AI:** `@anthropic-ai/claude-agent-sdk`
- **MCP:** `@modelcontextprotocol/sdk`
- **Daemon:** launchd (macOS) / systemd (Linux)
- **Storage:** Markdown files with YAML frontmatter

---

## Testing

```bash
bun test                    # Run all tests
bun test memory/            # Run memory tests only
bun test --watch            # Watch mode
```

**Coverage:**
- 51 graph tests (CRUD, backlinks, folders, sanitization)
- 53 query tests (parsing, execution, folder filtering)
- 100% pass rate

---

## License

Internal (Anthropic).
