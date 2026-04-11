import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { writeNote, type NoteFrontmatter } from "./graph.ts";
import { extractKeywords, searchMemory } from "./search.ts";

function makeTempDir(): string {
  return join(tmpdir(), `claude-bot-search-test-${randomBytes(8).toString("hex")}`);
}

describe("extractKeywords", () => {
  test("extracts words from simple text", () => {
    const kws = extractKeywords("fix the authentication bug");
    expect(kws).toContain("fix");
    expect(kws).toContain("authentication");
    expect(kws).toContain("bug");
  });

  test("removes stop words", () => {
    const kws = extractKeywords("what is the best way to do this");
    expect(kws).not.toContain("what");
    expect(kws).not.toContain("is");
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("to");
    expect(kws).not.toContain("do");
    expect(kws).not.toContain("this");
    expect(kws).toContain("best");
    expect(kws).toContain("way");
  });

  test("removes short tokens (< 3 chars)", () => {
    const kws = extractKeywords("go to db and fix it");
    expect(kws).not.toContain("go");
    expect(kws).not.toContain("to");
    expect(kws).not.toContain("db");
    expect(kws).toContain("fix");
  });

  test("lowercases all keywords", () => {
    const kws = extractKeywords("Fix Authentication Bug");
    expect(kws).toContain("fix");
    expect(kws).toContain("authentication");
    expect(kws).toContain("bug");
  });

  test("splits on punctuation", () => {
    const kws = extractKeywords("auth-module, deploy/process");
    expect(kws).toContain("auth");
    expect(kws).toContain("module");
    expect(kws).toContain("deploy");
    expect(kws).toContain("process");
  });

  test("deduplicates keywords", () => {
    const kws = extractKeywords("auth auth auth module");
    const authCount = kws.filter((k) => k === "auth").length;
    expect(authCount).toBe(1);
  });

  test("returns empty array for stop-words-only input", () => {
    const kws = extractKeywords("the is a an");
    expect(kws).toEqual([]);
  });
});

describe("searchMemory", () => {
  let tempDir: string;

  const mkFm = (type: NoteFrontmatter["type"], tags: string[]): NoteFrontmatter => ({
    type,
    tags,
    created: "2026-04-01",
    updated: "2026-04-08",
  });

  beforeEach(async () => {
    tempDir = makeTempDir();
    await Bun.spawn(["mkdir", "-p", tempDir]).exited;
    await writeNote("Alice", mkFm("person", ["friend"]), "Alice is an engineer who works on authentication.", tempDir);
    await writeNote("DeployGuide", mkFm("workflow", ["devops"]), "Steps to deploy the backend service.", tempDir);
    await writeNote("ProjectAuth", mkFm("project", ["active"]), "The auth project for login and sessions.", tempDir);
  });

  afterEach(async () => {
    await Bun.spawn(["rm", "-rf", tempDir]).exited;
  });

  test("finds notes matching prompt keywords", async () => {
    const results = await searchMemory("fix the authentication bug", tempDir);
    const names = results.map((n) => n.name);
    expect(names).toContain("Alice");
  });

  test("ranks exact matches above stem matches", async () => {
    const results = await searchMemory("authentication project login sessions", tempDir);
    const names = results.map((n) => n.name);
    // ProjectAuth matches multiple keywords exactly (project, login, sessions)
    // Alice matches one keyword exactly (authentication)
    expect(names).toContain("ProjectAuth");
    expect(names).toContain("Alice");
    expect(names.indexOf("ProjectAuth")).toBeLessThan(names.indexOf("Alice"));
  });

  test("returns empty array when no keywords match", async () => {
    const results = await searchMemory("quantum physics lecture", tempDir);
    expect(results).toEqual([]);
  });

  test("returns empty array for stop-words-only prompt", async () => {
    const results = await searchMemory("the is a an", tempDir);
    expect(results).toEqual([]);
  });

  test("respects maxResults limit", async () => {
    const results = await searchMemory("deploy auth engineer", tempDir, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
