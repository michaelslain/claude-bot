import { join } from "path"
import { readFile, writeFile, mkdir, rename } from "fs/promises"
import { BOT_DIR } from "./config.ts"
import { getDeviceId, getDeviceLabel } from "./device.ts"

/**
 * Multi-device ownership coordination (SHARED INTEGRATION CONTRACT v1).
 *
 * State files under <home> (default ~/.claude-bot):
 *  - devices.json: { "<deviceId>": { label, lastSeenISO }, ... }
 *      Every daemon UPSERTS its own entry each tick (heartbeat), even when idle.
 *  - owner.json:   { ownerDeviceId, ownerLabel, updatedAt }
 *      ABSENT file = UNCLAIMED => legacy behavior (daemon runs normally).
 *
 * isOwner(): owner.json absent => true; else ownerDeviceId === thisDeviceId.
 *
 * All functions accept an optional `home` dir for test injection; production
 * callers omit it and use BOT_DIR.
 */

export interface DeviceEntry {
  label: string
  lastSeenISO: string
}

export type DevicesFile = Record<string, DeviceEntry>

export interface Owner {
  ownerDeviceId: string
  ownerLabel: string
  updatedAt: string
}

export interface DeviceListEntry {
  deviceId: string
  label: string
  lastSeenISO: string
  isOwner: boolean
  isThis: boolean
}

export interface DeviceInfo {
  deviceId: string
  label: string
  isOwner: boolean
  owner: Owner | null
}

function devicesPath(home: string): string {
  return join(home, "devices.json")
}

function ownerPath(home: string): string {
  return join(home, "owner.json")
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8")
  await rename(tmp, path)
}

async function readDevices(home: string): Promise<DevicesFile> {
  try {
    const raw = await readFile(devicesPath(home), "utf-8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as DevicesFile) : {}
  } catch {
    return {}
  }
}

/**
 * Read owner.json. Returns null when the file is absent (UNCLAIMED) or
 * unreadable/malformed — both cases mean "no explicit owner".
 */
export async function getOwner(home: string = BOT_DIR): Promise<Owner | null> {
  try {
    const raw = await readFile(ownerPath(home), "utf-8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && typeof parsed.ownerDeviceId === "string") {
      return parsed as Owner
    }
    return null
  } catch {
    return null
  }
}

/**
 * Upsert this device's entry into devices.json with a fresh lastSeenISO.
 * Called every tick — the device stays selectable even when idle / not owner.
 */
export async function heartbeatDevice(home: string = BOT_DIR): Promise<void> {
  const [deviceId, devices] = await Promise.all([getDeviceId(home), readDevices(home)])
  devices[deviceId] = {
    label: getDeviceLabel(),
    lastSeenISO: new Date().toISOString(),
  }
  await writeJsonAtomic(devicesPath(home), devices)
}

/**
 * List all known devices with ownership/self flags. Matches the device_list
 * MCP return shape exactly.
 */
export async function listDevices(
  home: string = BOT_DIR
): Promise<{ devices: DeviceListEntry[]; ownerDeviceId: string | null }> {
  const [devices, owner, thisId] = await Promise.all([
    readDevices(home),
    getOwner(home),
    getDeviceId(home),
  ])
  const ownerDeviceId = owner?.ownerDeviceId ?? null
  const list: DeviceListEntry[] = Object.entries(devices).map(([deviceId, entry]) => ({
    deviceId,
    label: entry.label,
    lastSeenISO: entry.lastSeenISO,
    isOwner: ownerDeviceId === deviceId,
    isThis: thisId === deviceId,
  }))
  return { devices: list, ownerDeviceId }
}

/**
 * True when this device may run normally:
 *  - owner.json absent (UNCLAIMED) => true (legacy / single-device behavior)
 *  - else ownerDeviceId === thisDeviceId
 */
export async function isOwner(home: string = BOT_DIR): Promise<boolean> {
  const owner = await getOwner(home)
  if (!owner) return true
  const thisId = await getDeviceId(home)
  return owner.ownerDeviceId === thisId
}

/**
 * Full device identity + ownership view. Matches the device_info MCP shape.
 */
export async function deviceInfo(home: string = BOT_DIR): Promise<DeviceInfo> {
  const [deviceId, owner] = await Promise.all([getDeviceId(home), getOwner(home)])
  const ownedByThis = owner ? owner.ownerDeviceId === deviceId : true
  return {
    deviceId,
    label: getDeviceLabel(),
    isOwner: ownedByThis,
    owner,
  }
}

/**
 * Claim ownership for `deviceId`. Rejects if the device is not present in
 * devices.json (a device must heartbeat before it can be made owner). Writes
 * owner.json byte-compatibly with what Bismuth reads, then returns the updated
 * device_info view.
 */
export async function setOwnerDevice(
  deviceId: string,
  home: string = BOT_DIR
): Promise<DeviceInfo> {
  const devices = await readDevices(home)
  const entry = devices[deviceId]
  if (!entry) {
    throw new Error(`Device "${deviceId}" is not present in devices.json — cannot set as owner`)
  }
  const owner: Owner = {
    ownerDeviceId: deviceId,
    ownerLabel: entry.label,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(ownerPath(home), owner)
  return deviceInfo(home)
}
