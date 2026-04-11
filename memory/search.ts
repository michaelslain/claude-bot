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

const MAX_CONTEXT_BYTES = 4096;

// Type weights: higher = more likely to be relevant
const TYPE_BOOST: Record<string, number> = {
  feedback: 1.5,
  preference: 1.4,
  workflow: 1.2,
  project: 1.1,
  fact: 1.0,
  person: 1.0,
  reference: 0.9,
  daily: 0.5,
  auto: 0.3,
};

// Minimum score to be included in results
const MIN_SCORE = 1.0;

export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_\/\\,.:;!?'"()\[\]{}<>|@#$%^&*+=~`]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  return [...new Set(tokens)];
}

interface ScoredNote {
  note: MemoryNote;
  score: number;
}

function scoreNote(note: MemoryNote, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const nameLower = note.name.toLowerCase();
  const tagsLower = note.frontmatter.tags.map((t) => t.toLowerCase());
  const bodyLower = note.content.toLowerCase();
  const bodyWords = bodyLower.split(/\W+/).filter((w) => w.length >= 3);
  const nameWords = nameLower.split(/\W+/).filter((w) => w.length >= 3);

  let score = 0;
  let matchedKeywords = 0;

  for (const kw of keywords) {
    let kwScore = 0;

    // Exact substring match in name (highest value)
    if (nameLower.includes(kw)) {
      kwScore += 3;
    } else if (nameWords.some((w) => kw.startsWith(w) && w.length >= 4)) {
      // Stem match in name: note word is a prefix of keyword (e.g. "auth" matches "authentication")
      kwScore += 1.5;
    }

    // Exact tag match
    if (tagsLower.some((t) => t === kw)) {
      kwScore += 3;
    } else if (tagsLower.some((t) => kw.startsWith(t) && t.length >= 4)) {
      kwScore += 1.5;
    }

    // Exact substring match in body
    if (bodyLower.includes(kw)) {
      kwScore += 1;
    } else if (bodyWords.some((w) => kw.startsWith(w) && w.length >= 4)) {
      // Stem match in body (reduced weight)
      kwScore += 0.5;
    }

    if (kwScore > 0) {
      matchedKeywords++;
      score += kwScore;
    }
  }

  // No matches at all — skip this note
  if (matchedKeywords === 0) return 0;

  // Bonus for matching multiple keywords (rewards relevance density)
  const matchRatio = matchedKeywords / keywords.length;
  score *= (1 + matchRatio);

  // Apply type boost/penalty
  const typeKey = note.frontmatter.type.toLowerCase();
  const typeMultiplier = TYPE_BOOST[typeKey] ?? 1.0;
  score *= typeMultiplier;

  return score;
}

export async function searchMemory(
  prompt: string,
  dir: string = getMemoryDir(),
  maxResults: number = 10
): Promise<MemoryNote[]> {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return [];

  const notes = await loadAllNotes(dir);

  // Score and filter
  const scored: ScoredNote[] = [];
  for (const note of notes) {
    const score = scoreNote(note, keywords);
    if (score >= MIN_SCORE) {
      scored.push({ note, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Budget cap: don't exceed MAX_CONTEXT_BYTES of injected content
  const results: MemoryNote[] = [];
  let totalBytes = 0;
  for (const { note } of scored) {
    if (results.length >= maxResults) break;
    const noteSize = note.name.length + note.content.length + note.frontmatter.tags.join(" ").length + 50;
    if (totalBytes + noteSize > MAX_CONTEXT_BYTES && results.length > 0) break;
    results.push(note);
    totalBytes += noteSize;
  }

  return results;
}
