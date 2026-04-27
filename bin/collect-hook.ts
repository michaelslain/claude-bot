#!/usr/bin/env bun
import { writeNote } from "../memory/graph.ts"
import { loadUserConfig } from "../lib/user-config.ts"

try {
  const input = await Bun.stdin.text()
  const { prompt } = JSON.parse(input) as { prompt: string }

  if (!prompt) process.exit(0)

  // Strip <system-reminder> blocks injected by other hooks (e.g. recall-hook)
  const stripped = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()

  const config = await loadUserConfig()

  // --- Junk filter ---

  // Too short to contain meaningful knowledge
  if (stripped.length < config.minPromptLength) process.exit(0)

  // Slash commands
  if (stripped.startsWith("/")) process.exit(0)

  // Cron prompts — already stored in cron files
  if (stripped.startsWith("[Cron:")) process.exit(0)

  // Task notifications — system plumbing
  if (stripped.includes("<task-notification>")) process.exit(0)

  // Daemon startup prompt
  if (stripped.includes("You are now running as a background daemon")) process.exit(0)

  // Prompts that are still system/hook XML after stripping known blocks
  if (stripped.startsWith("<")) process.exit(0)

  // Questions and short commands — not declarative knowledge
  // (ends with ? and is under maxShortQuestionLength, or is clearly imperative)
  if (stripped.length < config.maxShortQuestionLength && stripped.endsWith("?")) process.exit(0)
  if (stripped.length < 200 && /^(can you|could you|please|just|ok |u can|how about|try |run |kill |restart |stop |check |give |wait )/i.test(stripped)) process.exit(0)

  // Mostly code — check for indentation and code markers
  const lines = stripped.split("\n")
  if (lines.length > 3) {
    const codeLines = lines.filter(
      (l) =>
        l.startsWith("  ") ||
        l.startsWith("\t") ||
        l.includes("```") ||
        /^(import |export |const |let |var |function |class |if \(|for \(|while \(|return )/.test(
          l.trim()
        )
    ).length
    if (codeLines / lines.length > 0.5) process.exit(0)
  }

  // Generate unique name from timestamp
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ms = String(now.getMilliseconds()).padStart(3, "0")
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${ms}`
  const name = `auto-${ts}`

  await writeNote(
    name,
    {
      type: "auto",
      tags: ["auto", "raw"],
      created: now.toISOString().slice(0, 10),
      updated: now.toISOString().slice(0, 10),
    },
    stripped
  )
} catch (err) {
  console.error("[collect-hook]", err)
  process.exit(0)
}
