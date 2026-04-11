import { describe, it, expect } from "bun:test"
import { writeFile, mkdir, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { parseCronExpression, shouldFire } from "./cron"
import { parseFrontmatter } from "../lib/frontmatter"

describe("parseCronExpression", () => {
  it("parses * * * * *", () => {
    const result = parseCronExpression("* * * * *")
    expect(result).toEqual({
      minute: "*",
      hour: "*",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })
  })

  it("parses 0 9 * * *", () => {
    const result = parseCronExpression("0 9 * * *")
    expect(result).toEqual({
      minute: "0",
      hour: "9",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })
  })

  it("parses */30 * * * *", () => {
    const result = parseCronExpression("*/30 * * * *")
    expect(result).toEqual({
      minute: "*/30",
      hour: "*",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })
  })

  it("returns null for too few fields", () => {
    expect(parseCronExpression("* * * *")).toBeNull()
  })

  it("returns null for too many fields", () => {
    expect(parseCronExpression("* * * * * *")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(parseCronExpression("")).toBeNull()
  })
})

describe("shouldFire", () => {
  it("* * * * * fires every minute", () => {
    const cron = parseCronExpression("* * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T00:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T12:37:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T23:59:00"))).toBe(true)
  })

  it("0 9 * * * fires only at 9:00", () => {
    const cron = parseCronExpression("0 9 * * *")!
    // Should fire at 9:00
    expect(shouldFire(cron, new Date("2026-04-08T09:00:00"))).toBe(true)
    // Should NOT fire at 9:01
    expect(shouldFire(cron, new Date("2026-04-08T09:01:00"))).toBe(false)
    // Should NOT fire at 10:00
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(false)
    // Should NOT fire at 8:00
    expect(shouldFire(cron, new Date("2026-04-08T08:00:00"))).toBe(false)
  })

  it("*/15 * * * * fires at 0, 15, 30, 45", () => {
    const cron = parseCronExpression("*/15 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:15:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:30:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:45:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:07:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T10:20:00"))).toBe(false)
  })

  it("0 9 * * 1 fires only on Mondays at 9:00 (2026-04-06 is Monday)", () => {
    const cron = parseCronExpression("0 9 * * 1")!
    // Monday at 9:00 — should fire
    expect(shouldFire(cron, new Date("2026-04-06T09:00:00"))).toBe(true)
    // Tuesday at 9:00 — should NOT fire
    expect(shouldFire(cron, new Date("2026-04-07T09:00:00"))).toBe(false)
    // Wednesday at 9:00 — should NOT fire
    expect(shouldFire(cron, new Date("2026-04-08T09:00:00"))).toBe(false)
    // Monday at 10:00 — wrong hour, should NOT fire
    expect(shouldFire(cron, new Date("2026-04-06T10:00:00"))).toBe(false)
  })

  it("rejects malformed multi-dash range like 1-2-3", () => {
    const cron = parseCronExpression("1-2-3 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T00:01:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T00:02:00"))).toBe(false)
  })

  it("handles list fields correctly", () => {
    const cron = parseCronExpression("0 9,10,11 * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T09:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T11:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T12:00:00"))).toBe(false)
  })
})

// ── matchesField edge cases (tested indirectly via shouldFire) ─────────────────

describe("matchesField (via shouldFire)", () => {
  // Step: */1 fires every minute
  it("*/1 in minute field fires every minute", () => {
    const cron = parseCronExpression("*/1 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T00:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T00:01:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T00:07:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T23:59:00"))).toBe(true)
  })

  // Step: */0 is invalid — step <= 0 should never fire
  it("*/0 in minute field never fires", () => {
    const cron = parseCronExpression("*/0 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T00:00:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T12:00:00"))).toBe(false)
  })

  // Step: */abc is non-numeric — NaN step should never fire
  it("*/abc in minute field never fires", () => {
    const cron = parseCronExpression("*/abc * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T00:00:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T12:30:00"))).toBe(false)
  })

  // Range: backward range 5-2 matches nothing (value can never be >= 5 AND <= 2)
  it("backward range 5-2 in minute field matches nothing", () => {
    const cron = parseCronExpression("5-2 * * * *")!
    // Minutes 0-4 are less than 5, minutes 3+ break the range
    for (const minute of [0, 1, 2, 3, 4, 5, 6, 10, 30, 59]) {
      expect(shouldFire(cron, new Date(`2026-04-08T00:${String(minute).padStart(2, "0")}:00`))).toBe(false)
    }
  })

  // Range: 0-59 matches every minute
  it("range 0-59 in minute field matches all minutes", () => {
    const cron = parseCronExpression("0-59 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:29:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:59:00"))).toBe(true)
  })

  // List: 0,15,30,45 matches those exactly
  it("list 0,15,30,45 in minute field matches those minutes only", () => {
    const cron = parseCronExpression("0,15,30,45 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:15:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:30:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:45:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:01:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T10:16:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T10:31:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T10:46:00"))).toBe(false)
  })

  // List: trailing comma — "5," splits into ["5", ""] — empty part parsed as NaN, only 5 matches
  it("list with trailing comma '5,' in minute field matches only minute 5", () => {
    const cron = parseCronExpression("5, * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T10:05:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T10:06:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(false)
  })

  // Exact non-numeric like "abc" in minute field matches nothing
  it("non-numeric exact value 'abc' in minute field matches nothing", () => {
    const cron = parseCronExpression("abc * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T10:00:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T10:30:00"))).toBe(false)
  })

  // Wildcard * fires for any value
  it("wildcard * in all fields fires for any time", () => {
    const cron = parseCronExpression("* * * * *")!
    expect(shouldFire(cron, new Date("2026-01-01T00:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-06-15T13:37:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-12-31T23:59:00"))).toBe(true)
  })
})

// ── parseCronExpression edge cases ─────────────────────────────────────────────

describe("parseCronExpression edge cases", () => {
  it("handles extra whitespace between fields", () => {
    const result = parseCronExpression("0  9  *  *  *")
    expect(result).toEqual({
      minute: "0",
      hour: "9",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })
  })

  it("handles leading and trailing whitespace", () => {
    const result = parseCronExpression("  0 9 * * *  ")
    expect(result).toEqual({
      minute: "0",
      hour: "9",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })
  })

  it("handles mixed extra whitespace (tabs and spaces)", () => {
    const result = parseCronExpression("0\t9\t*\t*\t*")
    expect(result).toEqual({
      minute: "0",
      hour: "9",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })
  })

  it("preserves special chars in fields (step, range, list)", () => {
    const result = parseCronExpression("*/5 1-6 1,15 */2 1-5")
    expect(result).toEqual({
      minute: "*/5",
      hour: "1-6",
      dayOfMonth: "1,15",
      month: "*/2",
      dayOfWeek: "1-5",
    })
  })

  it("returns null when expression is only whitespace", () => {
    expect(parseCronExpression("     ")).toBeNull()
  })
})

// ── Frontmatter / loadCronJobs parsing (tested via parseFrontmatter) ───────────
// loadCronJobs reads CRONS_DIR which is hardcoded, so we test the parsing logic
// directly using parseFrontmatter (which loadCronJobs delegates to internally).

describe("parseFrontmatter (cron file parsing)", () => {
  it("parses a complete cron file correctly", () => {
    const content = [
      "---",
      "name: morning-summary",
      "schedule: 0 9 * * *",
      "model: sonnet",
      "effort: medium",
      "timeout: 120",
      "catchup: true",
      "notify: true",
      "enabled: true",
      "---",
      "",
      "Summarize what happened yesterday.",
    ].join("\n")

    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.name).toBe("morning-summary")
    expect(frontmatter.schedule).toBe("0 9 * * *")
    expect(frontmatter.model).toBe("sonnet")
    expect(frontmatter.effort).toBe("medium")
    expect(frontmatter.timeout).toBe("120")
    expect(frontmatter.catchup).toBe("true")
    expect(frontmatter.notify).toBe("true")
    expect(frontmatter.enabled).toBe("true")
    expect(body).toBe("Summarize what happened yesterday.")
  })

  it("returns empty frontmatter when schedule is missing", () => {
    const content = [
      "---",
      "name: no-schedule",
      "model: haiku",
      "---",
      "",
      "Do something.",
    ].join("\n")

    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.schedule).toBeUndefined()
    // Confirms loadCronJobs would skip this (no schedule => parseCronFrontmatter returns null)
  })

  it("parses enabled: false correctly", () => {
    const content = [
      "---",
      "name: disabled-job",
      "schedule: */5 * * * *",
      "enabled: false",
      "---",
      "",
      "This job is disabled.",
    ].join("\n")

    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.enabled).toBe("false")
    // Confirm the sentinel: enabled !== "false" => false
    expect(frontmatter.enabled !== "false").toBe(false)
  })

  it("applies default values when optional fields are absent", () => {
    const content = [
      "---",
      "name: minimal-job",
      "schedule: 0 * * * *",
      "---",
      "",
      "Minimal prompt.",
    ].join("\n")

    const { frontmatter } = parseFrontmatter(content)
    // These fields are absent — loadCronJobs applies defaults:
    // catchup: frontmatter.catchup === "true"  => false
    // enabled: frontmatter.enabled !== "false" => true
    // notify:  frontmatter.notify === "true"   => false
    // timeout: DEFAULT_TIMEOUT (300) when frontmatter.timeout is absent
    expect(frontmatter.catchup).toBeUndefined()
    expect(frontmatter.enabled).toBeUndefined()
    expect(frontmatter.notify).toBeUndefined()
    expect(frontmatter.timeout).toBeUndefined()

    // Simulate the default derivations used in parseCronFrontmatter:
    const catchup = frontmatter.catchup === "true"
    const enabled = frontmatter.enabled !== "false"
    const notify  = frontmatter.notify === "true"
    const timeout = frontmatter.timeout ? parseInt(frontmatter.timeout, 10) : 300

    expect(catchup).toBe(false)
    expect(enabled).toBe(true)
    expect(notify).toBe(false)
    expect(timeout).toBe(300)
  })

  it("ignores lines without a colon separator", () => {
    const content = [
      "---",
      "name: edge-case",
      "schedule: * * * * *",
      "this line has no colon",
      "---",
      "",
      "Body text.",
    ].join("\n")

    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.name).toBe("edge-case")
    expect(frontmatter.schedule).toBe("* * * * *")
    expect(body).toBe("Body text.")
  })
})

// ── shouldFire pattern frequency tests ────────────────────────────────────────

describe("shouldFire pattern frequency", () => {
  // Weekly: 0 9 * * 1 — fires Monday 9am only
  it("0 9 * * 1 fires Mon 9am but not Tue 9am or Mon 10am", () => {
    const cron = parseCronExpression("0 9 * * 1")! // Monday = day 1
    // 2026-04-06 is a Monday
    expect(shouldFire(cron, new Date("2026-04-06T09:00:00"))).toBe(true)   // Mon 9:00
    expect(shouldFire(cron, new Date("2026-04-07T09:00:00"))).toBe(false)  // Tue 9:00
    expect(shouldFire(cron, new Date("2026-04-08T09:00:00"))).toBe(false)  // Wed 9:00
    expect(shouldFire(cron, new Date("2026-04-06T10:00:00"))).toBe(false)  // Mon 10:00
    expect(shouldFire(cron, new Date("2026-04-06T08:00:00"))).toBe(false)  // Mon 8:00
    // Next Monday
    expect(shouldFire(cron, new Date("2026-04-13T09:00:00"))).toBe(true)   // Next Mon 9:00
  })

  // Monthly: 0 0 1 * * — fires 1st of month at midnight only
  it("0 0 1 * * fires on 1st of month at midnight but not 2nd", () => {
    const cron = parseCronExpression("0 0 1 * *")!
    expect(shouldFire(cron, new Date("2026-04-01T00:00:00"))).toBe(true)   // 1st at 00:00
    expect(shouldFire(cron, new Date("2026-04-02T00:00:00"))).toBe(false)  // 2nd at 00:00
    expect(shouldFire(cron, new Date("2026-04-01T00:01:00"))).toBe(false)  // 1st at 00:01
    expect(shouldFire(cron, new Date("2026-04-01T01:00:00"))).toBe(false)  // 1st at 01:00
    expect(shouldFire(cron, new Date("2026-05-01T00:00:00"))).toBe(true)   // May 1st at 00:00
  })

  // Hourly at :30: 30 * * * * — fires at X:30 only
  it("30 * * * * fires at X:30 but not X:00 or X:31", () => {
    const cron = parseCronExpression("30 * * * *")!
    expect(shouldFire(cron, new Date("2026-04-08T00:30:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T09:30:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T23:30:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-08T09:00:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T09:29:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-08T09:31:00"))).toBe(false)
  })

  // Month-constrained: 0 12 * 6 * — noon every day in June only
  it("0 12 * 6 * fires only in June at noon", () => {
    const cron = parseCronExpression("0 12 * 6 *")!
    expect(shouldFire(cron, new Date("2026-06-15T12:00:00"))).toBe(true)   // June — fire
    expect(shouldFire(cron, new Date("2026-07-15T12:00:00"))).toBe(false)  // July — no
    expect(shouldFire(cron, new Date("2026-05-15T12:00:00"))).toBe(false)  // May — no
    expect(shouldFire(cron, new Date("2026-06-15T11:00:00"))).toBe(false)  // June, wrong hour
  })

  // Specific day-of-month: 0 0 15 * * — 15th of every month at midnight
  it("0 0 15 * * fires on 15th but not 14th or 16th", () => {
    const cron = parseCronExpression("0 0 15 * *")!
    expect(shouldFire(cron, new Date("2026-04-15T00:00:00"))).toBe(true)
    expect(shouldFire(cron, new Date("2026-04-14T00:00:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-04-16T00:00:00"))).toBe(false)
    expect(shouldFire(cron, new Date("2026-05-15T00:00:00"))).toBe(true)
  })
})
