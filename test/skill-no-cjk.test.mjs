/**
 * 守卫：SKILL.md 必须纯英文（不含中日韩表意文字/中文标点）。
 * emoji 不在这些区段，不会误报。防止中文引导/示例回流到技能规范。
 * 运行：node --test test/skill-no-cjk.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = join(__dirname, "..", "skills", "aicard", "SKILL.md");

// CJK 统一表意文字(含扩展A) + CJK 符号标点 + 全角字符(含中文标点，。（）「」等)
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

test("SKILL.md is English-only (no CJK characters)", () => {
  const lines = readFileSync(SKILL, "utf8").split("\n");
  const offending = [];
  lines.forEach((ln, i) => {
    if (CJK.test(ln)) offending.push(`  L${i + 1}: ${ln.trim().slice(0, 100)}`);
  });
  assert.equal(
    offending.length,
    0,
    `SKILL.md must be English-only, found CJK on ${offending.length} line(s):\n${offending.join("\n")}`
  );
});
