import { test, expect } from "bun:test"
import { runUpdate, getUpdateStatus, type UpdateDeps } from "./update.ts"

// Fake git: maps a subcommand key → {status, stdout}. rev-parse is keyed by its target.
function fakeGit(map: Record<string, { status?: number; stdout?: string }>): NonNullable<UpdateDeps["git"]> {
  return (args) => {
    const key = args[0] === "rev-parse" ? `rev-parse ${args[1]}` : args[0]
    const r = map[key] ?? { status: 0, stdout: "" }
    return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: "" }
  }
}

test("runUpdate is a no-op when already up to date", async () => {
  let installed = false
  let restarted = false
  const r = await runUpdate({
    git: fakeGit({ "rev-parse HEAD": { stdout: "abc" }, "rev-parse origin/main": { stdout: "abc" } }),
    install: () => { installed = true; return { ok: true } },
    restart: () => { restarted = true; return { ok: true } },
  })
  expect(r.action).toBe("up-to-date")
  expect(installed).toBe(false)
  expect(restarted).toBe(false)
})

test("runUpdate pulls, installs, then restarts when behind", async () => {
  const calls: string[] = []
  let head = "old"
  const git: NonNullable<UpdateDeps["git"]> = (args) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { status: 0, stdout: head, stderr: "" }
    if (args[0] === "rev-parse" && args[1] === "origin/main") return { status: 0, stdout: "new", stderr: "" }
    if (args[0] === "pull") { calls.push("pull"); head = "new"; return { status: 0, stdout: "", stderr: "" } }
    return { status: 0, stdout: "", stderr: "" }
  }
  const r = await runUpdate({
    git,
    install: () => { calls.push("install"); return { ok: true } },
    restart: () => { calls.push("restart"); return { ok: true } },
  })
  expect(r.action).toBe("updated")
  expect(r.to).toBe("new")
  expect(r.restarted).toBe(true)
  expect(calls).toEqual(["pull", "install", "restart"])
})

test("runUpdate dry-run reports would-update with no side effects", async () => {
  let touched = false
  const r = await runUpdate({
    dryRun: true,
    git: fakeGit({ "rev-parse HEAD": { stdout: "old" }, "rev-parse origin/main": { stdout: "new" } }),
    install: () => { touched = true; return { ok: true } },
    restart: () => { touched = true; return { ok: true } },
  })
  expect(r.action).toBe("would-update")
  expect(touched).toBe(false)
})

test("runUpdate surfaces a missing remote", async () => {
  const r = await runUpdate({
    git: fakeGit({ "rev-parse HEAD": { stdout: "old" }, "rev-parse origin/main": { status: 1 } }),
  })
  expect(r.action).toBe("no-remote")
})

test("getUpdateStatus reports the behind count", async () => {
  const s = await getUpdateStatus({
    git: fakeGit({
      "rev-parse HEAD": { stdout: "old" },
      "rev-parse origin/main": { stdout: "new" },
      "rev-list": { stdout: "2" },
    }),
  })
  expect(s).toMatchObject({ available: true, behind: 2, local: "old", remote: "new" })
})
