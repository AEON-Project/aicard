import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { emitOk, logInfo, logError } from "../output.mjs";

export async function clean() {
  const home = homedir();
  const removed = [];

  // 1. 用 skills CLI 移除（覆盖所有工具）
  try {
    execFileSync("npx", ["skills", "remove", "aicard", "-g", "-y"], {
      stdio: "inherit",
      timeout: 30000,
    });
    logInfo("Removed aicard skill via skills CLI");
    removed.push("skills");
  } catch {
    // skills CLI 不可用，手动清理 Claude Code
    const skillDir = join(home, ".claude", "skills", "aicard");
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
      logInfo(`Removed skill: ${skillDir}`);
      removed.push(skillDir);
    }
  }

  // 2. 卸载全局包
  try {
    execFileSync("npm", ["uninstall", "-g", "@aeon-ai-pay/aicard"], {
      stdio: "inherit",
      timeout: 30000,
    });
    logInfo("Uninstalled @aeon-ai-pay/aicard globally");
    removed.push("npm-global");
  } catch {
    logInfo("Global package not installed, skipping uninstall");
  }

  // 3. 清理 npm 缓存
  try {
    execFileSync("npm", ["cache", "clean", "--force"], {
      stdio: "inherit",
      timeout: 30000,
    });
    logInfo("npm cache cleaned");
    removed.push("npm-cache");
  } catch {
    logError("Failed to clean npm cache, skipping");
  }

  // 4. 清理 npx 缓存
  const npxCache = join(home, ".npm", "_npx");
  if (existsSync(npxCache)) {
    rmSync(npxCache, { recursive: true, force: true });
    logInfo(`Removed npx cache: ${npxCache}`);
    removed.push("npx-cache");
  }

  logInfo("\nClean complete. Reinstall with:");
  logInfo("  npm install -g @aeon-ai-pay/aicard@latest");

  emitOk("clean", { removed }, { success: true, removed });
}
