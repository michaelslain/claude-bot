#!/usr/bin/env bun
// Assemble a RELOCATABLE, self-contained bundle of claude-bot at dist/claude-bot/
// (SHARED BUNDLING CONTRACT v3).
//
// claude-bot is a Bun/TS daemon — its launchd plist runs "bun run daemon/index.ts",
// so it CANNOT be a single compiled binary: the daemon needs on-disk SOURCE plus a
// runtime node_modules. This script copies everything the daemon, the MCP server,
// and ensure-installed need to run from an ARBITRARY path, then ships a runtime
// node_modules carrying the production deps.
//
// After assembling it VERIFIES the bundle (the bundle's own smoke test):
//   1. "bun run dist/claude-bot/bin/ensure-installed.ts --status" prints valid JSON
//      (read-only — getInstallStatus() never mutates anything)
//   2. dist/claude-bot/node_modules/@anthropic-ai/claude-agent-sdk exists
//
// dist/ is gitignored — never commit the heavy artifact.
import { rm, mkdir, cp } from "fs/promises"
import { existsSync } from "fs"
import { join, relative } from "path"
import { spawnSync } from "child_process"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "dist", "claude-bot")

// Source dirs the runtime needs. memory/ is required because server.ts imports
// ./memory/{graph,query,dream}.ts; lib/daemon/bin power the daemon + installer;
// defaults/ + skills/ are seed assets the daemon reads on first boot.
const DIRS = ["lib", "daemon", "bin", "memory", "defaults", "skills"]
// Top-level files: the MCP server entry and the manifest that declares deps + bin.
const FILES = ["server.ts", "package.json"]

function duKB(path: string): number {
  const out = spawnSync("du", ["-sk", path], { encoding: "utf-8" }).stdout ?? ""
  return parseInt(out.trim().split(/\s+/)[0] ?? "0", 10) || 0
}

function fmtKB(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}M`
  return `${kb}K`
}

async function main() {
  console.log("→ assembling relocatable bundle at dist/claude-bot/\n")

  // Fresh output tree.
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const manifest: { item: string; detail: string }[] = []

  // Copy source dirs.
  for (const dir of DIRS) {
    const src = join(ROOT, dir)
    if (!existsSync(src)) throw new Error(`missing source dir: ${dir}`)
    await cp(src, join(OUT, dir), { recursive: true })
  }

  // Copy top-level files.
  for (const file of FILES) {
    const src = join(ROOT, file)
    if (!existsSync(src)) throw new Error(`missing source file: ${file}`)
    await cp(src, join(OUT, file))
  }

  // Strip test files from the copied source (lean production bundle). node_modules
  // is not copied yet, so this only matches our own *.test.ts.
  let stripped = 0
  for (const path of new Bun.Glob("**/*.test.ts").scanSync(OUT)) {
    await rm(join(OUT, path))
    stripped++
  }

  for (const dir of DIRS) manifest.push({ item: `${dir}/`, detail: fmtKB(duKB(join(OUT, dir))) })
  for (const file of FILES) manifest.push({ item: file, detail: fmtKB(duKB(join(OUT, file))) })

  // Runtime node_modules — copy the repo's production deps. cp -R preserves the
  // relative .bin symlinks, keeping the tree relocatable. The daemon imports
  // @anthropic-ai/claude-agent-sdk; the MCP server imports @modelcontextprotocol/sdk.
  const nmSrc = join(ROOT, "node_modules")
  if (!existsSync(nmSrc)) throw new Error("missing node_modules — run `bun install` first")
  const cpRes = spawnSync("cp", ["-R", nmSrc, join(OUT, "node_modules")], { encoding: "utf-8" })
  if (cpRes.status !== 0) throw new Error(`copying node_modules failed: ${cpRes.stderr ?? ""}`)
  manifest.push({ item: "node_modules/", detail: fmtKB(duKB(join(OUT, "node_modules"))) })

  // ── Manifest ────────────────────────────────────────────────────────────────
  console.log("bundled:")
  for (const { item, detail } of manifest) console.log(`  ${item.padEnd(16)} ${detail}`)
  console.log(`  ${"(test files)".padEnd(16)} ${stripped} stripped`)
  console.log(`\n  total: ${fmtKB(duKB(OUT))} at ${relative(ROOT, OUT)}/\n`)

  // ── Verify (smoke test) ───────────────────────────────────────────────────────
  console.log("→ verifying bundle\n")
  let ok = true

  // 1. ensure-installed --status prints valid JSON (read-only).
  const statusRes = spawnSync("bun", ["run", join(OUT, "bin", "ensure-installed.ts"), "--status"], { encoding: "utf-8" })
  const statusOut = (statusRes.stdout ?? "").trim()
  let parsedOk = false
  try {
    const parsed = JSON.parse(statusOut)
    parsedOk = parsed && typeof parsed === "object" && typeof parsed.daemonLabel === "string"
  } catch {
    parsedOk = false
  }
  console.log(`  [${parsedOk ? "ok" : "FAIL"}] ensure-installed --status -> ${statusOut || statusRes.stderr || "(no output)"}`)
  if (!parsedOk) ok = false

  // 2. The daemon SDK is bundled.
  const sdkDir = join(OUT, "node_modules", "@anthropic-ai", "claude-agent-sdk")
  const sdkExists = existsSync(sdkDir)
  console.log(`  [${sdkExists ? "ok" : "FAIL"}] daemon SDK bundled -> node_modules/@anthropic-ai/claude-agent-sdk ${sdkExists ? "exists" : "MISSING"}`)
  if (!sdkExists) ok = false

  console.log(ok ? "\n✓ bundle ready" : "\n✗ bundle verification failed")
  if (!ok) process.exit(1)
}

await main()
