import { loadAllNotes, getMemoryDir } from "./graph.ts";
import type { MemoryNote } from "./graph.ts";

const STOP_WORDS = new Set([
  "the", "is", "a", "an", "it", "to", "for", "of", "in", "on", "and", "or",
  "but", "with", "that", "this", "from", "what", "how", "why", "when", "where",
  "who", "can", "do", "does", "did", "will", "would", "should", "could", "have",
  "has", "had", "be", "been", "was", "were", "are", "am", "not", "no", "my",
  "your", "i", "me", "we", "you", "he", "she", "they", "them", "its", "their",
  "our", "just", "also", "about", "up", "out", "so", "if", "at", "by", "let",
  "all", "any", "some", "very", "too", "more", "than", "then", "into", "over",
  "such", "after", "before", "between", "each", "few", "both", "other", "own",
  "same", "here", "there", "now", "only", "even", "still", "already", "well",
  "much", "many", "most", "often", "never", "always", "yet",
]);

export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_\/\\,.:;!?'"()\[\]{}<>|@#$%^&*+=~`]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  return [...new Set(tokens)];
}

/**
 * Check if a note matches any of the given keywords using OR semantics.
 * A keyword matches if:
 *   - the searchable text contains the keyword, OR
 *   - a word in the searchable text is a prefix of the keyword (stem match)
 */
function noteMatchesKeywords(note: MemoryNote, keywords: string[]): boolean {
  const searchable = [
    note.content,
    note.frontmatter.type,
    ...note.frontmatter.tags,
    note.frontmatter.created,
    note.frontmatter.updated,
    note.name,
  ]
    .join(" ")
    .toLowerCase();

  // Extract words from the note's searchable text for prefix matching
  const noteWords = searchable.split(/\W+/).filter((w) => w.length >= 3);

  for (const kw of keywords) {
    // Direct substring match (kw appears in note text)
    if (searchable.includes(kw)) return true;
    // Prefix match: a word in the note is a prefix of the keyword
    // e.g. noteWord="auth", kw="authentication" → "authentication".startsWith("auth")
    for (const word of noteWords) {
      if (kw.startsWith(word)) return true;
    }
  }

  return false;
}

export async function searchMemory(
  prompt: string,
  dir: string = getMemoryDir(),
  maxResults: number = 10
): Promise<MemoryNote[]> {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return [];

  const notes = await loadAllNotes(dir);
  const results = notes.filter((note) => noteMatchesKeywords(note, keywords));
  return results.slice(0, maxResults);
}
