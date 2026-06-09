// Self-update for claude-bot: git pull --ff-only + bun install + restart the daemon so the
// new code is live. Idempotent — a no-op when already at origin/main. Bismuth's "Update
// claude-bot daemon…" command drives this via bin/update.ts (one JSON line). All side
// effects (git/install/restart) are injectable so the decision logic is unit-testable.
import { spawnSync } from "child_process"
import { dirname } from "path"
import { restartDaemon } from "./platform.ts"

export type UpdateAction = "updated" | "up-to-date" | "would-update" | "no-remote"
export interface UpdateResult {
  action: UpdateAction
  from?: string
  to?: string
  restarted?: boolean
  warnings?: string[]
}
export interface UpdateStatus {
  available: boolean
  behind: number
  local: string | null
  remote: string | null
}

// lib/update.ts → repo root (two levels up).
const REPO = dirname(dirname(new URL(import.meta.url).pathname))

type GitRun = (args: string[]) => { status: number | null; stdout: string; stderr: string }
export interface UpdateDeps {
  repo?: string
  git?: GitRun
  install?: () => { ok: boolean; error?: string }
  restart?: () => { ok: boolean; error?: string }
}

function realGit(repo: string): GitRun {
  return (args) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
    return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() }
  }
}
function realInstall(repo: string): { ok: boolean; error?: string } {
  const r = spawnSync("bun", ["install"], { cwd: repo, encoding: "utf8" })
  return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr ?? "").slice(-500) }
}

/** Fetch + report whether origin/main is ahead of the local checkout. Never throws. */
export async function getUpdateStatus(deps: UpdateDeps = {}): Promise<UpdateStatus> {
  const repo = deps.repo ?? REPO
  const git = deps.git ?? realGit(repo)
  git(["fetch", "--quiet", "origin", "main"])
  const local = git(["rev-parse", "HEAD"]).stdout || null
  const rem = git(["rev-parse", "origin/main"])
  const remote = rem.status === 0 ? rem.stdout || null : null
  const behindOut = git(["rev-list", "--count", "HEAD..origin/main"])
  const behind = behindOut.status === 0 ? parseInt(behindOut.stdout || "0", 10) || 0 : 0
  return { available: behind > 0, behind, local, remote }
}

/**
 * Pull the latest claude-bot, reinstall deps, and restart the daemon. Idempotent: returns
 * "up-to-date" (no install/restart) when already at origin/main. `dryRun` reports the
 * pending action without applying. Never throws — failures surface as warnings.
 */
export async function runUpdate(opts: { dryRun?: boolean } & UpdateDeps = {}): Promise<UpdateResult> {
  const repo = opts.repo ?? REPO
  const git = opts.git ?? realGit(repo)
  const install = opts.install ?? (() => realInstall(repo))
  const restart = opts.restart ?? restartDaemon

  const from = git(["rev-parse", "HEAD"]).stdout || undefined
  git(["fetch", "--quiet", "origin", "main"])
  const rem = git(["rev-parse", "origin/main"])
  if (rem.status !== 0) return { action: "no-remote", from }
  const to = rem.stdout || undefined
  if (from && to && from === to) return { action: "up-to-date", from, to }
  if (opts.dryRun) return { action: "would-update", from, to }

  const warnings: string[] = []
  const pull = git(["pull", "--ff-only", "origin", "main"])
  if (pull.status !== 0) return { action: "up-to-date", from, to, warnings: [`git pull failed: ${pull.stderr}`] }
  const after = git(["rev-parse", "HEAD"]).stdout || to

  const inst = install()
  if (!inst.ok) warnings.push(`bun install failed: ${inst.error}`)
  const r = restart()
  if (!r.ok) warnings.push(`daemon restart failed: ${r.error}`)

  return { action: "updated", from, to: after, restarted: r.ok, warnings: warnings.length ? warnings : undefined }
}
