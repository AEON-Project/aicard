#!/usr/bin/env node
/**
 * Spike: Shopify 收银台自动填卡（确定性 Playwright，无 LLM）
 *
 * 目的：量化整条闭环里最不确定的一环 —— Playwright 能不能稳定地把卡信息
 *       注入到 Shopify 托管的【跨域 iframe】卡字段里，并观测：
 *         1) 每个卡字段是否成功定位 + 填入（过不过 isTrusted 校验）
 *         2) 提交后是否触发 3DS / OTP 挑战（headless 下无法人工介入 → 必然中断）
 *         3) 是否撞上验证码 / 机器人拦截
 *
 * 这是 spike，不是产品代码：重在【观测与取证】，全程详细日志 + 截图 + JSON 报告。
 *
 * 用法：
 *   node fill-checkout.mjs \
 *     --url "https://某店/checkouts/..."   # Shopify 收银台/continue_url
 *     --number 1 --expiry "12/34" --cvc 123 --name "Test Buyer" \
 *     [--headful] [--out ./artifacts] [--timeout 45000]
 *
 * Phase 1（现在就能跑，不需要真卡/不需要 UCP 店铺）：
 *   任意真实 Shopify 店铺加购 → 进到收银台付款页 → 用 Shopify Bogus Gateway 测试卡：
 *     卡号填 "1"（成功）/ "2"（失败）/ "3"（异常），有效期任意未来月份，CVC 任意 3 位。
 *   若店铺用真实网关，用网关的测试卡（如 Stripe 4242 4242 4242 4242）。
 *
 * 退出码：0=填卡并提交成功抵达结果页  1=用户/参数错误  2=超时  3=被 3DS/验证码中断  4=内部错误
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

// ---------- 极简参数解析（零额外依赖）----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true; // 布尔 flag
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const cfg = {
  url: args.url,
  // 卡信息优先从环境变量读，避免真卡号进入 shell history：CARD_NUMBER / CARD_EXPIRY / CARD_CVC / CARD_NAME
  number: (args.number != null ? String(args.number) : process.env.CARD_NUMBER) || undefined,
  expiry: args.expiry || process.env.CARD_EXPIRY, // "MM/YY" 或 "MM / YY"
  cvc: (args.cvc != null ? String(args.cvc) : process.env.CARD_CVC) || undefined,
  name: args.name || process.env.CARD_NAME || "Test Buyer",
  headful: Boolean(args.headful),
  out: args.out || "./artifacts",
  timeout: Number(args.timeout || 45000),
  fromAicard: Boolean(args["from-aicard"]),
  amount: args.amount,
  // 遇 3DS/验证码时，保持页面打开、轮询等待用户完成二次输入的最长时长(ms)。0=不等待，直接判失败。
  wait3ds: Number(args["wait-3ds"] || 0),
  // 只填卡不点提交。在【第三方真实店铺】测 iframe 注入时务必开启，避免给商家生成订单/触发风控。
  noSubmit: Boolean(args["no-submit"]),
};

// ---------- 日志工具 ----------
const t0 = Date.now();
const log = (...m) => console.error(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const report = {
  url: cfg.url,
  startedAt: new Date().toISOString(),
  steps: [],
  fields: {}, // { number: {located, filled}, expiry: {...}, cvc: {...}, name: {...} }
  outcome: null, // success | interrupted_3ds | interrupted_captcha | submit_failed | fill_failed | timeout | error
  signals: {},
  artifacts: [],
};
const step = (name, ok, detail) => {
  report.steps.push({ name, ok, detail, at: ((Date.now() - t0) / 1000).toFixed(1) });
  log(ok ? "✓" : "✗", name, detail ? `— ${JSON.stringify(detail)}` : "");
};

function die(code, outcome, msg) {
  report.outcome = outcome;
  report.error = msg;
  finish(code);
}

function finish(code) {
  report.finishedAt = new Date().toISOString();
  report.durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  // envelope 一行 JSON 到 stdout，便于上层脚本消费
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(code);
}

// ---------- 可选：从 aicard 取卡（会命中脱敏阻断点，用于演示）----------
function loadCardFromAicard(amount) {
  log("尝试从 aicard 取卡（注意：CLI 输出默认脱敏，CVV/有效期会缺失）...");
  const r = spawnSync("aicard", ["--quiet", "create", "--amount", String(amount || 5), "--poll"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    die(1, "error", `aicard create 失败 (exit ${r.status}): ${r.stderr?.slice(-400)}`);
  }
  let env;
  try {
    env = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch (e) {
    die(4, "error", `解析 aicard 输出失败: ${e.message}`);
  }
  if (!env.ok) die(1, "error", `aicard 返回错误: ${env.error?.code}`);
  // 递归找卡面字段
  const flat = JSON.stringify(env.data);
  const number = (flat.match(/"card(?:Number|No)"\s*:\s*"([^"]+)"/i) || [])[1];
  const hasFull = number && !number.includes("•") && number.replace(/\D/g, "").length >= 12;
  if (!hasFull) {
    die(
      1,
      "error",
      "aicard CLI 输出已脱敏，拿不到完整卡号/CVV/有效期。需服务端提供受保护的完整卡面接口后再走 --from-aicard。Phase 1 请用 --number/--expiry/--cvc 传测试卡。"
    );
  }
  return { number, /* expiry/cvc 同样缺失 */ };
}

// ---------- Shopify 卡字段定位（多策略，语言无关）----------
/**
 * Shopify 收银台把每个卡字段放进【独立的跨域 iframe】，iframe.name 形如：
 *   card-fields-number-<id> / card-fields-expiry-<id>
 *   card-fields-verification_value-<id> / card-fields-name-<id>
 * iframe 内 input 的 name 分别是 number / expiry / verification_value / name。
 * 兼容旧版/多语言：再退化到按 input 的 autocomplete / placeholder 猜。
 */
const FIELD_MATCHERS = {
  number: {
    frameName: (n) => n.includes("card-fields-number") || n.includes("card-number"),
    input: 'input[name="number"], input[autocomplete="cc-number"], input#number',
  },
  expiry: {
    frameName: (n) => n.includes("card-fields-expiry") || n.includes("card-expiry"),
    input: 'input[name="expiry"], input[autocomplete="cc-exp"], input#expiry',
  },
  cvc: {
    frameName: (n) => n.includes("verification_value") || n.includes("card-cvc") || n.includes("security"),
    input: 'input[name="verification_value"], input[autocomplete="cc-csc"], input#verification_value',
  },
  name: {
    frameName: (n) => /card-fields-name|card-holder|cardholder/.test(n),
    input: 'input[name="name"], input[autocomplete="cc-name"], input#name',
  },
};

async function waitForCardFrames(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    const hasNumber = frames.some((f) => FIELD_MATCHERS.number.frameName(f.name() || "") || FIELD_MATCHERS.number.frameName(f.url() || ""));
    if (hasNumber) return frames;
    await page.waitForTimeout(500);
  }
  return null;
}

function findFrame(page, matcher) {
  return page.frames().find((f) => matcher.frameName(f.name() || "") || matcher.frameName(f.url() || ""));
}

async function fillField(page, key, value) {
  const m = FIELD_MATCHERS[key];
  report.fields[key] = { located: false, filled: false };
  const frame = findFrame(page, m);
  if (!frame) {
    step(`locate:${key}`, false, "未找到对应 iframe");
    return false;
  }
  report.fields[key].located = true;
  try {
    const input = frame.locator(m.input).first();
    await input.waitFor({ state: "visible", timeout: 8000 });
    await input.click();
    await input.fill(""); // 清空
    await input.type(String(value), { delay: 30 }); // 逐字符输入，更像人类，尽量过 isTrusted
    const got = await input.inputValue().catch(() => "");
    const ok = got.replace(/\s/g, "").length > 0;
    report.fields[key].filled = ok;
    report.fields[key].readback = got ? `len=${got.length}` : "empty";
    step(`fill:${key}`, ok, { readbackLen: got.length });
    return ok;
  } catch (e) {
    report.fields[key].error = e.message;
    step(`fill:${key}`, false, { error: e.message.split("\n")[0] });
    return false;
  }
}

// ---------- 提交后结果判定 ----------
async function detectOutcome(page) {
  const url = page.url();
  report.signals.finalUrl = url;

  // 成功：抵达感谢页 / 订单页
  if (/\/(thank_you|thank-you|orders)\b/.test(url) || (await page.getByText(/thank you|order confirmed|订单已确认|感谢/i).count().catch(() => 0))) {
    return "success";
  }
  // 3DS / 银行挑战：出现 challenge / acs / 3ds iframe，或 Stripe 3DS
  const frames = page.frames();
  const has3ds = frames.some((f) => /3ds|acs|challenge|secure|stripe.*authorize/i.test((f.url() || "") + (f.name() || "")));
  if (has3ds) {
    report.signals.threeDS = frames.filter((f) => /3ds|acs|challenge/i.test((f.url() || ""))).map((f) => f.url());
    return "interrupted_3ds";
  }
  // 验证码：recaptcha / hcaptcha / turnstile
  const hasCaptcha = frames.some((f) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(f.url() || ""));
  if (hasCaptcha) {
    report.signals.captcha = frames.filter((f) => /recaptcha|hcaptcha|turnstile/i.test(f.url() || "")).map((f) => f.url());
    return "interrupted_captcha";
  }
  // 表单报错（卡被拒/信息错误）
  const errText = await page
    .getByText(/declined|invalid|incorrect|错误|被拒|无效|not be processed/i)
    .first()
    .textContent()
    .catch(() => null);
  if (errText) {
    report.signals.formError = errText.trim().slice(0, 200);
    return "submit_failed";
  }
  return "unknown";
}

// ---------- 主流程 ----------
async function main() {
  if (!cfg.url) die(1, "error", "缺少 --url（Shopify 收银台 / continue_url）");

  if (cfg.fromAicard) {
    const card = loadCardFromAicard(cfg.amount); // 大概率在这里因脱敏而退出
    cfg.number = card.number;
  }
  if (!cfg.number || !cfg.expiry || !cfg.cvc) {
    die(1, "error", "缺少卡信息：--number --expiry --cvc（Phase 1 用测试卡）");
  }

  mkdirSync(pathResolve(cfg.out), { recursive: true });
  const shot = async (tag) => {
    const p = pathResolve(cfg.out, `${Date.now()}-${tag}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
    report.artifacts.push(p);
    return p;
  };

  log(`启动 Chromium（${cfg.headful ? "headful 可视" : "headless"}）...`);
  const browser = await chromium.launch({
    headless: !cfg.headful,
    args: ["--disable-blink-features=AutomationControlled"], // 基础反自动化标记
  });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 1400 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  // 抹掉 navigator.webdriver
  await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeout);

  try {
    log(`打开收银台: ${cfg.url}`);
    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: cfg.timeout });
    step("goto", true, { url: page.url() });
    await shot("01-loaded");

    log("等待卡字段 iframe 出现...");
    const frames = await waitForCardFrames(page, cfg.timeout);
    if (!frames) {
      await shot("02-no-card-frames");
      die(2, "timeout", "超时：未检测到 Shopify 卡字段 iframe（可能页面不是付款页/已重定向/被拦截）");
    }
    step("card-frames-detected", true, {
      frameNames: page.frames().map((f) => f.name()).filter(Boolean).slice(0, 12),
    });

    // 依次填卡（name 可能不存在，不算致命）
    await fillField(page, "number", cfg.number);
    await fillField(page, "expiry", cfg.expiry);
    await fillField(page, "cvc", cfg.cvc);
    await fillField(page, "name", cfg.name);
    await shot("03-filled");

    const coreFilled = ["number", "expiry", "cvc"].every((k) => report.fields[k]?.filled);
    if (!coreFilled) {
      die(3, "fill_failed", "核心卡字段未能全部填入（很可能是 iframe isTrusted/跨域拦截 → 这是本 spike 最想量的风险点）");
    }
    step("core-fields-filled", true);

    if (cfg.noSubmit) {
      report.outcome = "filled_no_submit";
      step("no-submit", true, "只填卡不提交（第三方店铺安全模式）；iframe 注入已验证");
      await shot("04-filled-no-submit");
      finish(0);
    }

    // 定位并点击支付按钮（多语言/多版本）
    log("查找并点击支付按钮...");
    const payBtn = page
      .locator('button#checkout-pay-button, button[type="submit"]:has-text("Pay"), button:has-text("Pay now"), button:has-text("立即付款"), button:has-text("Complete order")')
      .first();
    await payBtn.waitFor({ state: "visible", timeout: 10000 });
    await payBtn.click();
    step("click-pay", true);

    // 等待结果（URL 变化 / 出现挑战 / 出现确认）
    log("等待支付结果...");
    await page.waitForTimeout(4000);
    await page
      .waitForLoadState("networkidle", { timeout: cfg.timeout })
      .catch(() => log("networkidle 超时（可能仍在处理），继续判定当前状态"));
    await shot("04-after-submit");

    let outcome = await detectOutcome(page);
    report.outcome = outcome;
    step(`outcome`, outcome === "success", { outcome, ...report.signals });

    // 3DS/验证码降级：允许二次用户输入。保持页面打开，轮询等待挑战完成。
    // 注意：headless 下用户无法输入 —— 真要人工介入必须 --headful（或产品侧把挑战页暴露给用户）。
    if ((outcome === "interrupted_3ds" || outcome === "interrupted_captcha") && cfg.wait3ds > 0) {
      if (!cfg.headful) {
        log("⚠️ 检测到挑战但当前是 headless，用户无法输入。生产中此处应把控制权/挑战页交给用户界面。");
      }
      report.challenge = { type: outcome, waitedFor: cfg.wait3ds };
      log(`检测到 ${outcome}，等待用户完成二次输入（最多 ${cfg.wait3ds / 1000}s）...`);
      await shot("05-challenge");
      const deadline = Date.now() + cfg.wait3ds;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        outcome = await detectOutcome(page);
        if (outcome === "success" || outcome === "submit_failed") {
          report.challenge.resolvedAs = outcome;
          step("challenge-resolved", outcome === "success", { outcome });
          break;
        }
      }
      report.outcome = outcome;
      await shot("06-after-challenge");
    }

    if (outcome === "success") finish(0);
    if (outcome === "interrupted_3ds" || outcome === "interrupted_captcha") finish(3);
    finish(1);
  } catch (e) {
    await shot("99-error").catch(() => {});
    die(4, "error", e.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => die(4, "error", e.message));
