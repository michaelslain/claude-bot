import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import {
  listNotes,
  readNote,
  writeNote,
  deleteNote,
  findBacklinks,
  loadAllNotes,
  type NoteFrontmatter,
} from "./graph.ts";

function makeTempDir(): string {
  return join(tmpdir(), `claude-bot-test-${randomBytes(8).toString("hex")}`);
}

describe("MemoryGraph", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await Bun.spawn(["mkdir", "-p", tempDir]).exited;
  });

  afterEach(async () => {
    await Bun.spawn(["rm", "-rf", tempDir]).exited;
  });

  test("listNotes returns empty array when no notes exist", async () => {
    const notes = await listNotes(tempDir);
    expect(notes).toEqual([]);
  });

  test("writeNote and readNote round-trip", async () => {
    const fm: NoteFrontmatter = {
      type: "person",
      tags: ["friend", "engineer"],
      created: "2026-04-01",
      updated: "2026-04-08",
    };
    await writeNote("Alice", fm, "Alice is a software engineer. She knows [[Bob]].", tempDir);

    const note = await readNote("Alice", tempDir);
    expect(note).not.toBeNull();
    expect(note!.name).toBe("Alice");
    expect(note!.frontmatter.type).toBe("person");
    expect(note!.frontmatter.tags).toEqual(["friend", "engineer"]);
    expect(note!.frontmatter.created).toBe("2026-04-01");
    expect(note!.frontmatter.updated).toBe("2026-04-08");
    expect(note!.content).toContain("Alice is a software engineer");
    expect(note!.backlinks).toContain("Bob");
  });

  test("readNote returns null for non-existent note", async () => {
    const note = await readNote("NonExistent", tempDir);
    expect(note).toBeNull();
  });

  test("listNotes returns all written notes", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("NoteA", fm, "Content A", tempDir);
    await writeNote("NoteB", fm, "Content B", tempDir);

    const notes = await listNotes(tempDir);
    expect(notes.sort()).toEqual(["NoteA", "NoteB"]);
  });

  test("deleteNote removes a note", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("ToDelete", fm, "Delete me", tempDir);
    const deleted = await deleteNote("ToDelete", tempDir);
    expect(deleted).toBe(true);

    const note = await readNote("ToDelete", tempDir);
    expect(note).toBeNull();
  });

  test("deleteNote returns false for non-existent note", async () => {
    const deleted = await deleteNote("Ghost", tempDir);
    expect(deleted).toBe(false);
  });

  test("findBacklinks finds notes linking to a given note", async () => {
    const fm: NoteFrontmatter = {
      type: "person",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("Alice", fm, "Alice knows [[Bob]] and [[Carol]].", tempDir);
    await writeNote("Carol", fm, "Carol is friends with [[Bob]].", tempDir);
    await writeNote("Bob", fm, "Bob is a developer.", tempDir);

    const backlinks = await findBacklinks("Bob", tempDir);
    expect(backlinks.sort()).toEqual(["Alice", "Carol"]);
    expect(backlinks).not.toContain("Bob");
  });

  test("backlinks are extracted from content", async () => {
    const fm: NoteFrontmatter = {
      type: "workflow",
      tags: ["process"],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote(
      "Workflow",
      fm,
      "See [[Auth Module]] and [[Deploy Process]] for details.",
      tempDir
    );
    const note = await readNote("Workflow", tempDir);
    expect(note!.backlinks.sort()).toEqual(["Auth Module", "Deploy Process"]);
  });

  test("tags with empty array serialize and parse correctly", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("EmptyTags", fm, "No tags here.", tempDir);
    const note = await readNote("EmptyTags", tempDir);
    expect(note!.frontmatter.tags).toEqual([]);
  });

  test("writeNote overwrites an existing note", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: ["old"],
      created: "2026-04-01",
      updated: "2026-04-01",
    };
    await writeNote("UpdateMe", fm, "Original content", tempDir);

    const fm2: NoteFrontmatter = {
      type: "fact",
      tags: ["new"],
      created: "2026-04-01",
      updated: "2026-04-08",
    };
    await writeNote("UpdateMe", fm2, "Updated content", tempDir);

    const note = await readNote("UpdateMe", tempDir);
    expect(note!.frontmatter.tags).toEqual(["new"]);
    expect(note!.content).toContain("Updated content");
    expect(note!.content).not.toContain("Original content");
  });

  test("duplicate backlinks are deduplicated", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("DupLinks", fm, "See [[Alpha]] and again [[Alpha]] and [[Alpha]].", tempDir);
    const note = await readNote("DupLinks", tempDir);
    expect(note!.backlinks).toEqual(["Alpha"]);
  });

  test("findBacklinks returns empty array when no notes link to target", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("Solo", fm, "This note has no backlinks.", tempDir);
    const backlinks = await findBacklinks("NonLinkedNote", tempDir);
    expect(backlinks).toEqual([]);
  });

  test("backlinks with whitespace are trimmed", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("SpacedLinks", fm, "See [[ Alice ]] and [[\tBob\t]] for details.", tempDir);
    const note = await readNote("SpacedLinks", tempDir);
    expect(note!.backlinks.sort()).toEqual(["Alice", "Bob"]);
  });

  test("empty backlinks are filtered out", async () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };
    await writeNote("EmptyLink", fm, "See [[]] and [[ ]] here.", tempDir);
    const note = await readNote("EmptyLink", tempDir);
    expect(note!.backlinks).toEqual([]);
  });

  // ─── sanitizeName / notePath edge cases ───────────────────────────────────

  describe("sanitizeName edge cases", () => {
    const fm: NoteFrontmatter = {
      type: "fact",
      tags: [],
      created: "2026-04-08",
      updated: "2026-04-08",
    };

    test("name with forward slashes is sanitized to dashes", async () => {
      await writeNote("foo/bar/baz", fm, "slash content", tempDir);
      // slashes become dashes, so the stored name should be readable back
      const note = await readNote("foo/bar/baz", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("slash content");
    });

    test("name with backslashes is sanitized to dashes", async () => {
      await writeNote("foo\\bar", fm, "backslash content", tempDir);
      const note = await readNote("foo\\bar", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("backslash content");
    });

    test("name with .. traversal is sanitized safely", async () => {
      await writeNote("../../etc/passwd", fm, "traversal content", tempDir);
      // The file must land inside tempDir — just confirm we can round-trip it
      const note = await readNote("../../etc/passwd", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("traversal content");
    });

    test("name that is all dots throws Invalid note name", async () => {
      await expect(
        async () => await writeNote("...", fm, "dots", tempDir)
      ).toThrow("Invalid note name");
    });

    test("name that is all dashes throws Invalid note name", async () => {
      await expect(
        async () => await writeNote("---", fm, "dashes", tempDir)
      ).toThrow("Invalid note name");
    });

    test("name with leading dot has dot stripped", async () => {
      await writeNote(".hidden", fm, "hidden content", tempDir);
      // leading dot is stripped by sanitizeName, so reading ".hidden" should work
      const note = await readNote(".hidden", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("hidden content");
    });

    test("name with .md extension is not double-extended", async () => {
      await writeNote("note.md", fm, "md name content", tempDir);
      // notePath should not produce note.md.md
      const notes = await listNotes(tempDir);
      const mdMdCount = notes.filter((n) => n.endsWith(".md")).length;
      expect(mdMdCount).toBe(0); // listNotes strips .md, so none should end in .md
      const note = await readNote("note.md", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("md name content");
    });

    test("name with spaces is accepted", async () => {
      await writeNote("my note name", fm, "spaced content", tempDir);
      const note = await readNote("my note name", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("spaced content");
    });

    test("empty string name throws Invalid note name", async () => {
      await expect(
        async () => await writeNote("", fm, "empty name", tempDir)
      ).toThrow("Invalid note name");
    });
  });

  // ─── Frontmatter parsing edge cases ────────────────────────────────────────

  describe("frontmatter parsing edge cases", () => {
    test("note with no tags round-trips as empty array", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: [],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await writeNote("NoTags", fm, "no tags", tempDir);
      const note = await readNote("NoTags", tempDir);
      expect(note!.frontmatter.tags).toEqual([]);
    });

    test("note with single tag round-trips as array", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: ["solo"],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await writeNote("SingleTag", fm, "one tag", tempDir);
      const note = await readNote("SingleTag", tempDir);
      expect(note!.frontmatter.tags).toEqual(["solo"]);
    });

    test("note with many tags round-trips correctly", async () => {
      const tags = ["alpha", "beta", "gamma", "delta", "epsilon"];
      const fm: NoteFrontmatter = {
        type: "fact",
        tags,
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await writeNote("ManyTags", fm, "many tags", tempDir);
      const note = await readNote("ManyTags", tempDir);
      expect(note!.frontmatter.tags).toEqual(tags);
    });

    test("content containing --- on its own line does not break frontmatter parsing", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: ["test"],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      const content = "Above the line\n---\nBelow the line";
      await writeNote("DashDivider", fm, content, tempDir);
      const note = await readNote("DashDivider", tempDir);
      expect(note).not.toBeNull();
      // Type should still parse correctly from frontmatter
      expect(note!.frontmatter.type).toBe("fact");
      expect(note!.frontmatter.tags).toEqual(["test"]);
    });

    test("very long content (1000+ chars) round-trips correctly", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: [],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      const longContent = "A".repeat(500) + " middle " + "B".repeat(500);
      await writeNote("LongNote", fm, longContent, tempDir);
      const note = await readNote("LongNote", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("A".repeat(500));
      expect(note!.content).toContain("middle");
      expect(note!.content).toContain("B".repeat(500));
    });

    test("content with special characters, unicode, emoji, backticks round-trips correctly", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: [],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      const content = "Unicode: 日本語 中文 한국어\nEmoji: 🎉🚀💾\nBackticks: `code` ```block```\nSymbols: <>&\"'\\";
      await writeNote("SpecialChars", fm, content, tempDir);
      const note = await readNote("SpecialChars", tempDir);
      expect(note).not.toBeNull();
      expect(note!.content).toContain("日本語");
      expect(note!.content).toContain("🎉");
      expect(note!.content).toContain("`code`");
    });
  });

  // ─── loadAllNotes ──────────────────────────────────────────────────────────

  describe("loadAllNotes", () => {
    test("returns empty array for empty directory", async () => {
      const notes = await loadAllNotes(tempDir);
      expect(notes).toEqual([]);
    });

    test("returns all notes in the directory", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: [],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await writeNote("NoteOne", fm, "content one", tempDir);
      await writeNote("NoteTwo", fm, "content two", tempDir);
      await writeNote("NoteThree", fm, "content three", tempDir);

      const notes = await loadAllNotes(tempDir);
      expect(notes).toHaveLength(3);
      const names = notes.map((n) => n.name).sort();
      expect(names).toEqual(["NoteOne", "NoteThree", "NoteTwo"]);
    });

    test("ignores non-.md files in the directory", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: [],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await writeNote("RealNote", fm, "real content", tempDir);
      // Write a non-.md file directly
      await Bun.write(join(tempDir, "not-a-note.txt"), "plain text file");
      await Bun.write(join(tempDir, "config.json"), '{"key": "value"}');

      const notes = await loadAllNotes(tempDir);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.name).toBe("RealNote");
    });

    test("handles mix of valid and files with missing frontmatter", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: ["valid"],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await writeNote("ValidNote", fm, "valid content", tempDir);
      // Write a .md file with no frontmatter directly
      await Bun.write(join(tempDir, "raw-content.md"), "Just raw content, no frontmatter.");

      const notes = await loadAllNotes(tempDir);
      expect(notes).toHaveLength(2);
      const validNote = notes.find((n) => n.name === "ValidNote");
      const rawNote = notes.find((n) => n.name === "raw-content");
      expect(validNote!.frontmatter.tags).toEqual(["valid"]);
      // raw note falls back to defaults
      expect(rawNote!.frontmatter.type).toBe("fact");
      expect(rawNote!.content).toContain("Just raw content");
    });
  });

  // ─── Concurrent operations ─────────────────────────────────────────────────

  describe("concurrent operations", () => {
    test("writing two notes concurrently both succeed", async () => {
      const fm: NoteFrontmatter = {
        type: "fact",
        tags: [],
        created: "2026-04-08",
        updated: "2026-04-08",
      };
      await Promise.all([
        writeNote("Concurrent1", fm, "concurrent content one", tempDir),
        writeNote("Concurrent2", fm, "concurrent content two", tempDir),
      ]);

      const note1 = await readNote("Concurrent1", tempDir);
      const note2 = await readNote("Concurrent2", tempDir);
      expect(note1).not.toBeNull();
      expect(note2).not.toBeNull();
      expect(note1!.content).toContain("concurrent content one");
      expect(note2!.content).toContain("concurrent content two");
    });

    test("deleting a note that does not exist returns false without throwing", async () => {
      const result = await deleteNote("AbsolutelyDoesNotExist", tempDir);
      expect(result).toBe(false);
    });
  });
});
