import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises"
import { spawn as nodeSpawn, type ChildProcess } from "child_process"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadProcessDefs,
  startProcesses,
  stopProcesses,
  stopProcess,
  startProcess,
  listProcesses,
  enableProcess,
  disableProcess,
  reapOrphans,
  requestProcessRun,
  processProcessTriggers,
} from "./process"

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return await fn()
}

const externalChildren: ChildProcess[] = []
function spawnExternal(command: string, args: string[]): ChildProcess {
  const child = nodeSpawn(command, args, { stdio: "ignore", detached: true })
  child.unref()
  externalChildren.push(child)
  return child
}

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
  // Reap any external children spawned by tests so we don't leak sleep
  // processes between test runs.
  for (const child of externalChildren) {
    if (child.pid && isAlive(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL") } catch {}
      try { process.kill(child.pid, "SIGKILL") } catch {}
    }
  }
  externalChildren.length = 0
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

    const { processes } = await listProcesses()
    const onEntry = processes.find((p) => p.name === "auto-on")
    const offEntry = processes.find((p) => p.name === "auto-off")

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
    const firstPid = (await listProcesses()).processes.find((p) => p.name === "steady")?.pid

    await startProcesses(testDir)
    const secondPid = (await listProcesses()).processes.find((p) => p.name === "steady")?.pid

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

    const entry = (await listProcesses()).processes.find((p) => p.name === "dormant")
    expect(entry?.enabled).toBe(true)
    expect(entry?.running).toBe(false) // enable does NOT spawn
  })

  it("makes process_start work after enabling", async () => {
    await writeProcessDef("dormant", { name: "dormant", command: "sleep", args: "60", enabled: "false", restart: "never" })

    await enableProcess("dormant", testDir)
    const startResult = startProcess("dormant")
    expect(startResult.ok).toBe(true)

    // startProcess kicks off spawn asynchronously; wait for it to register a pid.
    await waitUntil(async () => {
      const e = (await listProcesses()).processes.find((p) => p.name === "dormant")
      return !!e?.running
    })
    const entry = (await listProcesses()).processes.find((p) => p.name === "dormant")
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
    const beforePid = (await listProcesses()).processes.find((p) => p.name === "running-one")?.pid
    expect(beforePid).toBeGreaterThan(0)

    await disableProcess("running-one", testDir)

    // disableProcess now awaits stopProcess, which polls until the OS pid is
    // gone — no extra sleep needed.
    expect(isAlive(beforePid!)).toBe(false)

    const entry = (await listProcesses()).processes.find((p) => p.name === "running-one")
    expect(entry).toBeDefined() // still registered
    expect(entry?.enabled).toBe(false)
    expect(entry?.running).toBe(false) // mp.proc cleared by stopProcess

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
    expect((await listProcesses()).processes.find((p) => p.name === "toggled")?.running).toBe(true)

    // Disable while running
    await disableProcess("toggled", testDir)

    // Simulate daemon restart: clear in-memory state, then re-boot from same dir
    await stopProcesses(2000)
    expect((await listProcesses()).processes).toEqual([])

    await startProcesses(testDir)

    // After restart: registered (in `managed`) but NOT auto-spawned
    const entry = (await listProcesses()).processes.find((p) => p.name === "toggled")
    expect(entry).toBeDefined()
    expect(entry?.enabled).toBe(false)
    expect(entry?.running).toBe(false)

    // Runtime process_start still works on the disabled entry
    const startResult = startProcess("toggled")
    expect(startResult.ok).toBe(true)
    await waitUntil(async () => {
      const e = (await listProcesses()).processes.find((p) => p.name === "toggled")
      return !!e?.running
    })
    expect((await listProcesses()).processes.find((p) => p.name === "toggled")?.running).toBe(true)
  })
})

describe("stopProcess (kernel-confirmed exit)", () => {
  it("returns only after the OS pid is confirmed gone", async () => {
    await writeProcessDef("stopme", { name: "stopme", command: "sleep", args: "60", enabled: "true", restart: "never" })

    await startProcesses(testDir)
    const pid = (await listProcesses()).processes.find((p) => p.name === "stopme")?.pid
    expect(pid).toBeGreaterThan(0)

    const result = await stopProcess("stopme")
    expect(result.ok).toBe(true)

    // Kernel must already report the pid as gone the instant stopProcess
    // returns — no extra polling. If this flakes the SIGKILL escalation is
    // broken.
    expect(isAlive(pid!)).toBe(false)

    const entry = (await listProcesses()).processes.find((p) => p.name === "stopme")
    expect(entry?.running).toBe(false) // mp.proc cleared
    expect(entry?.pid).toBeNull()
  })
})

describe("orphan handling", () => {
  it("spawnProcess reaps a stale-pid-file orphan before forking", async () => {
    // Spawn an external sleep process to stand in for an orphan from a
    // previous daemon. Plant its pid in the pid file as if the supervisor had
    // tracked it.
    const orphan = spawnExternal("sleep", ["120"])
    expect(orphan.pid).toBeGreaterThan(0)

    await mkdir(join(testDir, ".pids"), { recursive: true })
    await writeFile(join(testDir, ".pids", "ghosted.pid"), String(orphan.pid))

    await writeProcessDef("ghosted", { name: "ghosted", command: "sleep", args: "60", enabled: "true", restart: "never" })

    await startProcesses(testDir)

    // The orphan must be dead — spawnProcess reaped it before forking.
    expect(await waitUntil(() => !isAlive(orphan.pid!), 3000)).toBe(true)

    // Exactly one supervised child is running.
    const list = await listProcesses()
    const entry = list.processes.find((p) => p.name === "ghosted")
    expect(entry?.running).toBe(true)
    expect(entry?.pid).not.toBe(orphan.pid)
  })

  it("reapOrphans (daemon-boot pass) kills argv-matching processes", async () => {
    await writeProcessDef("argv-orphan", { name: "argv-orphan", command: "sleep", args: "120", enabled: "true", restart: "never" })

    // Simulate a process left behind by a previous daemon — no pid file, but
    // argv matches the def.
    const orphan = spawnExternal("sleep", ["120"])
    expect(orphan.pid).toBeGreaterThan(0)
    expect(isAlive(orphan.pid!)).toBe(true)

    await reapOrphans(testDir)

    expect(await waitUntil(() => !isAlive(orphan.pid!), 3000)).toBe(true)
  })

  it("simulated daemon restart leaves no orphan after reap + start", async () => {
    await writeProcessDef("reboot-me", { name: "reboot-me", command: "sleep", args: "120", enabled: "true", restart: "never" })

    await startProcesses(testDir)
    const firstPid = (await listProcesses()).processes.find((p) => p.name === "reboot-me")?.pid
    expect(firstPid).toBeGreaterThan(0)

    // Simulate a hard daemon death: clear in-memory state WITHOUT killing the
    // child. The child becomes an orphan reparented to PID 1, exactly like
    // what happens when launchctl SIGKILLs the daemon.
    //
    // We can't `managed.clear()` from outside; instead we mark stopping=false
    // on every entry and use stopProcesses but skip the kill — there's no
    // exposed API for "forget without killing". So we approximate: write the
    // pid file (if not already), then have stopProcesses kill — then we
    // re-spawn the child by hand to play the role of the orphan that
    // survived a hard daemon kill.
    await stopProcesses(2000)
    const orphan = spawnExternal("sleep", ["120"])
    await mkdir(join(testDir, ".pids"), { recursive: true })
    await writeFile(join(testDir, ".pids", "reboot-me.pid"), String(orphan.pid))

    // New daemon boot: reap then start.
    await reapOrphans(testDir)
    await startProcesses(testDir)

    expect(await waitUntil(() => !isAlive(orphan.pid!), 3000)).toBe(true)

    const list = await listProcesses()
    const entry = list.processes.find((p) => p.name === "reboot-me")
    expect(entry?.running).toBe(true)
    expect(entry?.pid).not.toBe(orphan.pid)
    // No unmanaged orphans surfaced — the only running process matching the
    // def's argv is the supervised one.
    expect(list.orphans).toEqual([])
  })

  it("listProcesses surfaces unmanaged_orphan when an external process matches", async () => {
    await writeProcessDef("watched", { name: "watched", command: "sleep", args: "300", enabled: "true", restart: "never" })

    await startProcesses(testDir)
    const supervisedPid = (await listProcesses()).processes.find((p) => p.name === "watched")?.pid
    expect(supervisedPid).toBeGreaterThan(0)

    // Spawn a second process with the same argv — outside the supervisor.
    // listProcesses must surface it as an orphan.
    const rogue = spawnExternal("sleep", ["300"])
    expect(rogue.pid).toBeGreaterThan(0)

    const list = await listProcesses()
    expect(list.orphans.some((o) => o.name === "watched" && o.pid === rogue.pid)).toBe(true)
    // The supervised child still appears as a normal entry.
    expect(list.processes.find((p) => p.name === "watched")?.running).toBe(true)
  })
})

// ── Process trigger port ──────────────────────────────────────────────────────
// Mirror of the cron trigger port: an external program flips a process's
// frontmatter and drops a trigger file (named by FILE BASENAME); the daemon
// reconciles that process's runtime to match disk, then deletes the trigger.

const TRIGGERS_SUBDIR = ".triggers"

async function dropTrigger(name: string): Promise<void> {
  await mkdir(join(testDir, TRIGGERS_SUBDIR), { recursive: true })
  await writeFile(join(testDir, TRIGGERS_SUBDIR, name), new Date().toISOString(), "utf-8")
}

function triggerExists(name: string): Promise<boolean> {
  return Bun.file(join(testDir, TRIGGERS_SUBDIR, name)).exists()
}

// Mark testDir (used as the owner `home` here) as owned by another device so
// isOwner(testDir) === false. Mirrors how owner.test.ts fakes non-ownership.
async function makeNonOwner(): Promise<void> {
  await writeFile(
    join(testDir, "owner.json"),
    JSON.stringify({ ownerDeviceId: "some-other-device", ownerLabel: "other-box", updatedAt: new Date().toISOString() }),
    "utf-8",
  )
}

describe("processProcessTriggers (reconcile runtime ↔ disk)", () => {
  it("stops a running process when its disk frontmatter is now enabled: false", async () => {
    await writeProcessDef("stoppable", { name: "stoppable", command: "sleep", args: "60", enabled: "true", restart: "never" })
    await startProcesses(testDir)
    const pid = (await listProcesses()).processes.find((p) => p.name === "stoppable")?.pid
    expect(pid).toBeGreaterThan(0)

    // External tool flips frontmatter to disabled, then drops the trigger.
    await writeProcessDef("stoppable", { name: "stoppable", command: "sleep", args: "60", enabled: "false", restart: "never" })
    await dropTrigger("stoppable")

    await processProcessTriggers(testDir, testDir)

    expect(isAlive(pid!)).toBe(false)
    expect((await listProcesses()).processes.find((p) => p.name === "stoppable")?.running).toBe(false)
    expect(await triggerExists("stoppable")).toBe(false)
  })

  it("starts a disabled-on-disk process flipped to enabled: true", async () => {
    // Registered but not running (never started). Disk starts disabled, then
    // the external tool flips it to enabled and drops the trigger.
    await writeProcessDef("startable", { name: "startable", command: "sleep", args: "60", enabled: "false", restart: "never" })
    await startProcesses(testDir) // registers it, does not spawn (disabled)
    expect((await listProcesses()).processes.find((p) => p.name === "startable")?.running).toBe(false)

    await writeProcessDef("startable", { name: "startable", command: "sleep", args: "60", enabled: "true", restart: "never" })
    await dropTrigger("startable")

    await processProcessTriggers(testDir, testDir)

    expect(await waitUntil(async () => {
      const e = (await listProcesses()).processes.find((p) => p.name === "startable")
      return !!e?.running
    })).toBe(true)
    expect(await triggerExists("startable")).toBe(false)
  })

  it("is a no-op when disk state already matches runtime", async () => {
    await writeProcessDef("matched", { name: "matched", command: "sleep", args: "60", enabled: "true", restart: "never" })
    await startProcesses(testDir)
    const pid = (await listProcesses()).processes.find((p) => p.name === "matched")?.pid
    expect(pid).toBeGreaterThan(0)

    // Trigger with no disk change: still enabled, still running → no-op.
    await dropTrigger("matched")
    await processProcessTriggers(testDir, testDir)

    expect(isAlive(pid!)).toBe(true) // untouched
    expect((await listProcesses()).processes.find((p) => p.name === "matched")?.pid).toBe(pid!)
    expect(await triggerExists("matched")).toBe(false) // consumed
  })

  it("non-owner device consumes triggers without starting/stopping", async () => {
    await writeProcessDef("guarded", { name: "guarded", command: "sleep", args: "60", enabled: "true", restart: "never" })
    await startProcesses(testDir)
    const pid = (await listProcesses()).processes.find((p) => p.name === "guarded")?.pid
    expect(pid).toBeGreaterThan(0)

    // Disk says disabled, but this device is not the owner — must NOT act.
    await writeProcessDef("guarded", { name: "guarded", command: "sleep", args: "60", enabled: "false", restart: "never" })
    await makeNonOwner()
    await dropTrigger("guarded")

    await processProcessTriggers(testDir, testDir)

    expect(isAlive(pid!)).toBe(true) // still running — gate held
    expect(await triggerExists("guarded")).toBe(false) // but trigger consumed
  })

  it("consumes a trigger naming a non-existent def without throwing", async () => {
    await dropTrigger("ghost-process")
    await processProcessTriggers(testDir, testDir) // must not throw
    expect(await triggerExists("ghost-process")).toBe(false)
  })
})

describe("requestProcessRun", () => {
  it("writes a trigger file named by the basename for an existing process", async () => {
    await writeProcessDef("requestable", { name: "requestable", command: "sleep", args: "60", enabled: "true", restart: "never" })

    const result = await requestProcessRun("requestable", testDir)
    expect(result.ok).toBe(true)
    expect(await triggerExists("requestable")).toBe(true)
  })

  it("returns ok: false for a missing process", async () => {
    const result = await requestProcessRun("nonexistent", testDir)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("nonexistent")
    expect(await triggerExists("nonexistent")).toBe(false)
  })
})
