import { describe, it, expect } from "bun:test"
import { getInstallStatus, ensureInstalled, type InstallProbes } from "./install.ts"

// All probes are injected, so no test touches the real launchd / pid / FS.
const probes = (over: Partial<InstallProbes>): InstallProbes => ({
  isLoaded: () => false,
  configExists: () => false,
  pidAlive: () => false,
  ...over,
})

describe("getInstallStatus", () => {
  it("is installed when the config file exists", () => {
    const s = getInstallStatus(probes({ configExists: () => true }))
    expect(s.installed).toBe(true)
    expect(s.running).toBe(false)
  })

  it("is installed when the service is loaded even without a config file", () => {
    const s = getInstallStatus(probes({ isLoaded: () => true, pidAlive: () => true }))
    expect(s.installed).toBe(true)
    expect(s.running).toBe(true)
  })

  it("is not installed when neither the config nor the loaded service is present", () => {
    const s = getInstallStatus(probes({}))
    expect(s.installed).toBe(false)
    expect(s.running).toBe(false)
  })

  it("reports the daemon label, home, and plist path", () => {
    const s = getInstallStatus(probes({}))
    expect(s.daemonLabel.length).toBeGreaterThan(0)
    expect(s.home.length).toBeGreaterThan(0)
    expect(s.plistPath.length).toBeGreaterThan(0)
  })
})

describe("ensureInstalled", () => {
  const installed = { isLoaded: () => true, configExists: () => true, pidAlive: () => true }

  it("adopts an existing install with NO install side effects", async () => {
    let installRan = false
    const r = await ensureInstalled({
      probes: installed,
      performInstall: async () => { installRan = true; return { ok: true } },
    })
    expect(r.action).toBe("adopted")
    expect(installRan).toBe(false)
  })

  it("reports would-install on a dry run when not installed", async () => {
    let installRan = false
    const r = await ensureInstalled({
      probes: probes({}),
      dryRun: true,
      performInstall: async () => { installRan = true; return { ok: true } },
    })
    expect(r.action).toBe("would-install")
    expect(installRan).toBe(false)
  })

  it("installs (mocked) when not installed, then reports installed", async () => {
    let installed = false
    const r = await ensureInstalled({
      probes: { isLoaded: () => installed, configExists: () => installed, pidAlive: () => installed },
      performInstall: async () => { installed = true; return { ok: true } },
    })
    expect(r.action).toBe("installed")
    expect(r.status.installed).toBe(true)
  })

  it("throws when the install fails", async () => {
    await expect(
      ensureInstalled({ probes: probes({}), performInstall: async () => ({ ok: false, error: "boom" }) }),
    ).rejects.toThrow("boom")
  })
})
