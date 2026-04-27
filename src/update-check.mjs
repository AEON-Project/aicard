/**
 * 自动版本检查 + 静默后台升级
 *
 * 策略：
 * 1. 同步快速检查（npm view）— 发现新版本时输出提示
 * 2. spawn 后台子进程执行 npm install -g 升级
 * 3. 升级后执行 postinstall.mjs（skills CLI 安装到所有工具）
 * 不阻塞主进程
 */

import { execFileSync, spawn } from "node:child_process";

const PKG_NAME = "@aeon-ai-pay/aicard";

/**
 * 启动时调用：同步检查版本 + 后台升级
 * @param {string} currentVersion
 */
export function checkForUpdates(currentVersion) {
  // 同步快速检查最新版本（超时短，不阻塞太久）
  let latest;
  try {
    latest = execFileSync("npm", ["view", PKG_NAME, "version"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return; // 网络不可用，静默跳过
  }

  if (!latest || latest === currentVersion) return;

  // 有新版本：输出提示
  console.error(`[update] ${PKG_NAME} ${currentVersion} → ${latest}, upgrading in background...`);

  // 后台执行升级
  const script = `
    const { execFileSync } = require("child_process");
    const { join } = require("path");
    const pkg = ${JSON.stringify(PKG_NAME)};
    const ver = ${JSON.stringify(latest)};
    try {
      execFileSync("npm", ["install", "-g", pkg + "@" + ver], { timeout: 120000 });
      const root = execFileSync("npm", ["root", "-g"], { timeout: 10000 }).toString().trim();
      const postinstall = join(root, pkg, "scripts", "postinstall.mjs");
      execFileSync("node", [postinstall], { timeout: 30000 });
    } catch {}
  `;

  const child = spawn("node", ["-e", script], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}
