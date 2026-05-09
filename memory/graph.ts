import { join, resolve } from "path";
import { mkdir as fsMkdir, unlink } from "fs/promises";
import { MEMORY_DIR } from "../lib/config.ts"

export function getMemoryDir(): string {
  return MEMORY_DIR;
}

export type NoteType = "person" | "project" | "workflow" | "fact" | "preference" | "daily" | "auto";

export interface NoteFrontmatter {
  type: NoteType;
  tags: string[];
  created: string;
  updated: string;
}

export interface MemoryNote {
  /** Folder-prefixed (`folder/name`) for non-root notes, bare name for root notes */
  name: string;
  frontmatter: NoteFrontmatter;
  content: string;
  /** Names of notes linked via [[backlinks]] in the content (folder-agnostic) */
  backlinks: string[];
}

const ensuredDirs = new Set<string>();
async function ensureDir(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await fsMkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

// Prevent directory traversal attacks
function sanitizeSegment(segment: string): string {
  return segment
    .replace(/[\/\\]/g, "-")
    .replace(/\.\./g, "")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")
    .replace(/-+/g, "-")
    .trim();
}

function sanitizeName(name: string): string {
  return sanitizeSegment(name);
}

/**
 * Sanitize a folder name. Same rules as sanitizeName — single segment, no
 * traversal. Returns "" for missing or fully sanitized-away input.
 */
export function sanitizeFolder(folder?: string): string {
  if (!folder) return "";
  return sanitizeSegment(folder);
}

/**
 * Split a folder-prefixed reference like "moltbook/foo" into its parts.
 * Bare names like "foo" return `{ name: "foo" }`. The .md extension is stripped.
 */
export function parseNoteRef(ref: string): { folder?: string; name: string } {
  const base = ref.replace(/\.md$/, "");
  const slashIdx = base.indexOf("/");
  if (slashIdx === -1) return { name: base };
  const folder = base.slice(0, slashIdx);
  const name = base.slice(slashIdx + 1);
  if (!folder) return { name };
  return { folder, name };
}

function notePath(dir: string, name: string, folder?: string): string {
  const safeName = sanitizeName(name);
  if (!safeName) throw new Error("Invalid note name");
  const fileName = safeName.endsWith(".md") ? safeName : `${safeName}.md`;

  let full: string;
  if (folder) {
    const safeFolder = sanitizeFolder(folder);
    if (!safeFolder) throw new Error("Invalid folder name");
    full = join(dir, safeFolder, fileName);
  } else {
    full = join(dir, fileName);
  }
  // Final check: resolved path must be inside the directory
  if (!resolve(full).startsWith(resolve(dir))) throw new Error("Invalid note name");
  return full;
}

function extractBacklinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  const backlinks: string[] = [];
  for (const match of matches) {
    const linked = match[1]?.trim();
    if (linked) backlinks.push(linked);
  }
  return [...new Set(backlinks)];
}

function parseFrontmatterValue(value: string): string | string[] {
  const trimmed = value.trim();
  // Array syntax: [a, b, c]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (inner.trim() === "") return [];
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return trimmed;
}

function parseFrontmatter(raw: string): NoteFrontmatter {
  const lines = raw.split("\n");
  const data: Record<string, string | string[]> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      data[key] = parseFrontmatterValue(value);
    }
  }

  return {
    type: (data["type"] as NoteType) ?? "fact",
    tags: Array.isArray(data["tags"])
      ? data["tags"]
      : data["tags"]
      ? [data["tags"] as string]
      : [],
    created: (data["created"] as string) ?? new Date().toISOString().slice(0, 10),
    updated: (data["updated"] as string) ?? new Date().toISOString().slice(0, 10),
  };
}

function serializeFrontmatter(fm: NoteFrontmatter): string {
  const tagsStr = fm.tags.length > 0 ? `[${fm.tags.join(", ")}]` : "[]";
  return `---\ntype: ${fm.type}\ntags: ${tagsStr}\ncreated: ${fm.created}\nupdated: ${fm.updated}\n---`;
}

function parseNoteFile(name: string, raw: string): MemoryNote {
  // Split on --- delimiters
  const parts = raw.split(/^---\s*$/m);
  // Typical structure: ["", frontmatter, content]
  let frontmatter: NoteFrontmatter;
  let content: string;

  if (parts.length >= 3 && parts[0] !== undefined && parts[0].trim() === "") {
    frontmatter = parseFrontmatter(parts[1] ?? "");
    content = parts.slice(2).join("---").trim();
  } else {
    // No frontmatter block found
    frontmatter = {
      type: "fact",
      tags: [],
      created: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
    };
    content = raw.trim();
  }

  return {
    name,
    frontmatter,
    content,
    backlinks: extractBacklinks(content),
  };
}

/**
 * If `folder` is supplied, treat `name` as a bare name within that folder.
 * Otherwise, allow `name` to be folder-prefixed (e.g. "moltbook/foo").
 * If the inferred folder portion is unsafe (e.g. "../foo"), fall back to
 * treating the whole input as a flat name — sanitizeName will clean it.
 */
function resolveRef(name: string, folder?: string): { folder?: string; name: string } {
  if (folder !== undefined) return { folder: folder || undefined, name };
  const parsed = parseNoteRef(name);
  if (parsed.folder && !sanitizeFolder(parsed.folder)) return { name };
  return parsed;
}

/**
 * List note references in the memory directory.
 *
 * - When `folder` is given: scans only that folder, returns folder-prefixed
 *   names (e.g. `moltbook/foo`).
 * - When omitted: scans recursively (single level only), returns
 *   folder-prefixed names for non-root notes and bare names for root notes.
 */
export async function listNotes(
  dir: string = getMemoryDir(),
  folder?: string
): Promise<string[]> {
  await ensureDir(dir);

  if (folder !== undefined) {
    const safeFolder = sanitizeFolder(folder);
    if (!safeFolder) return [];
    const folderPath = join(dir, safeFolder);
    if (!resolve(folderPath).startsWith(resolve(dir))) return [];
    const glob = new Bun.Glob("*.md");
    const names: string[] = [];
    try {
      for await (const file of glob.scan(folderPath)) {
        names.push(`${safeFolder}/${file.replace(/\.md$/, "")}`);
      }
    } catch {
      // folder doesn't exist yet — return empty
    }
    return names;
  }

  const glob = new Bun.Glob("**/*.md");
  const names: string[] = [];
  for await (const file of glob.scan(dir)) {
    const noExt = file.replace(/\.md$/, "");
    // Single-level only — silently ignore deeper paths
    const slashCount = (noExt.match(/\//g) ?? []).length;
    if (slashCount > 1) continue;
    names.push(noExt);
  }
  return names;
}

/**
 * Read and parse a single note. `name` may be folder-prefixed
 * (e.g. "moltbook/foo") or bare. Pass `folder` explicitly to override.
 * Returns null if the note does not exist.
 */
export async function readNote(
  name: string,
  dir: string = getMemoryDir(),
  folder?: string
): Promise<MemoryNote | null> {
  await ensureDir(dir);
  const ref = resolveRef(name, folder);
  const path = notePath(dir, ref.name, ref.folder);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const raw = await file.text();
  const baseName = ref.name.replace(/\.md$/, "");
  const finalName = ref.folder ? `${sanitizeFolder(ref.folder)}/${sanitizeName(baseName)}` : sanitizeName(baseName);
  return parseNoteFile(finalName, raw);
}

/**
 * Write (create or overwrite) a note. `name` may be folder-prefixed; pass
 * `folder` explicitly to override.
 */
export async function writeNote(
  name: string,
  frontmatter: NoteFrontmatter,
  content: string,
  dir: string = getMemoryDir(),
  folder?: string
): Promise<void> {
  await ensureDir(dir);
  const ref = resolveRef(name, folder);
  const path = notePath(dir, ref.name, ref.folder);
  const serialized = `${serializeFrontmatter(frontmatter)}\n\n${content}\n`;
  await Bun.write(path, serialized);
}

/**
 * Delete a note. `name` may be folder-prefixed; pass `folder` explicitly to override.
 * Returns true if the note existed and was deleted.
 */
export async function deleteNote(
  name: string,
  dir: string = getMemoryDir(),
  folder?: string
): Promise<boolean> {
  await ensureDir(dir);
  const ref = resolveRef(name, folder);
  const path = notePath(dir, ref.name, ref.folder);
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  await unlink(path);
  return true;
}

/**
 * Load all notes in the memory directory. When `folder` is supplied, only
 * loads notes from that folder. Names on returned notes are folder-prefixed
 * for non-root notes.
 */
export async function loadAllNotes(
  dir: string = getMemoryDir(),
  folder?: string
): Promise<MemoryNote[]> {
  const refs = await listNotes(dir, folder);
  const results = await Promise.all(
    refs.map((ref) => {
      const parsed = parseNoteRef(ref);
      return readNote(parsed.name, dir, parsed.folder);
    })
  );
  return results.filter((n): n is MemoryNote => n !== null);
}

/**
 * Find all notes containing a [[backlink]] to the given note.
 * Backlinks are folder-agnostic — the lookup matches by bare name across all folders.
 * Returned names are folder-prefixed where applicable.
 */
export async function findBacklinks(
  name: string,
  dir: string = getMemoryDir()
): Promise<string[]> {
  const notes = await loadAllNotes(dir);
  const target = parseNoteRef(name).name;
  return notes.filter((n) => n.backlinks.includes(target)).map((n) => n.name);
}
