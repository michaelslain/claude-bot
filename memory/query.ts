import { loadAllNotes, getMemoryDir } from "./graph.ts";
import type { MemoryNote } from "./graph.ts";

export interface ParsedQuery {
  tags: string[];
  types: string[];
  keywords: string[];
  links: string[];
  after?: string;
  before?: string;
  keywordMode: "and" | "or";
}

/**
 * Parse a query string into structured filters.
 *
 * Supported token syntax (whitespace-separated):
 *   tag:workflow          — notes with this tag (may repeat for AND)
 *   type:person           — notes of this type (may repeat for AND)
 *   link:NoteName         — notes linking to [[NoteName]] (may repeat for AND)
 *   after:2026-04-01      — updated on or after date
 *   before:2026-04-08     — updated strictly before date
 *   keyword:auth          — explicit keyword filter
 *   auth                  — bare word treated as keyword
 */
export function parseQuery(queryString: string): ParsedQuery {
  const tokens = queryString.trim().split(/\s+/).filter((t) => t.length > 0);

  const result: ParsedQuery = {
    tags: [],
    types: [],
    keywords: [],
    links: [],
    keywordMode: "and",
  };

  for (const token of tokens) {
    const colonIdx = token.indexOf(":");
    if (colonIdx === -1) {
      // Bare word → keyword
      result.keywords.push(token.toLowerCase());
      continue;
    }

    const prefix = token.slice(0, colonIdx).toLowerCase();
    const value = token.slice(colonIdx + 1);

    switch (prefix) {
      case "tag":
        result.tags.push(value.toLowerCase());
        break;
      case "type":
        result.types.push(value.toLowerCase());
        break;
      case "link":
        result.links.push(value.toLowerCase());
        break;
      case "after":
        result.after = value;
        break;
      case "before":
        result.before = value;
        break;
      case "keyword":
        result.keywords.push(value.toLowerCase());
        break;
      default:
        // Unknown prefix — treat entire token as a keyword
        result.keywords.push(token.toLowerCase());
        break;
    }
  }

  return result;
}

function noteMatchesQuery(note: MemoryNote, query: ParsedQuery): boolean {
  const { frontmatter, content, backlinks } = note;

  // Type filter — note must match one of the requested types
  if (query.types.length > 0) {
    if (!query.types.includes(frontmatter.type.toLowerCase())) return false;
  }

  // Tag filter — note must have ALL requested tags
  if (query.tags.length > 0) {
    const noteTags = frontmatter.tags.map((t) => t.toLowerCase());
    for (const tag of query.tags) {
      if (!noteTags.includes(tag)) return false;
    }
  }

  // Link filter — note must link to ALL requested note names
  if (query.links.length > 0) {
    const lowerBacklinks = new Set(backlinks.map((b) => b.toLowerCase()));
    for (const linkTarget of query.links) {
      if (!lowerBacklinks.has(linkTarget)) return false;
    }
  }

  // Date range — uses `updated` date for range checks (lexicographic ISO date comparison)
  if (query.after !== undefined) {
    if (frontmatter.updated < query.after) return false;
  }
  if (query.before !== undefined) {
    if (frontmatter.updated >= query.before) return false;
  }

  // Keyword search — full-text across content + frontmatter fields
  if (query.keywords.length > 0) {
    const searchable = [
      content,
      frontmatter.type,
      ...frontmatter.tags,
      frontmatter.created,
      frontmatter.updated,
      note.name,
    ]
      .join(" ")
      .toLowerCase();

    if (query.keywordMode === "or") {
      const hasAny = query.keywords.some((kw) => searchable.includes(kw));
      if (!hasAny) return false;
    } else {
      for (const kw of query.keywords) {
        if (!searchable.includes(kw)) return false;
      }
    }
  }

  return true;
}

/**
 * Execute a parsed query against the memory graph directory.
 * Loads all notes and applies all filters (AND semantics within each filter type).
 */
export async function executeQuery(
  query: ParsedQuery,
  dir: string = getMemoryDir()
): Promise<MemoryNote[]> {
  const notes = await loadAllNotes(dir);
  return notes.filter((note) => noteMatchesQuery(note, query));
}

/**
 * Convenience: parse and execute a query string in one call.
 */
export async function query(
  queryString: string,
  dir: string = getMemoryDir()
): Promise<MemoryNote[]> {
  return executeQuery(parseQuery(queryString), dir);
}
