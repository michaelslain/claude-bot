import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { tmpdir } from "os"
import { randomBytes } from "crypto"
import { readdir, readFile } from "fs/promises"
import { processTranscript } from "./collect-hook.ts"

function makeTempDir(): string {
  return join(tmpdir(), `claude-bot-test-${randomBytes(8).toString("hex")}`)
}

function userLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  })
}

function makeTranscript(messages: string[]): string {
  return messages.map(userLine).join("\n")
}

describe("collect-hook processTranscript", () => {
  let tempDir: string
  const fixedNow = new Date(2026, 4, 9, 12, 34, 56)

  beforeEach(async () => {
    tempDir = makeTempDir()
    await Bun.spawn(["mkdir", "-p", tempDir]).exited
  })

  afterEach(async () => {
    await Bun.spawn(["rm", "-rf", tempDir]).exited
  })

  test("skips when any user message starts with [Cron: marker", async () => {
    const transcript = makeTranscript([
      "[Cron: moltbook-vote] Run a voting pass with epistemic standards.",
      "Some follow-up message that is long enough to clear the trivial threshold easily.",
    ])
    const result = await processTranscript(transcript, "abcd1234", {
      dir: tempDir,
      now: fixedNow,
    })

    expect(result.written).toBe(false)
    expect(result.reason).toBe("cron")
    const files = await readdir(tempDir)
    expect(files).toEqual([])
  })

  test("writes auto-note for normal interactive messages", async () => {
    const transcript = makeTranscript([
      "Hey, can you check the latest moltbook posts and summarize the trends from this week for me?",
    ])
    const result = await processTranscript(transcript, "abcd1234efgh5678", {
      dir: tempDir,
      now: fixedNow,
    })

    expect(result.written).toBe(true)
    expect(result.name).toMatch(/^auto-\d{8}-\d{6}-abcd1234$/)

    const files = await readdir(tempDir)
    expect(files.length).toBe(1)

    const content = await readFile(join(tempDir, files[0]!), "utf-8")
    expect(content).toContain("type: auto")
    expect(content).toContain("tags: [auto, raw, session]")
    expect(content).toContain("Hey, can you check the latest moltbook posts")
  })

  test("skips when stripped body is shorter than 50 chars", async () => {
    const transcript = makeTranscript(["Hi there"])
    const result = await processTranscript(transcript, "abcd1234", {
      dir: tempDir,
      now: fixedNow,
    })

    expect(result.written).toBe(false)
    expect(result.reason).toBe("trivial")
    const files = await readdir(tempDir)
    expect(files).toEqual([])
  })

  test("skips when only injected system-reminder blocks remain after stripping", async () => {
    const transcript = makeTranscript([
      "<system-reminder>some hook context with lots and lots of injected stuff</system-reminder>",
    ])
    const result = await processTranscript(transcript, "abcd1234", {
      dir: tempDir,
      now: fixedNow,
    })

    expect(result.written).toBe(false)
    expect(result.reason).toBe("trivial")
  })

  test("truncates body when over 8000 chars and inserts marker", async () => {
    const longText = "x".repeat(9000)
    const transcript = makeTranscript([longText])
    const result = await processTranscript(transcript, "abcd1234", {
      dir: tempDir,
      now: fixedNow,
    })

    expect(result.written).toBe(true)
    expect(result.body).toBeDefined()
    expect(result.body!).toContain("[truncated]")
    // First 4000 + marker + last 4000 ≈ ~8030 chars; well under the original 9013.
    expect(result.body!.length).toBeLessThan(9000)
    expect(result.body!.length).toBeGreaterThanOrEqual(8000)
  })

  test("running twice with the same input is idempotent (single file on disk)", async () => {
    const transcript = makeTranscript([
      "Hey, can you check the latest moltbook posts and summarize the trends from this week for me?",
    ])
    await processTranscript(transcript, "abcd1234", { dir: tempDir, now: fixedNow })
    await processTranscript(transcript, "abcd1234", { dir: tempDir, now: fixedNow })

    const files = await readdir(tempDir)
    expect(files.length).toBe(1)
  })
})
