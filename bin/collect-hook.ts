#!/usr/bin/env bun
import { writeNote } from "../memory/graph.ts"

try {
  const input = await Bun.stdin.text()
  const { prompt } = JSON.parse(input) as { prompt: string }

  if (!prompt) process.exit(0)

  // --- Junk filter ---

  // Too short to be meaningful
  if (prompt.length < 30) process.exit(0)

  // Slash commands
  if (prompt.startsWith("/")) process.exit(0)

  // Mostly code — check for indentation and code markers
  const lines = prompt.split("\n")
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
    prompt
  )
} catch (err) {
  console.error("[collect-hook]", err)
  process.exit(0)
}
