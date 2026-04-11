import { join, resolve } from "path";
import { homedir } from "os";
import { mkdir as fsMkdir, unlink } from "fs/promises";

export const DEFAULT_MEMORY_DIR = join(homedir(), ".claude-bot", "memory");

export function getMemoryDir(): string {
  return process.env["CLAUDE_BOT_MEMORY_DIR"] ?? DEFAULT_MEMORY_DIR;
}

export type NoteType = "person" | "project" | "workflow" | "fact" | "preference" | "daily" | "auto";

export interface NoteFrontmatter {
  type: NoteType;
  tags: string[];
  created: string;
  updated: string;
}

export interface MemoryNote {
  name: string;
  frontmatter: NoteFrontmatter;
  content: string;
  /** Names of notes linked via [[backlinks]] in the content */
  backlinks: string[];
}

const ensuredDirs = new Set<string>();
async function ensureDir(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await fsMkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

// Prevent directory traversal attacks
function sanitizeName(name: string): string {
  return name
    .replace(/[\/\\]/g, "-")
    .replace(/\.\./g, "")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")
    .replace(/-+/g, "-")
    .trim();
}

function notePath(dir: string, name: string): string {
  const safe = sanitizeName(name);
  if (!safe) throw new Error("Invalid note name");
  const safeName = safe.endsWith(".md") ? safe : `${safe}.md`;
  const full = join(dir, safeName);
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
 * List all note names (without .md extension) in the memory directory.
 */
export async function listNotes(dir: string = getMemoryDir()): Promise<string[]> {
  await ensureDir(dir);
  const glob = new Bun.Glob("*.md");
  const names: string[] = [];
  for await (const file of glob.scan(dir)) {
    names.push(file.replace(/\.md$/, ""));
  }
  return names;
}

/**
 * Read and parse a single note by name.
 * Returns null if the note does not exist.
 */
export async function readNote(
  name: string,
  dir: string = getMemoryDir()
): Promise<MemoryNote | null> {
  await ensureDir(dir);
  const path = notePath(dir, name);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const raw = await file.text();
  const baseName = name.replace(/\.md$/, "");
  return parseNoteFile(baseName, raw);
}

/**
 * Write (create or overwrite) a note.
 */
export async function writeNote(
  name: string,
  frontmatter: NoteFrontmatter,
  content: string,
  dir: string = getMemoryDir()
): Promise<void> {
  await ensureDir(dir);
  const path = notePath(dir, name);
  const serialized = `${serializeFrontmatter(frontmatter)}\n\n${content}\n`;
  await Bun.write(path, serialized);
}

/**
 * Delete a note by name. Returns true if the note existed and was deleted.
 */
export async function deleteNote(
  name: string,
  dir: string = getMemoryDir()
): Promise<boolean> {
  await ensureDir(dir);
  const path = notePath(dir, name);
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  await unlink(path);
  return true;
}

/**
 * Load all notes in the memory directory.
 */
export async function loadAllNotes(dir: string = getMemoryDir()): Promise<MemoryNote[]> {
  const names = await listNotes(dir);
  const results = await Promise.all(names.map((name) => readNote(name, dir)));
  return results.filter((n): n is MemoryNote => n !== null);
}

/**
 * Find all notes that contain a [[backlink]] to the given note name.
 */
export async function findBacklinks(
  name: string,
  dir: string = getMemoryDir()
): Promise<string[]> {
  const notes = await loadAllNotes(dir);
  return notes.filter((n) => n.backlinks.includes(name)).map((n) => n.name);
}

