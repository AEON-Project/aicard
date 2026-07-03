/**
 * CheckoutFiller：用确定性 Playwright 在 Shopify 收银台自动填收货地址 + 卡并提交。
 *
 * 由 spike/shopify-fill/checkout-live.mjs 演进为可复用模块。
 * - 卡字段位于 Shopify 托管的跨域 iframe（实测可稳定注入，过 isTrusted 校验）。
 * - 遇 3DS/验证码：通过 otpFile 回填用户提供的验证码继续（C 端"验证码找用户"降级通道）。
 * - 卡面数据只在内存/表单流转，不写日志、不落盘。
 *
 * playwright 为可选依赖，按需动态加载。
 */
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export class FillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FillError";
    this.code = code;
  }
}

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

/**
 * 填卡并提交。
 * @param {object} p
 * @param {string} p.continueUrl - Cart/Checkout 返回的收银台地址
 * @param {object} p.address {email,country,region?,first,last,address1,address2?,city,zip,phone}
 * @param {object} p.card {number,expiry,cvc,name}
 * @param {boolean} [p.headful=false]
 * @param {boolean} [p.noSubmit=false] - 只填不提交（测试用）
 * @param {number} [p.waitOtpMs=0] - 遇挑战时等待验证码回填的最长时长
 * @param {string} [p.otpFile="./otp.txt"]
 * @param {string} [p.outDir="./artifacts"]
 * @param {(msg:string)=>void} [p.onProgress]
 * @returns {Promise<{outcome:string, signals:object, artifacts:string[], order:object|null}>}
 */
export async function fillCheckout(p) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new FillError("PLAYWRIGHT_MISSING", "未安装 playwright。请在项目内运行：npm i playwright && npx playwright install chromium");
  }

  if (!p.continueUrl) throw new FillError("NO_URL", "缺少 continueUrl");
  if (!p.card?.number || !p.card?.expiry || !p.card?.cvc) throw new FillError("NO_CARD", "缺少完整卡面");

  const outDir = pathResolve(p.outDir || "./artifacts");
  const otpFile = pathResolve(p.otpFile || "./otp.txt");
  const waitOtpMs = Number(p.waitOtpMs || 0);
  const log = p.onProgress || (() => {});
  mkdirSync(outDir, { recursive: true });
  if (existsSync(otpFile)) rmSync(otpFile);

  const A = p.address || {};
  const result = { outcome: null, signals: {}, artifacts: [], order: null };

  const browser = await chromium.launch({
    headless: !p.headful,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 1600 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  const shot = async (tag) => {
    const path = pathResolve(outDir, `co-${tag}.png`);
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    result.artifacts.push(path);
    return path;
  };
  const fill = async (sel, val) => {
    if (val == null) return false;
    const el = page.locator(sel).first();
    try {
      await el.waitFor({ state: "visible", timeout: 6000 });
      await el.fill(String(val));
      return true;
    } catch {
      return false;
    }
  };

  try {
    log("打开收银台…");
    await page.goto(p.continueUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await shot("01-open");

    // 国家（先选，电话/邮编校验依赖它）
    if (A.country) {
      const country = page.locator('select[autocomplete="country"],select[name*="countryCode" i]').first();
      if (await country.count()) {
        await country.selectOption({ label: A.country }).catch(() => country.selectOption(A.country).catch(() => {}));
      }
    }
    log("填写收货信息…");
    await fill('input[type="email"],input[name="email"],input#email', A.email);
    await fill('input[autocomplete="given-name"],input[name="firstName"]', A.first);
    await fill('input[autocomplete="family-name"],input[name="lastName"]', A.last);
    await fill('input[autocomplete="address-line1"],input[name="address1"]', A.address1);
    if (A.address2) await fill('input[autocomplete="address-line2"],input[name="address2"]', A.address2);
    await fill('input[autocomplete="address-level2"],input[name="city"],input[placeholder*="City" i],input[placeholder*="城市" i]', A.city);
    await fill('input[autocomplete="postal-code"],input[name="postalCode"],input[name="zip"],input[placeholder*="Postal" i],input[placeholder*="邮政" i]', A.zip);
    await fill('input[autocomplete="tel"],input[type="tel"]', A.phone);
    if (A.region) {
      const st = page.locator('select[autocomplete="address-level1"],select[name*="province" i],select[name*="state" i]').first();
      if (await st.count()) {
        try {
          await st.waitFor({ state: "visible", timeout: 5000 });
          await page.waitForTimeout(500); // 等 options 异步加载
          await st.selectOption({ label: A.region }).catch(async () => {
            await st.selectOption({ value: A.region }).catch(() => st.selectOption(A.region).catch(() => {}));
          });
        } catch {
          /* 州选择失败不阻断 */
        }
      }
    }
    await shot("02-address");

    // 多步 checkout：逐个点“继续”把支付区带出来
    for (const label of ["Continue to shipping", "继续", "Continue to payment", "Continue"]) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(4000); }
    }
    const ship = page.locator('input[type="radio"][name*="delivery" i],input[type="radio"][name*="shipping" i]').first();
    if (await ship.count()) { await ship.check().catch(() => {}); await page.waitForTimeout(2000); }
    await shot("03-shipping");

    // 等待卡字段 iframe
    log("等待并填写卡信息…");
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      found = page.frames().some((f) => FRAME.number(f.url() || "") || FRAME.number(f.name() || ""));
      if (!found) await page.waitForTimeout(1000);
    }
    if (!found) { result.outcome = "no_card_iframe"; await shot("04-no-iframe"); return finish(browser, result); }

    await dismissOverlays(page); // 关闭 Shop "Confirm it's you" 等遮挡卡字段的弹窗

    for (const k of ["number", "expiry", "cvc", "name"]) {
      const fr = page.frames().find((f) => FRAME[k](f.url() || "") || FRAME[k](f.name() || ""));
      result.signals[`card_${k}`] = { located: !!fr, filled: false };
      if (!fr) continue;
      try {
        const inp = fr.locator(INPUT[k]).first();
        await inp.waitFor({ state: "visible", timeout: 8000 });
        await inp.click();
        await inp.type(String(p.card[k]), { delay: 40 });
        const v = await inp.inputValue().catch(() => "");
        result.signals[`card_${k}`].filled = v.replace(/\s/g, "").length > 0;
      } catch (e) {
        result.signals[`card_${k}`].error = e.message.split("\n")[0];
      }
    }
    await shot("05-card-filled");

    if (!["number", "expiry", "cvc"].every((k) => result.signals[`card_${k}`]?.filled)) {
      result.outcome = "fill_failed";
      return finish(browser, result);
    }

    if (p.noSubmit) { result.outcome = "filled_no_submit"; return finish(browser, result); }

    // 提交（真实扣款）
    log("提交付款…");
    const pay = page.locator('button#checkout-pay-button,button:has-text("Pay now"),button:has-text("立即付款"),button:has-text("付款"),button[type="submit"]').first();
    await pay.waitFor({ state: "visible", timeout: 10000 });
    await pay.click();
    await page.waitForTimeout(6000);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await shot("06-after-pay");

    let outcome = await detect(page, result);

    // 3DS/验证码降级：等待用户把验证码写入 otpFile 后自动回填
    if ((outcome === "challenge_3ds" || outcome === "challenge_captcha") && waitOtpMs > 0) {
      result.signals.challenge = outcome;
      await shot("07-challenge");
      log(`需要验证码（${outcome}）。请把收到的验证码提供给我；系统将写入 ${otpFile} 后自动回填。`);
      const deadline = Date.now() + waitOtpMs;
      let filled = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2500);
        if (!filled && existsSync(otpFile)) {
          const code = readFileSync(otpFile, "utf8").trim();
          if (code) {
            log("已收到验证码，回填中…");
            for (const fr of page.frames()) {
              try {
                const inp = fr.locator('input[type="text"],input[type="tel"],input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="code" i]').first();
                if (await inp.count()) {
                  await inp.fill(code);
                  const sub = fr.locator('button[type="submit"],button:has-text("Submit"),button:has-text("Verify"),button:has-text("确认"),button:has-text("提交")').first();
                  if (await sub.count()) await sub.click().catch(() => {});
                  filled = true;
                  break;
                }
              } catch { /* 换下一个 frame */ }
            }
            await page.waitForTimeout(4000);
          }
        }
        outcome = await detect(page, result);
        if (outcome === "success" || outcome === "declined") break;
      }
      await shot("08-after-challenge");
    }

    result.outcome = outcome;
    if (outcome === "success") result.order = await extractOrder(page);
    return finish(browser, result);
  } catch (e) {
    result.outcome = "error";
    result.signals.error = e.message;
    await shot("99-error").catch(() => {});
    return finish(browser, result);
  }
}

async function detect(page, result) {
  const u = page.url();
  if (/\/(thank_you|thank-you|orders)\b/.test(u) || (await page.getByText(/thank you|order confirmed|订单已确认|感谢|谢谢/i).count().catch(() => 0))) return "success";
  const fr = page.frames();
  if (fr.some((f) => /3ds|acs|challenge|secure|authorize/i.test(f.url() || ""))) return "challenge_3ds";
  if (fr.some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.url() || ""))) return "challenge_captcha";
  const err = await page.getByText(/declined|invalid|incorrect|错误|被拒|无效|not be processed|失败/i).first().textContent().catch(() => null);
  if (err) { result.signals.formError = err.trim().slice(0, 200); return "declined"; }
  return "pending";
}

/** 关闭会遮挡卡字段的弹窗（Shop "Confirm it's you" 登录框等） */
async function dismissOverlays(page) {
  await page.keyboard.press("Escape").catch(() => {});
  const closers = [
    'button[aria-label="Close"]',
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    'button[aria-label*="关闭"]',
    '[role="dialog"] button:has-text("✕")',
    '[role="dialog"] button:has-text("×")',
  ];
  for (const sel of closers) {
    try {
      const b = page.locator(sel).first();
      if ((await b.count()) && (await b.isVisible())) await b.click({ timeout: 1500 });
    } catch {
      /* ignore */
    }
  }
  // Shop 弹窗常在 shop/pay iframe 内
  for (const f of page.frames()) {
    if (/shop|pay/i.test((f.url() || "") + (f.name() || ""))) {
      try {
        const b = f.locator('button[aria-label*="close" i], button:has-text("×"), button:has-text("✕")').first();
        if (await b.count()) await b.click({ timeout: 1200 });
      } catch {
        /* ignore */
      }
    }
  }
  await page.waitForTimeout(800);
}

async function extractOrder(page) {
  const url = page.url();
  const m = url.match(/\/orders\/([^/?#]+)/) || url.match(/order[_-]?(?:number|id)=([^&]+)/i);
  let number = null;
  const t = await page.getByText(/(order|订单)\s*#?\s*([A-Z0-9-]+)/i).first().textContent().catch(() => null);
  if (t) { const mm = t.match(/#?\s*([A-Z0-9][A-Z0-9-]{3,})/i); if (mm) number = mm[1]; }
  return { url, id: m ? m[1] : null, number };
}

async function finish(browser, result) {
  await browser.close().catch(() => {});
  return result;
}
