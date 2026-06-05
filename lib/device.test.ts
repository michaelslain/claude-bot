import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile, writeFile } from "fs/promises"
import { tmpdir, hostname } from "os"
import { join } from "path"
import { getDeviceId, getDeviceLabel } from "./device.ts"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-bot-device-test-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("getDeviceId", () => {
  it("generates and persists a UUID on first read", async () => {
    const id = await getDeviceId(home)
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)

    const onDisk = (await readFile(join(home, "device-id"), "utf-8")).trim()
    expect(onDisk).toBe(id)
  })

  it("returns the same id on subsequent reads (stable)", async () => {
    const first = await getDeviceId(home)
    const second = await getDeviceId(home)
    expect(second).toBe(first)
  })

  it("reuses an existing persisted id", async () => {
    await writeFile(join(home, "device-id"), "preexisting-id-123\n", "utf-8")
    const id = await getDeviceId(home)
    expect(id).toBe("preexisting-id-123")
  })
})

describe("getDeviceLabel", () => {
  it("returns os.hostname()", () => {
    expect(getDeviceLabel()).toBe(hostname())
  })
})
