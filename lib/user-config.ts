import { readFile, writeFile, mkdir } from "fs/promises"
import { CONFIG_FILE, BOT_DIR, DEFAULT_USER_CONFIG, type UserConfig } from "./config.ts"

/**
 * Load user config from ~/.claude-bot/config.json.
 * Returns defaults for missing fields.
 */
export async function loadUserConfig(): Promise<Required<UserConfig>> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8")
    const parsed = JSON.parse(raw) as UserConfig
    return { ...DEFAULT_USER_CONFIG, ...parsed }
  } catch {
    return DEFAULT_USER_CONFIG
  }
}

/**
 * Save user config to ~/.claude-bot/config.json.
 */
export async function saveUserConfig(config: UserConfig): Promise<void> {
  await mkdir(BOT_DIR, { recursive: true })
  const current = await loadUserConfig()
  const merged = { ...current, ...config }
  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8")
}
