#!/usr/bin/env bun
import { readFile } from "fs/promises"
import { writeNote } from "../memory/graph.ts"

interface SessionEndInput {
  session_id?: string
  transcript_path?: string
}

interface TranscriptEntry {
  type?: string
  message?: {
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
  }
}

function extractText(content: TranscriptEntry["message"] extends infer M ? M : never): string {
  if (!content) return ""
  const c = content.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("\n")
  }
  return ""
}

function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/g, "")
    .replace(/<command-stdout>[\s\S]*?<\/command-stdout>/g, "")
    .trim()
}

try {
  const input = await Bun.stdin.text()
  const { transcript_path, session_id } = JSON.parse(input) as SessionEndInput

  if (!transcript_path) process.exit(0)

  const raw = await readFile(transcript_path, "utf-8")
  const lines = raw.split("\n").filter((l) => l.trim())

  const messages: string[] = []
  for (const line of lines) {
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== "user") continue
    if (entry.message?.role !== "user") continue
    const text = stripInjectedBlocks(extractText(entry.message))
    if (text) messages.push(text)
  }

  if (messages.length === 0) process.exit(0)

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const sid = session_id ? session_id.slice(0, 8) : "unknown"
  const name = `auto-${ts}-${sid}`

  const body = messages.map((m, i) => `## message ${i + 1}\n\n${m}`).join("\n\n")

  await writeNote(
    name,
    {
      type: "auto",
      tags: ["auto", "raw", "session"],
      created: now.toISOString().slice(0, 10),
      updated: now.toISOString().slice(0, 10),
    },
    body
  )
} catch (err) {
  console.error("[collect-hook]", err)
  process.exit(0)
}
