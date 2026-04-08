import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "os"
import { join } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"

const BOT_DIR = join(homedir(), ".claude-bot")
const SESSION_FILE = join(BOT_DIR, "session-id")

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

export async function sendMessage(message: string): Promise<BotResponse> {
  const existingSessionId = await getSessionId()

  const options: Record<string, unknown> = {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: BOT_DIR,
  }

  if (existingSessionId) {
    options.resume = existingSessionId
  }

  let latestSessionId = existingSessionId ?? "unknown"
  const q = claudeQuery({ prompt: message, options: options as any })
  let resultText = ""

  for await (const msg of q) {
    if ((msg as any).session_id) {
      latestSessionId = (msg as any).session_id
      await saveSessionId(latestSessionId)
    }
    if ((msg as any).type === "result" && (msg as any).subtype === "success") {
      resultText = ((msg as any).result ?? "").trim()
    }
  }

  const sessionId = latestSessionId
  const result = resultText

  return { result, sessionId }
}
