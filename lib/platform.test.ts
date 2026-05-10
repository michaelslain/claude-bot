import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { isDaemonProcess } from "./platform"

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "claude-bot-platform-test-"))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("isDaemonProcess", () => {
  it("returns true when the pid file matches the current process", async () => {
    const pidFile = join(testDir, "daemon.pid")
    await writeFile(pidFile, String(process.pid), "utf-8")
    expect(await isDaemonProcess(pidFile)).toBe(true)
  })

  it("returns false when the pid file points to a different process", async () => {
    const pidFile = join(testDir, "daemon.pid")
    // Use a pid that exists but isn't us. PID 1 (init/launchd) is reliably
    // present and reliably not equal to process.pid.
    await writeFile(pidFile, "1", "utf-8")
    expect(await isDaemonProcess(pidFile)).toBe(false)
  })

  it("returns false when the pid file is missing", async () => {
    expect(await isDaemonProcess(join(testDir, "missing.pid"))).toBe(false)
  })

  it("returns false when the pid file is malformed", async () => {
    const pidFile = join(testDir, "daemon.pid")
    await writeFile(pidFile, "not-a-number\n", "utf-8")
    expect(await isDaemonProcess(pidFile)).toBe(false)
  })

  it("tolerates trailing whitespace in the pid file", async () => {
    const pidFile = join(testDir, "daemon.pid")
    await writeFile(pidFile, `${process.pid}\n`, "utf-8")
    expect(await isDaemonProcess(pidFile)).toBe(true)
  })
})
