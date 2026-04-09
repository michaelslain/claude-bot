#!/usr/bin/env bun
import { searchMemory } from "../memory/search.ts";
import type { MemoryNote } from "../memory/graph.ts";

function formatNotes(notes: MemoryNote[]): string {
  const lines = ["# Claude Bot Memories", ""];
  for (const note of notes) {
    const { frontmatter: fm, content, backlinks } = note;
    lines.push(`## ${note.name} (${fm.type}) [${fm.tags.join(", ")}]`);
    lines.push(content);
    if (backlinks.length > 0) {
      lines.push(`Links: ${backlinks.map((b) => `[[${b}]]`).join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

try {
  const input = await Bun.stdin.text();
  const { prompt } = JSON.parse(input) as { prompt: string };

  if (!prompt) process.exit(0);

  const notes = await searchMemory(prompt);
  if (notes.length === 0) process.exit(0);

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatNotes(notes),
    },
  };

  process.stdout.write(JSON.stringify(output));
} catch (err) {
  console.error("[memory-hook]", err);
  process.exit(0);
}
