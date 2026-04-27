import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

export async function clean() {
  const home = homedir();

  // 1. 用 skills CLI 移除（覆盖所有工具）
  try {
    execFileSync("npx", ["skills", "remove", "aicard", "-g", "-y"], {
      stdio: "inherit",
      timeout: 30000,
    });
    console.error("Removed aicard skill via skills CLI");
  } catch {
    // skills CLI 不可用，手动清理 Claude Code
    const skillDir = join(home, ".claude", "skills", "aicard");
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
      console.error("Removed skill:", skillDir);
    }
  }

  // 2. 卸载全局包
  try {
    execFileSync("npm", ["uninstall", "-g", "@aeon-ai-pay/aicard"], {
      stdio: "inherit",
      timeout: 30000,
    });
    console.error("Uninstalled @aeon-ai-pay/aicard globally");
  } catch {
    console.error("Global package not installed, skipping uninstall");
  }

  // 3. 清理 npm 缓存
  try {
    execFileSync("npm", ["cache", "clean", "--force"], {
      stdio: "inherit",
      timeout: 30000,
    });
    console.error("npm cache cleaned");
  } catch {
    console.error("Failed to clean npm cache, skipping");
  }

  // 4. 清理 npx 缓存
  const npxCache = join(home, ".npm", "_npx");
  if (existsSync(npxCache)) {
    rmSync(npxCache, { recursive: true, force: true });
    console.error("Removed npx cache:", npxCache);
  }

  console.error("\nClean complete. Reinstall with:");
  console.error("  npm install -g @aeon-ai-pay/aicard@latest");
}
