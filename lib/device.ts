import { randomUUID } from "crypto"
import { hostname } from "os"
import { join } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"
import { BOT_DIR } from "./config.ts"

/**
 * Stable per-machine device identity. The device-id file holds a UUID that is
 * generated and persisted on first read, then reused across restarts.
 *
 * All functions accept an optional `home` directory so tests can point at a
 * temp dir instead of the real ~/.claude-bot. Production callers omit it and
 * get BOT_DIR from lib/config.ts.
 */

function deviceIdPath(home: string): string {
  return join(home, "device-id")
}

/**
 * Read the persisted device UUID, generating + persisting one on first call.
 * The write is best-effort atomic (tmp + rename) so a crash mid-write can't
 * leave a half-written id file.
 */
export async function getDeviceId(home: string = BOT_DIR): Promise<string> {
  const path = deviceIdPath(home)
  try {
    const existing = (await readFile(path, "utf-8")).trim()
    if (existing) return existing
  } catch {
    // not yet generated — fall through to create
  }

  const id = randomUUID()
  await mkdir(home, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, id, "utf-8")
  const { rename } = await import("fs/promises")
  await rename(tmp, path)
  return id
}

/** Human-readable device label. Per CONTRACT v1 this is os.hostname(). */
export function getDeviceLabel(): string {
  return hostname()
}
