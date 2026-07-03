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
import { COUNTRY_CODES } from "./country-data.mjs";

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

// COUNTRY_CODES 来自 country-data.mjs（从真实 Shopify 收银台抠取的 201 国权威数据，见顶部 import）
// 补充日常简称 → ISO code（country-data 用官方名如 "Hong Kong SAR"，这里补常见叫法，直接用 value 选最可靠）
Object.assign(COUNTRY_CODES, {
  "hong kong": "HK", "macau": "MO", "macao": "MO", "taiwan": "TW",
  "south korea": "KR", "korea": "KR", "russia": "RU", "vietnam": "VN", "uae": "AE",
});

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
    headless: !(p.headful || p.assist), // assist 兜底模式强制可见窗口，让用户手动完成
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

    // 国家（先选，电话/邮编校验依赖它）——等 options 加载 + label/ISO 代码多重匹配 + 切换后等字段重渲染
    if (A.country) {
      const country = page.locator('select[autocomplete="country"],select[name*="countryCode" i],select[name*="country" i]').first();
      if (await country.count()) {
        try {
          await country.waitFor({ state: "visible", timeout: 6000 });
          await page.waitForTimeout(500);
          const cc = COUNTRY_CODES[A.country.toLowerCase()] || (/^[a-z]{2}$/i.test(A.country.trim()) ? A.country.trim().toUpperCase() : null);
          result.signals.countrySelected = await selectOptionSmart(country, A.country, cc);
          await page.waitForTimeout(800); // 国家切换后地址/电话字段会重渲染
        } catch {
          result.signals.countrySelected = false;
        }
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
          result.signals.regionSelected = await selectOptionSmart(st, A.region, null);
        } catch {
          result.signals.regionSelected = false;
        }
      }
    }
    await shot("02-address");

    // 地址校验错误检测（国家/州未选中等）→ 明确报错，不带着错误往下跑到迷惑的 fill_failed
    const addrErr = await page.getByText(/select a country|select a state|select a province|enter a valid|请选择|请输入有效/i).first().textContent().catch(() => null);
    if (addrErr) result.signals.addressError = addrErr.trim().slice(0, 120);
    if (A.country && result.signals.countrySelected === false) {
      // dump 该收银台实际支持的国家，准确定位（可能商户不配送该地区，而非名称问题）
      let avail = [];
      try {
        const csel = page.locator('select[autocomplete="country"],select[name*="countryCode" i],select[name*="country" i]').first();
        avail = await csel.locator("option").evaluateAll((os) => os.map((o) => (o.textContent || "").trim()).filter((t) => t && !/^select|country\/region/i.test(t)));
      } catch { /* ignore */ }
      result.signals.availableCountries = avail.slice(0, 25);
      result.outcome = "address_incomplete";
      result.signals.reason = avail.length
        ? `国家 '${A.country}' 未匹配到此收银台的可选项（可能该商户不配送该地区）。可选：${avail.slice(0, 10).join(", ")}${avail.length > 10 ? " …" : ""}`
        : `国家 '${A.country}' 未能选中，且未能读取收银台国家列表`;
      await shot("02b-address-error");
      if (!p.assist) return finish(browser, result);
    }
    if (A.region && result.signals.regionSelected === false) {
      result.outcome = "address_incomplete";
      result.signals.reason = `州/省未能选中：'${A.region}'（请核对 --region 取值是否与该国家的省/州名一致）`;
      await shot("02b-address-error");
      if (!p.assist) return finish(browser, result);
    }
    if (result.signals.addressError && /state|province|州|省/i.test(result.signals.addressError) && !A.region) {
      result.outcome = "address_incomplete";
      result.signals.reason = "该收银台要求 state/province，但未提供 --region，请补充。";
      await shot("02b-address-error");
      if (!p.assist) return finish(browser, result);
    }

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
    if (!found) { result.outcome = "no_card_iframe"; await shot("04-no-iframe"); if (p.assist) return assistWait(browser, result, page, shot, log, p); return finish(browser, result); }

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

    // assist 兜底：填完能填的（含卡号，脚本内存填入）→ 保持窗口让用户补齐并手动点付款
    if (p.assist) return assistWait(browser, result, page, shot, log, p);

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

/** 选中下拉：ISO code(value，语言无关) → label 精确 → 动态遍历 options 模糊匹配
 *  解决 "Hong Kong" vs "Hong Kong SAR"、本地化 label、简称/全称差异 */
async function selectOptionSmart(sel, name, code) {
  const trySel = async (arg) => {
    try { await sel.selectOption(arg); return true; } catch { return false; }
  };
  if (code && (await trySel({ value: code }))) return true;
  if (await trySel({ label: name })) return true;
  if (await trySel(name)) return true;
  try {
    const lname = String(name).toLowerCase().trim();
    const options = await sel.locator("option").all();
    for (const o of options) {
      const v = ((await o.getAttribute("value")) || "").trim();
      const t = ((await o.textContent()) || "").trim().toLowerCase();
      if (!v) continue;
      if ((code && v.toUpperCase() === code) || t === lname || t.includes(lname) || (lname.length > 3 && t.length > 2 && lname.includes(t))) {
        if (await trySel(v)) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** assist 兜底：脚本没全自动搞定时，保持可见窗口 + 已填好的信息，等用户手动完成并点付款 */
async function assistWait(browser, result, page, shot, log, p) {
  result.signals.assist = true;
  await shot("assist-ready");
  log("⚠️ 脚本未能全自动完成。已弹出浏览器窗口并尽量填好地址/卡信息——请在窗口里补齐未完成的字段（国家/州/验证码等）并点【Pay / 付款】完成。（卡号能填的已由脚本填入，无需你手输）");
  const deadline = Date.now() + (p.assistTimeoutMs || 600000); // 默认 10 分钟等用户操作
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    let oc = "pending";
    try {
      oc = await detect(page, result);
    } catch {
      break; // 页面/浏览器被用户关闭
    }
    if (oc === "success") {
      result.outcome = "success";
      result.order = await extractOrder(page);
      await shot("assist-done");
      return finish(browser, result);
    }
    if (oc === "declined") {
      result.outcome = "declined";
      await shot("assist-declined");
      return finish(browser, result);
    }
  }
  if (result.outcome !== "success") result.outcome = "assist_incomplete";
  return finish(browser, result);
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
