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
});
