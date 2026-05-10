#!/usr/bin/env bun
import { listNotes, readNote, deleteNote, getMemoryDir } from "../memory/graph.ts"

const CRON_PREFIX = "[Cron: "

export interface CleanupResult {
  forgot: number
  kept: number
}

/**
 * Scan the root of `dir` (no subfolders) for `auto-*` notes and delete those
 * whose body contains a `[Cron: ` marker — leftovers from when the SessionEnd
 * collect-hook captured cron-spawned sessions.
 */
export async function forgetCronAutoNotes(
  dir: string = getMemoryDir()
): Promise<CleanupResult> {
  let forgot = 0
  let kept = 0
  const names = await listNotes(dir)
  for (const name of names) {
    if (name.includes("/")) continue
    if (!name.startsWith("auto-")) continue
    const note = await readNote(name, dir)
    if (!note) continue
    if (note.content.includes(CRON_PREFIX)) {
      const ok = await deleteNote(name, dir)
      if (ok) forgot++
    } else {
      kept++
    }
  }
  return { forgot, kept }
}

if (import.meta.main) {
  const result = await forgetCronAutoNotes()
  console.log(
    `forgot ${result.forgot} cron auto-notes, kept ${result.kept} interactive auto-notes`
  )
}
