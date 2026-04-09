import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { writeNote, type NoteFrontmatter } from "./graph.ts";
import { parseQuery, executeQuery, query } from "./query.ts";

function makeTempDir(): string {
  return join(tmpdir(), `claude-bot-query-test-${randomBytes(8).toString("hex")}`);
}

describe("parseQuery", () => {
  test("parses empty string", () => {
    const q = parseQuery("");
    expect(q.tags).toEqual([]);
    expect(q.types).toEqual([]);
    expect(q.keywords).toEqual([]);
    expect(q.links).toEqual([]);
    expect(q.after).toBeUndefined();
    expect(q.before).toBeUndefined();
  });

  test("parses tag filter", () => {
    const q = parseQuery("tag:workflow");
    expect(q.tags).toEqual(["workflow"]);
  });

  test("parses type filter", () => {
    const q = parseQuery("type:person");
    expect(q.types).toEqual(["person"]);
  });

  test("parses link filter", () => {
    const q = parseQuery("link:AuthModule");
    expect(q.links).toEqual(["AuthModule"]);
  });

  test("parses after date", () => {
    const q = parseQuery("after:2026-04-01");
    expect(q.after).toBe("2026-04-01");
  });

  test("parses before date", () => {
    const q = parseQuery("before:2026-04-08");
    expect(q.before).toBe("2026-04-08");
  });

  test("parses explicit keyword", () => {
    const q = parseQuery("keyword:auth");
    expect(q.keywords).toEqual(["auth"]);
  });

  test("parses bare words as keywords", () => {
    const q = parseQuery("auth deploy");
    expect(q.keywords).toEqual(["auth", "deploy"]);
  });

  test("parses combined query", () => {
    const q = parseQuery("type:project tag:active keyword:auth");
    expect(q.types).toEqual(["project"]);
    expect(q.tags).toEqual(["active"]);
    expect(q.keywords).toEqual(["auth"]);
  });

  test("parses multiple tags", () => {
    const q = parseQuery("tag:workflow tag:backend");
    expect(q.tags).toEqual(["workflow", "backend"]);
  });

  test("normalizes tag and type to lowercase", () => {
    const q = parseQuery("tag:WORKFLOW type:PERSON");
    expect(q.tags).toEqual(["workflow"]);
    expect(q.types).toEqual(["person"]);
  });

  test("unknown prefix treated as keyword", () => {
    const q = parseQuery("foo:bar");
    expect(q.keywords).toEqual(["foo:bar"]);
  });
});

describe("executeQuery", () => {
  let tempDir: string;

  const mkFm = (
    type: NoteFrontmatter["type"],
    tags: string[],
    updated = "2026-04-08"
  ): NoteFrontmatter => ({
    type,
    tags,
    created: "2026-04-01",
    updated,
  });

  beforeEach(async () => {
    tempDir = makeTempDir();
    await Bun.spawn(["mkdir", "-p", tempDir]).exited;

    // Seed notes
    await writeNote(
      "Alice",
      mkFm("person", ["friend", "engineer"]),
      "Alice is an engineer. She works on [[AuthModule]].",
      tempDir
    );
    await writeNote(
      "ProjectAuth",
      mkFm("project", ["active", "backend"], "2026-04-05"),
      "Auth project involving [[Alice]].",
      tempDir
    );
    await writeNote(
      "DeployWorkflow",
      mkFm("workflow", ["backend", "process"]),
      "Deploy process steps for the backend.",
      tempDir
    );
    await writeNote(
      "OldFact",
      mkFm("fact", ["archive"], "2026-03-01"),
      "Some old archived fact.",
      tempDir
    );
    await writeNote(
      "AuthModule",
      mkFm("project", ["active", "security"]),
      "Authentication module details.",
      tempDir
    );
  });

  afterEach(async () => {
    await Bun.spawn(["rm", "-rf", tempDir]).exited;
  });

  test("returns all notes when query is empty", async () => {
    const results = await executeQuery(parseQuery(""), tempDir);
    expect(results).toHaveLength(5);
  });

  test("filters by type", async () => {
    const results = await executeQuery(parseQuery("type:person"), tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Alice");
  });

  test("filters by tag", async () => {
    const results = await executeQuery(parseQuery("tag:active"), tempDir);
    expect(results.map((n) => n.name).sort()).toEqual(["AuthModule", "ProjectAuth"]);
  });

  test("filters by multiple tags (AND)", async () => {
    const results = await executeQuery(parseQuery("tag:active tag:backend"), tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("ProjectAuth");
  });

  test("filters by keyword in content", async () => {
    const results = await executeQuery(parseQuery("authentication"), tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("AuthModule");
  });

  test("filters by keyword in note name", async () => {
    const results = await executeQuery(parseQuery("keyword:deploy"), tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("DeployWorkflow");
  });

  test("filters by link", async () => {
    const results = await executeQuery(parseQuery("link:Alice"), tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("ProjectAuth");
  });

  test("filters by after date", async () => {
    const results = await executeQuery(parseQuery("after:2026-04-06"), tempDir);
    const names = results.map((n) => n.name).sort();
    // Alice, DeployWorkflow, AuthModule have updated: 2026-04-08
    expect(names).toContain("Alice");
    expect(names).toContain("DeployWorkflow");
    expect(names).toContain("AuthModule");
    expect(names).not.toContain("OldFact");
    expect(names).not.toContain("ProjectAuth"); // updated 2026-04-05
  });

  test("filters by before date", async () => {
    const results = await executeQuery(parseQuery("before:2026-04-06"), tempDir);
    const names = results.map((n) => n.name).sort();
    expect(names).toContain("OldFact");
    expect(names).toContain("ProjectAuth");
    expect(names).not.toContain("Alice");
  });

  test("combined type + tag + keyword", async () => {
    const results = await executeQuery(parseQuery("type:project tag:active keyword:auth"), tempDir);
    // Both ProjectAuth and AuthModule are type:project + tag:active
    // keyword "auth" must be in content/name — both match
    const names = results.map((n) => n.name).sort();
    expect(names).toEqual(["AuthModule", "ProjectAuth"]);
  });

  test("returns empty array when no notes match", async () => {
    const results = await executeQuery(parseQuery("type:daily"), tempDir);
    expect(results).toEqual([]);
  });

  test("convenience query() function works", async () => {
    const results = await query("type:workflow", tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("DeployWorkflow");
  });

  test("OR keyword mode matches notes with any keyword", async () => {
    const q = parseQuery("alice deploy");
    q.keywordMode = "or";
    const results = await executeQuery(q, tempDir);
    const names = results.map((n) => n.name).sort();
    expect(names).toContain("Alice");
    expect(names).toContain("DeployWorkflow");
  });

  test("OR keyword mode returns empty when no keywords match", async () => {
    const q = parseQuery("zzzznothing xxxxxnope");
    q.keywordMode = "or";
    const results = await executeQuery(q, tempDir);
    expect(results).toEqual([]);
  });

  test("AND keyword mode still requires all keywords (default)", async () => {
    const results = await executeQuery(parseQuery("alice deploy"), tempDir);
    expect(results).toEqual([]);
  });
});
