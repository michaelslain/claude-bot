#!/usr/bin/env bun
import { readFile } from "fs/promises"
import { writeNote, getMemoryDir } from "../memory/graph.ts"

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

const MIN_BODY_CHARS = 50
const MAX_BODY_CHARS = 8000
const TRUNCATE_HEAD = 4000
const TRUNCATE_TAIL = 4000
const TRUNCATE_MARKER = "\n\n... [truncated] ...\n\n"
const CRON_PREFIX = "[Cron: "

function extractText(message: TranscriptEntry["message"]): string {
  if (!message) return ""
  const c = message.content
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

function extractUserMessages(rawTranscript: string): string[] {
  const lines = rawTranscript.split("\n").filter((l) => l.trim())
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
  return messages
}

export interface ProcessOptions {
  dir?: string
  now?: Date
}

export interface ProcessResult {
  written: boolean
  reason?: "cron" | "trivial"
  name?: string
  body?: string
}

export async function processTranscript(
  rawTranscript: string,
  sessionId: string | undefined,
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const messages = extractUserMessages(rawTranscript)

  // Daemon-fired cron sessions prepend "[Cron: <name>] " to every prompt
  // (see daemon/cron.ts). Their bodies contain raw cron text that pollutes
  // keyword recall, so drop the entire session.
  if (messages.some((m) => m.startsWith(CRON_PREFIX))) {
    return { written: false, reason: "cron" }
  }

  const totalChars = messages.reduce((sum, m) => sum + m.length, 0)
  if (totalChars < MIN_BODY_CHARS) {
    return { written: false, reason: "trivial" }
  }

  let body = messages.map((m, i) => `## message ${i + 1}\n\n${m}`).join("\n\n")
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, TRUNCATE_HEAD) + TRUNCATE_MARKER + body.slice(-TRUNCATE_TAIL)
  }

  const now = options.now ?? new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const sid = sessionId ? sessionId.slice(0, 8) : "unknown"
  const name = `auto-${ts}-${sid}`

  await writeNote(
    name,
    {
      type: "auto",
      tags: ["auto", "raw", "session"],
      created: now.toISOString().slice(0, 10),
      updated: now.toISOString().slice(0, 10),
    },
    body,
    options.dir ?? getMemoryDir()
  )

  return { written: true, name, body }
}

if (import.meta.main) {
  try {
    const input = await Bun.stdin.text()
    const { transcript_path, session_id } = JSON.parse(input) as SessionEndInput

    if (!transcript_path) process.exit(0)

    const raw = await readFile(transcript_path, "utf-8")
    await processTranscript(raw, session_id)
  } catch (err) {
    console.error("[collect-hook]", err)
    process.exit(0)
  }
}
