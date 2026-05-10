import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { tmpdir } from "os"
import { randomBytes } from "crypto"
import { readdir } from "fs/promises"
import { writeNote, type NoteFrontmatter } from "../memory/graph.ts"
import { forgetCronAutoNotes } from "./forget-cron-auto-notes.ts"

function makeTempDir(): string {
  return join(tmpdir(), `claude-bot-test-${randomBytes(8).toString("hex")}`)
}

const autoFm: NoteFrontmatter = {
  type: "auto",
  tags: ["auto", "raw", "session"],
  created: "2026-05-09",
  updated: "2026-05-09",
}

describe("forgetCronAutoNotes", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    await Bun.spawn(["mkdir", "-p", tempDir]).exited
  })

  afterEach(async () => {
    await Bun.spawn(["rm", "-rf", tempDir]).exited
  })

  test("deletes auto-* notes whose body contains [Cron: marker", async () => {
    await writeNote(
      "auto-20260509-010101-aaaaaaaa",
      autoFm,
      "## message 1\n\n[Cron: moltbook-vote] do a thing",
      tempDir
    )
    await writeNote(
      "auto-20260509-020202-bbbbbbbb",
      autoFm,
      "## message 1\n\nuser asking a real interactive question",
      tempDir
    )

    const result = await forgetCronAutoNotes(tempDir)

    expect(result.forgot).toBe(1)
    expect(result.kept).toBe(1)

    const remaining = await readdir(tempDir)
    expect(remaining).toContain("auto-20260509-020202-bbbbbbbb.md")
    expect(remaining).not.toContain("auto-20260509-010101-aaaaaaaa.md")
  })

  test("ignores non-auto-* files at root even if they contain [Cron: marker", async () => {
    const factFm: NoteFrontmatter = { ...autoFm, type: "fact", tags: [] }
    await writeNote(
      "regular-note",
      factFm,
      "Notes about [Cron: x] cron syntax — keep me!",
      tempDir
    )

    const result = await forgetCronAutoNotes(tempDir)

    expect(result.forgot).toBe(0)
    expect(result.kept).toBe(0)
    const remaining = await readdir(tempDir)
    expect(remaining).toContain("regular-note.md")
  })

  test("ignores files in subfolders", async () => {
    await writeNote(
      "auto-20260509-030303-cccccccc",
      autoFm,
      "[Cron: x] in a moltbook subfolder",
      tempDir,
      "moltbook"
    )

    const result = await forgetCronAutoNotes(tempDir)

    expect(result.forgot).toBe(0)
    expect(result.kept).toBe(0)
    const moltbookFiles = await readdir(join(tempDir, "moltbook"))
    expect(moltbookFiles).toContain("auto-20260509-030303-cccccccc.md")
  })

  test("running twice is idempotent (second run is a no-op)", async () => {
    await writeNote(
      "auto-20260509-040404-dddddddd",
      autoFm,
      "[Cron: dream] consolidating",
      tempDir
    )

    const first = await forgetCronAutoNotes(tempDir)
    expect(first.forgot).toBe(1)

    const second = await forgetCronAutoNotes(tempDir)
    expect(second.forgot).toBe(0)
    expect(second.kept).toBe(0)
  })
})
