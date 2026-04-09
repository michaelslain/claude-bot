import { loadAllNotes, writeNote, deleteNote, getMemoryDir } from "./graph.ts"
import type { NoteType } from "./graph.ts"
import { sendMessage } from "../daemon/session.ts"
import { parseJsonResponse } from "../lib/json.ts"
import { today } from "../lib/json.ts"

async function dispatch(prompt: string): Promise<string> {
  const response = await sendMessage(prompt)
  return response.result
}

export interface DreamConfig {
  /** Interval in milliseconds between dream cycles (default: 6 hours) */
  intervalMs: number
  /** Whether dreaming is enabled (default: true) */
  enabled: boolean
}

const DEFAULT_CONFIG: DreamConfig = {
  intervalMs: 6 * 60 * 60 * 1000, // 6 hours
  enabled: true,
}

let dreamTimer: ReturnType<typeof setInterval> | null = null
let currentConfig: DreamConfig = { ...DEFAULT_CONFIG }

const CONSOLIDATION_PROMPT = `You are a memory consolidation assistant. You are "dreaming" — reviewing a set of memory notes to improve, deduplicate, and consolidate them.

Notes with type "auto" are raw conversation snippets collected automatically. Your PRIMARY job is to process these:
- Extract useful facts, preferences, project context, or personal details from auto notes
- Merge extracted info into existing notes when relevant (e.g., a new preference goes into the existing preferences note)
- Create new properly-typed notes for genuinely new information
- Delete auto notes after extracting their value (or delete them outright if they contain nothing useful)

Given the following memory notes (in JSON format), analyze them and return a JSON object with:

1. "merge": an array of merge operations. Each merge has:
   - "delete": array of note names to remove (the duplicates/redundant ones)
   - "keep": the name of the note to keep (or a new name if creating a merged note)
   - "updatedContent": the improved/merged content for the kept note
   - "updatedTags": merged tags array
   - "updatedType": the appropriate type (one of: fact, preference, workflow, project, person, daily)

2. "improve": an array of improvement operations for notes that aren't duplicates but could be better. Each has:
   - "name": the note name
   - "updatedContent": improved content (clearer, more concise, better backlinks)
   - "updatedTags": cleaned up tags

3. "delete": an array of note names that are outdated, trivial, or no longer useful (including auto notes with no extractable value)

Memory decay: notes that are old (check the "created" and "updated" dates) AND have no [[backlinks]] to or from other notes are fading memories. If they haven't been updated recently and nothing links to them, they are candidates for deletion — unless the content is genuinely important and timeless. Prefer to delete stale, isolated notes over keeping them. Connected notes (with backlinks) survive longer because they are part of the knowledge graph.

Return ONLY valid JSON. If no changes are needed, return {"merge":[],"improve":[],"delete":[]}.

Memory notes to analyze:
`

interface MergeOp {
  delete: string[]
  keep: string
  updatedContent: string
  updatedTags: string[]
  updatedType: NoteType
}

interface ImproveOp {
  name: string
  updatedContent: string
  updatedTags: string[]
}

interface DreamResult {
  merge: MergeOp[]
  improve: ImproveOp[]
  delete: string[]
}

function parseDreamResult(response: string): DreamResult | null {
  const parsed = parseJsonResponse<DreamResult>(response, /\{[\s\S]*\}/)
  if (!parsed || typeof parsed !== "object") return null
  return {
    merge: Array.isArray(parsed.merge) ? parsed.merge : [],
    improve: Array.isArray(parsed.improve) ? parsed.improve : [],
    delete: Array.isArray(parsed.delete) ? parsed.delete : [],
  }
}

/**
 * Run one dream cycle — consolidate, deduplicate, and improve memory notes.
 * Processes notes in batches to avoid overwhelming the LLM context.
 */
export async function dream(
  dir: string = getMemoryDir()
): Promise<{ merged: number; improved: number; deleted: number }> {
  const notes = await loadAllNotes(dir)
  if (notes.length < 2) return { merged: 0, improved: 0, deleted: 0 }

  const BATCH_SIZE = 20
  let totalMerged = 0
  let totalImproved = 0
  let totalDeleted = 0

  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    const batch = notes.slice(i, i + BATCH_SIZE)
    const notesJson = JSON.stringify(
      batch.map((n) => ({
        name: n.name,
        type: n.frontmatter.type,
        tags: n.frontmatter.tags,
        created: n.frontmatter.created,
        updated: n.frontmatter.updated,
        content: n.content,
        backlinks: n.backlinks,
      })),
      null,
      2
    )

    let response: string
    try {
      response = await dispatch(CONSOLIDATION_PROMPT + `\n\nToday's date: ${today()}\n\n` + notesJson)
    } catch {
      continue
    }

    const result = parseDreamResult(response)
    if (!result) continue

    const date = today()

    for (const merge of result.merge) {
      if (!merge.keep || !merge.updatedContent) continue
      for (const name of merge.delete ?? []) {
        if (name && name !== merge.keep) {
          await deleteNote(name, dir)
          totalMerged++
        }
      }
      const existing = batch.find((n) => n.name === merge.keep)
      await writeNote(
        merge.keep,
        {
          type: merge.updatedType ?? existing?.frontmatter.type ?? "fact",
          tags: merge.updatedTags ?? existing?.frontmatter.tags ?? [],
          created: existing?.frontmatter.created ?? date,
          updated: date,
        },
        merge.updatedContent,
        dir
      )
    }

    for (const imp of result.improve) {
      if (!imp.name || !imp.updatedContent) continue
      const existing = batch.find((n) => n.name === imp.name)
      if (!existing) continue
      await writeNote(
        imp.name,
        {
          ...existing.frontmatter,
          tags: imp.updatedTags ?? existing.frontmatter.tags,
          updated: date,
        },
        imp.updatedContent,
        dir
      )
      totalImproved++
    }

    for (const name of result.delete) {
      if (name) {
        await deleteNote(name, dir)
        totalDeleted++
      }
    }
  }

  return { merged: totalMerged, improved: totalImproved, deleted: totalDeleted }
}

/**
 * Start the dreaming loop — runs consolidation on a timer.
 */
export function startDreaming(config?: Partial<DreamConfig>): void {
  stopDreaming()
  currentConfig = { ...DEFAULT_CONFIG, ...config }

  if (!currentConfig.enabled) return

  dreamTimer = setInterval(async () => {
    try {
      const result = await dream()
      if (result.merged + result.improved + result.deleted > 0) {
        console.log(
          `[dream] Consolidated memory: ${result.merged} merged, ${result.improved} improved, ${result.deleted} deleted`
        )
      }
    } catch (err) {
      console.error(`[dream] Error during consolidation: ${err}`)
    }
  }, currentConfig.intervalMs)
}

/**
 * Stop the dreaming loop.
 */
export function stopDreaming(): void {
  if (dreamTimer) {
    clearInterval(dreamTimer)
    dreamTimer = null
  }
}

/**
 * Get current dreaming configuration.
 */
export function getDreamConfig(): DreamConfig & { active: boolean } {
  return { ...currentConfig, active: dreamTimer !== null }
}

/**
 * Update dreaming configuration. Restarts the loop only if it was already running.
 */
export function updateDreamConfig(config: Partial<DreamConfig>): void {
  const wasActive = dreamTimer !== null
  currentConfig = { ...currentConfig, ...config }
  if (wasActive) {
    startDreaming(currentConfig)
  }
}
