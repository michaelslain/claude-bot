import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "os"
import { join } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"

const BOT_DIR = join(homedir(), ".claude-bot")
const SESSION_FILE = join(BOT_DIR, "session-id")

/** Messages emitted by the Claude Agent SDK query stream. */
interface SdkMessage {
  type?: string
  subtype?: string
  session_id?: string
  result?: string
}

export async function getSessionId(): Promise<string | undefined> {
  try {
    const id = (await readFile(SESSION_FILE, "utf-8")).trim()
    return id || undefined
  } catch {
    return undefined
  }
}

async function saveSessionId(id: string): Promise<void> {
  await mkdir(BOT_DIR, { recursive: true })
  await writeFile(SESSION_FILE, id, "utf-8")
}

export interface BotResponse {
  result: string
  sessionId: string
}

export interface SendOptions {
  model?: string
  effort?: string
  abortController?: AbortController
  /** Session timeout in seconds. AbortController signal fires when exceeded. */
  timeoutSecs?: number
  /** Start a fresh session instead of resuming the existing one. */
  newSession?: boolean
}

export async function sendMessage(message: string, opts?: SendOptions): Promise<BotResponse> {
  const existingSessionId = await getSessionId()

  const options: Record<string, unknown> = {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: BOT_DIR,
    model: opts?.model ?? "haiku",
  }

  if (opts?.effort) {
    options.thinkingBudget = opts.effort === "high" ? "high" : opts.effort === "low" ? "low" : "medium"
  }

  const needsAc = opts?.abortController || opts?.timeoutSecs
  const ac = opts?.abortController ?? (needsAc ? new AbortController() : undefined)
  if (ac) options.abortController = ac

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (ac && opts?.timeoutSecs && opts.timeoutSecs > 0) {
    timeoutId = setTimeout(() => {
      console.log(`[session] Timeout reached (${opts.timeoutSecs}s), aborting session`)
      ac.abort()
    }, opts.timeoutSecs * 1000)
  }

  if (existingSessionId && !opts?.newSession) {
    options.resume = existingSessionId
  }

  let latestSessionId = existingSessionId ?? "unknown"
  // The SDK types are incomplete — cast options once at the boundary
  const q = claudeQuery({ prompt: message, options: options as Parameters<typeof claudeQuery>[0]["options"] })
  let resultText = ""

  try {
    for await (const event of q) {
      const msg = event as SdkMessage
      if (msg.session_id && msg.session_id !== latestSessionId) {
        latestSessionId = msg.session_id
        await saveSessionId(latestSessionId)
      }
      if (msg.type === "result" && msg.subtype === "success") {
        resultText = (msg.result ?? "").trim()
      }
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }

  return { result: resultText, sessionId: latestSessionId }
}
