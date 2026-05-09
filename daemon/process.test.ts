import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadProcessDefs,
  startProcesses,
  stopProcesses,
  startProcess,
  listProcesses,
  enableProcess,
  disableProcess,
} from "./process"

let testDir: string

async function writeProcessDef(name: string, frontmatter: Record<string, string>, body = ""): Promise<void> {
  const lines = ["---"]
  for (const [key, value] of Object.entries(frontmatter)) lines.push(`${key}: ${value}`)
  lines.push("---")
  lines.push("")
  if (body) lines.push(body)
  await writeFile(join(testDir, `${name}.md`), lines.join("\n") + "\n", "utf-8")
}

async function readDefFile(name: string): Promise<string> {
  return await readFile(join(testDir, `${name}.md`), "utf-8")
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "claude-bot-process-test-"))
  // Ensure logs dir exists since spawnProcess opens log files unconditionally
  await mkdir(join(testDir, "logs"), { recursive: true }).catch(() => {})
})

afterEach(async () => {
  await stopProcesses(2000)
  await rm(testDir, { recursive: true, force: true })
})

describe("loadProcessDefs", () => {
  it("returns disabled defs (no longer filters them out)", async () => {
    await writeProcessDef("enabled-one", { name: "enabled-one", command: "echo", enabled: "true" })
    await writeProcessDef("disabled-one", { name: "disabled-one", command: "echo", enabled: "false" })

    const defs = await loadProcessDefs(testDir)
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(["disabled-one", "enabled-one"])

    const disabled = defs.find((d) => d.name === "disabled-one")
    expect(disabled?.enabled).toBe(false)
  })

  it("treats missing enabled field as enabled (default true)", async () => {
    await writeProcessDef("no-flag", { name: "no-flag", command: "echo" })
    const defs = await loadProcessDefs(testDir)
    expect(defs[0]?.enabled).toBe(true)
  })

  it("skips files missing required command field", async () => {
    await writeProcessDef("bad", { name: "bad" })
    const defs = await loadProcessDefs(testDir)
    expect(defs).toEqual([])
  })
})

describe("startProcesses (boot path)", () => {
  it("registers all defs but only auto-spawns enabled ones", async () => {
    // sleep 60 — long-lived but cheap; afterEach kills it via stopProcesses
    await writeProcessDef("auto-on", { name: "auto-on", command: "sleep", args: "60", enabled: "true", restart: "never" })
    await writeProcessDef("auto-off", { name: "auto-off", command: "sleep", args: "60", enabled: "false", restart: "never" })

    await startProcesses(testDir)

    const list = listProcesses()
    const onEntry = list.find((p) => p.name === "auto-on")
    const offEntry = list.find((p) => p.name === "auto-off")

    expect(onEntry).toBeDefined()
    expect(onEntry?.enabled).toBe(true)
    expect(onEntry?.running).toBe(true)

    expect(offEntry).toBeDefined()
    expect(offEntry?.enabled).toBe(false)
    expect(offEntry?.running).toBe(false)
  })

  it("re-running startProcesses does not respawn already-running enabled processes", async () => {
    await writeProcessDef("steady", { name: "steady", command: "sleep", args: "60", enabled: "true", restart: "never" })
    await startProcesses(testDir)
    const firstPid = listProcesses().find((p) => p.name === "steady")?.pid

    await startProcesses(testDir)
    const secondPid = listProcesses().find((p) => p.name === "steady")?.pid

    expect(firstPid).toBeDefined()
    expect(secondPid).toBe(firstPid!)
  })
})

describe("enableProcess", () => {
  it("flips enabled: false → true on disk and registers without spawning", async () => {
    await writeProcessDef("dormant", { name: "dormant", command: "sleep", args: "60", enabled: "false", restart: "never" })

    const result = await enableProcess("dormant", testDir)
    expect(result.ok).toBe(true)

    const onDisk = await readDefFile("dormant")
    expect(onDisk).toContain("enabled: true")
    expect(onDisk).not.toContain("enabled: false")

    const entry = listProcesses().find((p) => p.name === "dormant")
    expect(entry?.enabled).toBe(true)
    expect(entry?.running).toBe(false) // enable does NOT spawn
  })

  it("makes process_start work after enabling", async () => {
    await writeProcessDef("dormant", { name: "dormant", command: "sleep", args: "60", enabled: "false", restart: "never" })

    await enableProcess("dormant", testDir)
    const startResult = startProcess("dormant")
    expect(startResult.ok).toBe(true)

    const entry = listProcesses().find((p) => p.name === "dormant")
    expect(entry?.running).toBe(true)
  })

  it("is idempotent on already-enabled process", async () => {
    await writeProcessDef("on", { name: "on", command: "sleep", args: "60", enabled: "true", restart: "never" })

    const r1 = await enableProcess("on", testDir)
    const r2 = await enableProcess("on", testDir)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    const onDisk = await readDefFile("on")
    expect(onDisk).toContain("enabled: true")
  })

  it("returns error when no .md file exists", async () => {
    const result = await enableProcess("nonexistent", testDir)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("nonexistent")
  })

  it("preserves body and other frontmatter fields when flipping", async () => {
    await writeProcessDef(
      "rich",
      {
        name: "rich",
        command: "sleep",
        args: "60",
        cwd: "/tmp",
        restart: "always",
        enabled: "false",
      },
      "Some body content here.\nMultiple lines.",
    )

    await enableProcess("rich", testDir)
    const onDisk = await readDefFile("rich")

    expect(onDisk).toContain("command: sleep")
    expect(onDisk).toContain("args: 60")
    expect(onDisk).toContain("cwd: /tmp")
    expect(onDisk).toContain("restart: always")
    expect(onDisk).toContain("enabled: true")
    expect(onDisk).toContain("Some body content here.")
    expect(onDisk).toContain("Multiple lines.")
  })
})

describe("disableProcess", () => {
  it("flips enabled: true → false on disk", async () => {
    await writeProcessDef("on", { name: "on", command: "sleep", args: "60", enabled: "true", restart: "never" })

    const result = await disableProcess("on", testDir)
    expect(result.ok).toBe(true)

    const onDisk = await readDefFile("on")
    expect(onDisk).toContain("enabled: false")
  })

  it("stops a running process and flips the flag, keeps it registered", async () => {
    await writeProcessDef("running-one", { name: "running-one", command: "sleep", args: "60", enabled: "true", restart: "never" })

    await startProcesses(testDir)
    const beforePid = listProcesses().find((p) => p.name === "running-one")?.pid
    expect(beforePid).toBeGreaterThan(0)

    await disableProcess("running-one", testDir)

    // Give SIGTERM time to land
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Verify the OS-level child was killed. Note: mp.proc isn't cleared here
    // (existing design — stopProcesses polls it for SIGKILL escalation), so we
    // check the kernel directly rather than listProcesses().running.
    let alive = true
    try { process.kill(beforePid!, 0) } catch { alive = false }
    expect(alive).toBe(false)

    const entry = listProcesses().find((p) => p.name === "running-one")
    expect(entry).toBeDefined() // still registered
    expect(entry?.enabled).toBe(false)

    const onDisk = await readDefFile("running-one")
    expect(onDisk).toContain("enabled: false")
  })

  it("is idempotent on already-disabled process", async () => {
    await writeProcessDef("off", { name: "off", command: "sleep", args: "60", enabled: "false", restart: "never" })

    const r1 = await disableProcess("off", testDir)
    const r2 = await disableProcess("off", testDir)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    const onDisk = await readDefFile("off")
    expect(onDisk).toContain("enabled: false")
  })

  it("returns error when no .md file exists", async () => {
    const result = await disableProcess("ghost", testDir)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("ghost")
  })
})

describe("disable persists across daemon restart", () => {
  it("disabled process does not auto-start, but process_start still works", async () => {
    await writeProcessDef("toggled", { name: "toggled", command: "sleep", args: "60", enabled: "true", restart: "never" })

    // Boot 1: starts running
    await startProcesses(testDir)
    expect(listProcesses().find((p) => p.name === "toggled")?.running).toBe(true)

    // Disable while running
    await disableProcess("toggled", testDir)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Simulate daemon restart: clear in-memory state, then re-boot from same dir
    await stopProcesses(2000)
    expect(listProcesses()).toEqual([])

    await startProcesses(testDir)

    // After restart: registered (in `managed`) but NOT auto-spawned
    const entry = listProcesses().find((p) => p.name === "toggled")
    expect(entry).toBeDefined()
    expect(entry?.enabled).toBe(false)
    expect(entry?.running).toBe(false)

    // Runtime process_start still works on the disabled entry
    const startResult = startProcess("toggled")
    expect(startResult.ok).toBe(true)
    expect(listProcesses().find((p) => p.name === "toggled")?.running).toBe(true)
  })
})
