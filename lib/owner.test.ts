import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile, writeFile } from "fs/promises"
import { tmpdir, hostname } from "os"
import { join } from "path"
import { getDeviceId } from "./device.ts"
import {
  heartbeatDevice,
  listDevices,
  getOwner,
  setOwnerDevice,
  isOwner,
  deviceInfo,
  type Owner,
} from "./owner.ts"

let home: string

async function writeOwner(owner: Owner): Promise<void> {
  await writeFile(join(home, "owner.json"), JSON.stringify(owner, null, 2), "utf-8")
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-bot-owner-test-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("isOwner", () => {
  it("unclaimed (no owner.json) => true (legacy behavior)", async () => {
    expect(await isOwner(home)).toBe(true)
  })

  it("claimed by this device => true", async () => {
    const thisId = await getDeviceId(home)
    await writeOwner({ ownerDeviceId: thisId, ownerLabel: hostname(), updatedAt: new Date().toISOString() })
    expect(await isOwner(home)).toBe(true)
  })

  it("claimed by another device => false", async () => {
    await getDeviceId(home) // establish this device's id
    await writeOwner({ ownerDeviceId: "some-other-device", ownerLabel: "other-box", updatedAt: new Date().toISOString() })
    expect(await isOwner(home)).toBe(false)
  })
})

describe("getOwner", () => {
  it("returns null when owner.json is absent", async () => {
    expect(await getOwner(home)).toBeNull()
  })

  it("returns the owner record when present", async () => {
    const owner: Owner = { ownerDeviceId: "abc", ownerLabel: "box", updatedAt: "2026-06-05T00:00:00.000Z" }
    await writeOwner(owner)
    expect(await getOwner(home)).toEqual(owner)
  })
})

describe("heartbeatDevice", () => {
  it("upserts this device into devices.json with a lastSeenISO", async () => {
    await heartbeatDevice(home)
    const thisId = await getDeviceId(home)

    const raw = JSON.parse(await readFile(join(home, "devices.json"), "utf-8"))
    expect(raw[thisId]).toBeDefined()
    expect(raw[thisId].label).toBe(hostname())
    expect(typeof raw[thisId].lastSeenISO).toBe("string")
    expect(new Date(raw[thisId].lastSeenISO).toString()).not.toBe("Invalid Date")
  })

  it("updates lastSeenISO on repeated heartbeats (upsert, not duplicate)", async () => {
    await heartbeatDevice(home)
    const thisId = await getDeviceId(home)
    const first = JSON.parse(await readFile(join(home, "devices.json"), "utf-8"))[thisId].lastSeenISO

    await new Promise((r) => setTimeout(r, 5))
    await heartbeatDevice(home)
    const after = JSON.parse(await readFile(join(home, "devices.json"), "utf-8"))

    expect(Object.keys(after)).toEqual([thisId]) // still exactly one entry
    expect(new Date(after[thisId].lastSeenISO).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime())
  })

  it("heartbeats even when not the owner (stays selectable)", async () => {
    await getDeviceId(home)
    await writeOwner({ ownerDeviceId: "other", ownerLabel: "other", updatedAt: new Date().toISOString() })
    expect(await isOwner(home)).toBe(false)

    await heartbeatDevice(home)
    const thisId = await getDeviceId(home)
    const raw = JSON.parse(await readFile(join(home, "devices.json"), "utf-8"))
    expect(raw[thisId]).toBeDefined()
  })
})

describe("listDevices", () => {
  it("returns all devices with isOwner/isThis flags and ownerDeviceId", async () => {
    const thisId = await getDeviceId(home)
    // Seed a second device directly in devices.json
    await writeFile(
      join(home, "devices.json"),
      JSON.stringify({
        [thisId]: { label: hostname(), lastSeenISO: "2026-06-05T00:00:00.000Z" },
        "other-id": { label: "other-box", lastSeenISO: "2026-06-04T00:00:00.000Z" },
      }),
      "utf-8"
    )
    await writeOwner({ ownerDeviceId: "other-id", ownerLabel: "other-box", updatedAt: new Date().toISOString() })

    const { devices, ownerDeviceId } = await listDevices(home)
    expect(ownerDeviceId).toBe("other-id")

    const self = devices.find((d) => d.deviceId === thisId)!
    const other = devices.find((d) => d.deviceId === "other-id")!

    expect(self.isThis).toBe(true)
    expect(self.isOwner).toBe(false)
    expect(other.isThis).toBe(false)
    expect(other.isOwner).toBe(true)
    expect(other.label).toBe("other-box")
  })

  it("ownerDeviceId is null when unclaimed", async () => {
    await heartbeatDevice(home)
    const { ownerDeviceId } = await listDevices(home)
    expect(ownerDeviceId).toBeNull()
  })
})

describe("setOwnerDevice", () => {
  it("rejects a deviceId not present in devices.json", async () => {
    await heartbeatDevice(home) // only this device present
    await expect(setOwnerDevice("ghost-device", home)).rejects.toThrow(/not present/)
    // owner.json must not have been written
    expect(await getOwner(home)).toBeNull()
  })

  it("writes owner.json and round-trips through getOwner/device_info", async () => {
    await heartbeatDevice(home)
    const thisId = await getDeviceId(home)

    const info = await setOwnerDevice(thisId, home)
    expect(info.deviceId).toBe(thisId)
    expect(info.isOwner).toBe(true)
    expect(info.owner?.ownerDeviceId).toBe(thisId)
    expect(info.owner?.ownerLabel).toBe(hostname())

    const persisted = await getOwner(home)
    expect(persisted?.ownerDeviceId).toBe(thisId)
    expect(typeof persisted?.updatedAt).toBe("string")
  })

  it("setting another known device as owner makes this device non-owner", async () => {
    const thisId = await getDeviceId(home)
    await writeFile(
      join(home, "devices.json"),
      JSON.stringify({
        [thisId]: { label: hostname(), lastSeenISO: new Date().toISOString() },
        "other-id": { label: "other-box", lastSeenISO: new Date().toISOString() },
      }),
      "utf-8"
    )

    const info = await setOwnerDevice("other-id", home)
    expect(info.isOwner).toBe(false)
    expect(info.owner?.ownerLabel).toBe("other-box")
    expect(await isOwner(home)).toBe(false)
  })
})

describe("deviceInfo", () => {
  it("reports unclaimed install as owner with null owner record", async () => {
    const info = await deviceInfo(home)
    expect(info.isOwner).toBe(true)
    expect(info.owner).toBeNull()
    expect(info.label).toBe(hostname())
    expect(info.deviceId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
