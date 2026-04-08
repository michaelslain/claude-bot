import { describe, it, expect } from "bun:test"
import { parseCronExpression, shouldFire } from "./cron"

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
})
