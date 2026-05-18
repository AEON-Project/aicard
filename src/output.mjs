/**
 * 统一输出封装：envelope JSON + 分级日志
 *
 * stdout: 一行最终 JSON（machine-readable）
 *   - 成功：{ ok: true, command, version, data }
 *   - 失败：{ ok: false, command, version, error: { code, message, ...context } }
 * stderr: 进度日志（human-readable，agent 可忽略）
 *
 * --legacy-output 模式：保留旧裸字段格式，便于已按旧 JSON 解析的脚本/agent 平滑过渡。
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ERROR_CODES } from "./error-codes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
).version;

let LEGACY_MODE = false;
let QUIET_MODE = false;
let VERBOSE_MODE = false;

export function setLegacyMode(v) { LEGACY_MODE = !!v; }
export function setQuietMode(v) { QUIET_MODE = !!v; }
export function setVerboseMode(v) { VERBOSE_MODE = !!v; }
export function isLegacyMode() { return LEGACY_MODE; }
export function isVerboseMode() { return VERBOSE_MODE; }

/**
 * 输出成功结果。调用方应在调用后让函数自然返回（不要再 process.exit）。
 * @param {string} command - 命令名，如 "create" / "setup.check"
 * @param {object} data - envelope 模式下放在 data 字段
 * @param {object} [legacyShape] - legacy 模式下直接输出的旧格式对象；省略则使用 data 本身
 */
export function emitOk(command, data, legacyShape) {
  if (LEGACY_MODE) {
    console.log(JSON.stringify(legacyShape ?? data, null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, command, version: VERSION, data }));
  }
}

/**
 * 输出错误并退出（按错误码对应的 exit 码）。
 * @param {string} command
 * @param {string} code - ERROR_CODES 键名
 * @param {object} [details] - 额外字段。message 字段会覆盖默认 message；legacy 字段在 legacy 模式下完全替代输出
 */
export function emitErr(command, code, details = {}) {
  const info = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR;
  const message = details.message || info.message || code;
  const exit = info.exit;
  const { message: _m, legacy, ...rest } = details;

  if (LEGACY_MODE) {
    const legacyOut = legacy ?? { error: message, ...rest };
    console.error(JSON.stringify(legacyOut));
  } else {
    console.log(JSON.stringify({
      ok: false,
      command,
      version: VERSION,
      error: { code, message, ...rest },
    }));
  }
  process.exit(exit);
}

/** 进度日志（quiet 模式压制） */
export function logInfo(msg) {
  if (!QUIET_MODE) console.error(msg);
}

/** 详细日志（仅 verbose 模式下输出） */
export function logVerbose(msg) {
  if (VERBOSE_MODE && !QUIET_MODE) console.error(msg);
}

/** 错误日志（quiet 模式下也会输出） */
export function logError(msg) {
  console.error(msg);
}
