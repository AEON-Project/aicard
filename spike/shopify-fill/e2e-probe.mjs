#!/usr/bin/env node
/**
 * 一次性端到端探针（安全模式）：
 *   cart permalink → Shopify 收银台 → 填假地址 → 到付款页 → 测试卡填 iframe → 只填不提交
 * 目的：用真实公开 Shopify 店，实测 Playwright 能否把卡填进跨域 iframe。
 * 不提交、不下单、不用真卡。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const SHOP = process.env.SHOP || "deathwishcoffee.com";
const VARIANT = process.env.VARIANT || "42239587811383"; // $5 LED Arm Band
const OUT = resolve("./artifacts");
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...m) => console.error(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const report = { shop: SHOP, variant: VARIANT, steps: [], fields: {}, signals: {}, outcome: null };
const step = (n, ok, d) => { report.steps.push({ n, ok, d }); log(ok ? "✓" : "✗", n, d ? JSON.stringify(d) : ""); };

// 测试卡（真实网关会在提交时拒收；我们不提交，只验证填入）
const CARD = { number: "4242424242424242", expiry: "12 / 34", cvc: "123", name: "Test Buyer" };
// 假美国地址（不提交，不会真发货）
const ADDR = { email: "probe@example.com", first: "Test", last: "Buyer", a1: "123 Main St",
  city: "New York", zip: "10001", phone: "2125550123" };

const FRAME = {
  number: (f) => /card-fields-number|card-number/.test(f),
  expiry: (f) => /card-fields-expiry|card-expiry/.test(f),
  cvc: (f) => /verification_value|card-cvc|security/.test(f),
  name: (f) => /card-fields-name|cardholder/.test(f),
};
const INPUT = {
  number: 'input[name="number"],input[autocomplete="cc-number"]',
  expiry: 'input[name="expiry"],input[autocomplete="cc-exp"]',
  cvc: 'input[name="verification_value"],input[autocomplete="cc-csc"]',
  name: 'input[name="name"],input[autocomplete="cc-name"]',
};

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 1600 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const shot = async (tag) => { const p = resolve(OUT, `e2e-${Date.now()}-${tag}.png`); await page.screenshot({ path: p, fullPage: true }).catch(() => {}); return p; };

  try {
    const url = `https://${SHOP}/cart/${VARIANT}:1`;
    log("打开 cart permalink:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    step("goto-cart", true, { landedOn: page.url() });
    await page.waitForTimeout(3000);
    await shot("01-landing");

    // 若停在购物车页，找“结账”按钮
    if (!/\/checkouts?\//.test(page.url())) {
      const co = page.locator('button[name="checkout"],a[href*="checkout"],button:has-text("Check out"),button:has-text("Checkout")').first();
      if (await co.count()) { await co.click().catch(() => {}); await page.waitForTimeout(4000); }
      step("to-checkout", /\/checkouts?\//.test(page.url()), { url: page.url() });
    }
    await shot("02-checkout");

    // 填联系 + 地址（用 autocomplete 属性，稳定于随机 name）
    const fill = async (sel, val, key) => {
      const el = page.locator(sel).first();
      try { await el.waitFor({ state: "visible", timeout: 6000 }); await el.fill(val); report.fields[key] = "filled"; return true; }
      catch { report.fields[key] = "missing"; return false; }
    };
    await fill('input[type="email"],input[name="email"],input#email', ADDR.email, "email");
    await fill('input[autocomplete="given-name"],input[name="firstName"]', ADDR.first, "first");
    await fill('input[autocomplete="family-name"],input[name="lastName"]', ADDR.last, "last");
    await fill('input[autocomplete="address-line1"],input[name="address1"]', ADDR.a1, "address1");
    await fill('input[autocomplete="address-level2"],input[name="city"],input[placeholder*="City" i]', ADDR.city, "city");
    await fill('input[autocomplete="postal-code"],input[name="postalCode"],input[name="zip"],input[placeholder*="ZIP" i],input[placeholder*="Postal" i]', ADDR.zip, "zip");
    await fill('input[autocomplete="tel"]', ADDR.phone, "phone");
    // 州（美国地址常必填）
    const st = page.locator('select[autocomplete="address-level1"]').first();
    if (await st.count()) { await st.selectOption({ label: "New York" }).catch(() => st.selectOption("NY").catch(() => {})); report.fields.state = "selected"; }
    step("fill-address", true, report.fields);
    await shot("03-address");

    // 若为多步 checkout，逐个点“继续”把 payment section 带出来
    for (const label of ["Continue to shipping", "Continue to payment", "Continue", "Continue to payment method"]) {
      const btn = page.locator(`button:has-text("${label}")`).first();
      if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(4000); }
    }
    await shot("04-after-continue");

    // 等待卡字段 iframe
    log("等待卡字段 iframe...");
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      found = page.frames().some((f) => FRAME.number(f.name() || "") || FRAME.number(f.url() || ""));
      if (!found) await page.waitForTimeout(1000);
    }
    report.signals.frameNames = page.frames().map((f) => f.name()).filter(Boolean).slice(0, 15);
    step("card-iframe", found, { frames: report.signals.frameNames });
    if (!found) { report.outcome = "no_card_iframe"; await shot("05-no-iframe"); return finish(browser); }

    // 填卡 iframe
    for (const key of ["number", "expiry", "cvc", "name"]) {
      const frame = page.frames().find((f) => FRAME[key](f.name() || "") || FRAME[key](f.url() || ""));
      report.fields[`card_${key}`] = { located: !!frame, filled: false };
      if (!frame) continue;
      try {
        const inp = frame.locator(INPUT[key]).first();
        await inp.waitFor({ state: "visible", timeout: 8000 });
        await inp.click(); await inp.type(CARD[key], { delay: 40 });
        const v = await inp.inputValue().catch(() => "");
        report.fields[`card_${key}`].filled = v.replace(/\s/g, "").length > 0;
        report.fields[`card_${key}`].readbackLen = v.length;
      } catch (e) { report.fields[`card_${key}`].error = e.message.split("\n")[0]; }
    }
    await shot("06-card-filled");

    const core = ["number", "expiry", "cvc"].every((k) => report.fields[`card_${k}`]?.filled);
    report.outcome = core ? "iframe_injection_OK_not_submitted" : "fill_failed";
    step("core-card-filled", core, {
      number: report.fields.card_number, expiry: report.fields.card_expiry, cvc: report.fields.card_cvc,
    });
    return finish(browser);
  } catch (e) {
    report.outcome = "error"; report.error = e.message;
    await shot("99-error").catch(() => {});
    return finish(browser);
  }
}

async function finish(browser) {
  await browser.close().catch(() => {});
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
