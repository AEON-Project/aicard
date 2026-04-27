#!/usr/bin/env node

/**
 * npm install -g 后自动安装 skill 到所有已检测的 AI 编码工具
 *
 * 优先使用 `npx skills add` (Vercel Labs) 统一安装到所有工具
 * 失败时 fallback 到手动复制 Claude Code skills 目录
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillSrc = join(__dirname, '..', 'skills', 'aicard');

if (!existsSync(skillSrc)) {
  process.exit(0);
}

// 尝试用 skills CLI 安装到所有工具
try {
  execFileSync('npx', ['skills', 'add', skillSrc, '-g', '-y', '--copy'], {
    stdio: 'inherit',
    timeout: 30000,
    cwd: join(__dirname, '..'),
  });
  console.log('✔ aicard skill installed via skills CLI (all detected tools)');
  process.exit(0);
} catch {
  // skills CLI 不可用或失败，fallback
}

// Fallback: 手动复制到 Claude Code
const dest = join(homedir(), '.claude', 'skills', 'aicard');
mkdirSync(dirname(dest), { recursive: true });
cpSync(skillSrc, dest, { recursive: true, force: true });
console.log(`✔ aicard skill installed to ${dest} (fallback)`);
