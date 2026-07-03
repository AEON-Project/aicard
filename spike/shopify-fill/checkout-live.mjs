#!/usr/bin/env node
/**
 * 真实提交版（会真实扣款！）：
 *   打开现成 checkout URL（或 permalink）→ 填英国收货地址 → 填真卡(env) → 提交
 *   → 遇 3DS/验证码：截图 + 轮询 ./otp.txt 回填 → 继续
 *
 * 卡从环境变量读：CARD_NUMBER / CARD_EXPIRY / CARD_CVC / CARD_NAME
 * 用法：node checkout-live.mjs --url "<checkout URL>" [--headful] [--wait-otp 240000]
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { if (!a[i].startsWith("--")) continue; const k = a[i].slice(2); const n = a[i + 1]; if (n === undefined || n.startsWith("--")) o[k] = true; else { o[k] = n; i++; } } return o; }
const args = parseArgs(process.argv.slice(2));

const cfg = {
  url: args.url,
  headful: Boolean(args.headful),
  out: args.out || "./artifacts",
  waitOtp: Number(args["wait-otp"] || 240000),
  otpFile: resolve(args["otp-file"] || "./otp.txt"),
};
const CARD = {
  number: process.env.CARD_NUMBER,
  expiry: process.env.CARD_EXPIRY,
  cvc: process.env.CARD_CVC,
  name: process.env.CARD_NAME || "Ryan Test",
};
// 用户提供的英国收货信息
const ADDR = {
  email: "bobbob@alchemypay.org",
  country: "United Kingdom",
  first: "Ryan", last: "Test",
  a1: "10 Downing Street", city: "London", zip: "SW1A 2AA",
  phone: "07700900000",
};

const t0 = Date.now();
const log = (...m) => console.error(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const report = { url: cfg.url, steps: [], fields: {}, signals: {}, outcome: null };
const step = (n, ok, d) => { report.steps.push({ n, ok, d }); log(ok ? "✓" : "✗", n, d ? JSON.stringify(d) : ""); };

const FRAME = { number: (f) => /card-fields-number|card-number/.test(f), expiry: (f) => /card-fields-expiry|card-expiry/.test(f), cvc: (f) => /verification_value|card-cvc|security/.test(f), name: (f) => /card-fields-name|cardholder/.test(f) };
const INPUT = { number: 'input[name="number"],input[autocomplete="cc-number"]', expiry: 'input[name="expiry"],input[autocomplete="cc-exp"]', cvc: 'input[name="verification_value"],input[autocomplete="cc-csc"]', name: 'input[name="name"],input[autocomplete="cc-name"]' };

async function main() {
  if (!cfg.url) { report.outcome = "error"; report.error = "缺少 --url"; return out(); }
  if (!CARD.number || !CARD.expiry || !CARD.cvc) { report.outcome = "error"; report.error = "缺少卡信息 env: CARD_NUMBER/CARD_EXPIRY/CARD_CVC"; return out(); }
  mkdirSync(resolve(cfg.out), { recursive: true });
  if (existsSync(cfg.otpFile)) rmSync(cfg.otpFile); // 清掉旧 otp

  const browser = await chromium.launch({ headless: !cfg.headful, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ locale: "en-GB", viewport: { width: 1280, height: 1600 }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const shot = async (t) => { const p = resolve(cfg.out, `live-${Date.now()}-${t}.png`); await page.screenshot({ path: p, fullPage: true }).catch(() => {}); report.signals.lastShot = p; return p; };

  const fill = async (sel, val, key) => { const el = page.locator(sel).first(); try { await el.waitFor({ state: "visible", timeout: 6000 }); await el.fill(val); report.fields[key] = "filled"; return true; } catch { report.fields[key] = "missing"; return false; } };

  try {
    log("打开 checkout:", cfg.url);
    await page.goto(cfg.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    step("goto", true, { url: page.url() });
    await shot("01-open");

    // 国家（先选，电话/邮编校验依赖它）
    const country = page.locator('select[autocomplete="country"],select[name*="countryCode" i]').first();
    if (await country.count()) { await country.selectOption({ label: ADDR.country }).catch(() => country.selectOption("GB").catch(() => {})); report.fields.country = "selected"; }

    await fill('input[type="email"],input[name="email"],input#email', ADDR.email, "email");
    await fill('input[autocomplete="given-name"],input[name="firstName"]', ADDR.first, "first");
    await fill('input[autocomplete="family-name"],input[name="lastName"]', ADDR.last, "last");
    await fill('input[autocomplete="address-line1"],input[name="address1"]', ADDR.a1, "address1");
    await fill('input[autocomplete="address-level2"],input[name="city"],input[placeholder*="City" i],input[placeholder*="城市" i]', ADDR.city, "city");
    await fill('input[autocomplete="postal-code"],input[name="postalCode"],input[name="zip"],input[placeholder*="Postal" i],input[placeholder*="邮政" i]', ADDR.zip, "zip");
    await fill('input[autocomplete="tel"],input[type="tel"]', ADDR.phone, "phone");
    step("fill-address", true, report.fields);
    await shot("02-address");

    for (const label of ["Continue to shipping", "继续", "Continue to payment", "Continue"]) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(4000); }
    }
    // 选第一个配送方式
    const ship = page.locator('input[type="radio"][name*="delivery" i],input[type="radio"][name*="shipping" i]').first();
    if (await ship.count()) { await ship.check().catch(() => {}); await page.waitForTimeout(2000); }
    await shot("03-shipping");

    // 等卡 iframe
    let found = false;
    for (let i = 0; i < 30 && !found; i++) { found = page.frames().some((f) => FRAME.number(f.url() || "") || FRAME.number(f.name() || "")); if (!found) await page.waitForTimeout(1000); }
    step("card-iframe", found);
    if (!found) { report.outcome = "no_card_iframe"; await shot("04-no-iframe"); return out(browser); }

    for (const k of ["number", "expiry", "cvc", "name"]) {
      const fr = page.frames().find((f) => FRAME[k](f.url() || "") || FRAME[k](f.name() || ""));
      report.fields[`card_${k}`] = { located: !!fr, filled: false };
      if (!fr) continue;
      try { const inp = fr.locator(INPUT[k]).first(); await inp.waitFor({ state: "visible", timeout: 8000 }); await inp.click(); await inp.type(CARD[k], { delay: 40 }); const v = await inp.inputValue().catch(() => ""); report.fields[`card_${k}`].filled = v.replace(/\s/g, "").length > 0; } catch (e) { report.fields[`card_${k}`].error = e.message.split("\n")[0]; }
    }
    await shot("05-card-filled");
    if (!["number", "expiry", "cvc"].every((k) => report.fields[`card_${k}`]?.filled)) { report.outcome = "fill_failed"; return out(browser); }

    // 提交（真实扣款）
    log("⚠️ 点击付款（真实扣款）...");
    const pay = page.locator('button#checkout-pay-button,button:has-text("Pay now"),button:has-text("立即付款"),button:has-text("付款"),button[type="submit"]').first();
    await pay.waitFor({ state: "visible", timeout: 10000 });
    await pay.click();
    step("click-pay", true);
    await page.waitForTimeout(6000);
    await shot("06-after-pay");

    // 结果判定 + 3DS/OTP 回填
    const detect = async () => {
      const u = page.url();
      if (/\/(thank_you|thank-you|orders)\b/.test(u) || await page.getByText(/thank you|order confirmed|订单已确认|感谢|谢谢/i).count().catch(() => 0)) return "success";
      const fr = page.frames();
      if (fr.some((f) => /3ds|acs|challenge|secure|authorize/i.test((f.url() || "")))) return "challenge_3ds";
      if (fr.some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.url() || ""))) return "challenge_captcha";
      const err = await page.getByText(/declined|invalid|incorrect|错误|被拒|无效|not be processed|失败/i).first().textContent().catch(() => null);
      if (err) { report.signals.formError = err.trim().slice(0, 200); return "declined"; }
      return "pending";
    };

    let outcome = await detect();
    if (outcome === "challenge_3ds" || outcome === "challenge_captcha") {
      report.signals.challenge = outcome;
      const cshot = await shot("07-challenge");
      log(`🔐 需要验证码（${outcome}）。截图: ${cshot}`);
      log(`把收到的验证码写入文件即可自动回填： echo "验证码" > ${cfg.otpFile}`);
      const deadline = Date.now() + cfg.waitOtp;
      let filledOtp = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2500);
        // 有 otp.txt 就尝试填入挑战框
        if (!filledOtp && existsSync(cfg.otpFile)) {
          const code = readFileSync(cfg.otpFile, "utf8").trim();
          if (code) {
            log(`读到验证码，尝试填入挑战页...`);
            for (const fr of page.frames()) {
              try { const inp = fr.locator('input[type="text"],input[type="tel"],input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="code" i]').first(); if (await inp.count()) { await inp.fill(code); const sub = fr.locator('button[type="submit"],button:has-text("Submit"),button:has-text("Verify"),button:has-text("确认"),button:has-text("提交")').first(); if (await sub.count()) await sub.click().catch(() => {}); filledOtp = true; break; } } catch {}
            }
            await page.waitForTimeout(4000);
          }
        }
        outcome = await detect();
        if (outcome === "success" || outcome === "declined") break;
      }
      await shot("08-after-challenge");
    }
    report.outcome = outcome;
    step("outcome", outcome === "success", { outcome, ...report.signals });
    return out(browser);
  } catch (e) { report.outcome = "error"; report.error = e.message; await shot("99-error").catch(() => {}); return out(browser); }
}

async function out(browser) { if (browser) await browser.close().catch(() => {}); process.stdout.write(JSON.stringify(report, null, 2) + "\n"); }
main();
