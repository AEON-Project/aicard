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
import { mkdirSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { COUNTRY_CODES } from "./country-data.mjs";

// 收银台截图 tag → 结构化步骤事件（供 agent 实时逐步感知）。截图即阶段真值，故事件由 shot() 顺带派生，
// 一处集中、与实际流程天然同步。【安全】masked 步骤（填卡）不带截图路径——含明文卡号/CVC，绝不外泄给呈现层。
const STEP_EVENTS = {
  "01-open":                  { id: "open_checkout", label: "Open checkout",     status: "done" },
  "01b-unavailable":          { id: "open_checkout", label: "Open checkout",     status: "failed" },
  "01c-bot-blocked":          { id: "open_checkout", label: "Open checkout",     status: "failed" },
  "02-address":               { id: "fill_address",  label: "Fill address",      status: "done" },
  "02b-address-error":        { id: "fill_address",  label: "Fill address",      status: "failed" },
  "03-shipping":              { id: "shipping",      label: "Shipping method",   status: "done" },
  "03b-shipping-unavailable": { id: "shipping",      label: "Shipping method",   status: "failed" },
  "05-card-filled":           { id: "fill_card",     label: "Fill card details", status: "done",   masked: true },
  "05b-refill-failed":        { id: "fill_card",     label: "Fill card details", status: "failed", masked: true },
  "05c-shipping-not-ready":   { id: "shipping",      label: "Shipping method",   status: "failed" },
  "06-after-pay":             { id: "submit",        label: "Submit payment",    status: "running" },
  "07-challenge":             { id: "verify",        label: "3DS / verification", status: "pending" },
  "08-after-challenge":       { id: "submit",        label: "Submit payment",    status: "done" },
};

/** 追加一条结构化事件到 progress 文件（JSONL）；无文件或写失败均静默。供 agent 实时 tail 逐步呈现。 */
export function appendStepEvent(progressFile, event) {
  if (!progressFile) return;
  try { appendFileSync(progressFile, JSON.stringify({ ...event, ts: Date.now() }) + "\n"); } catch { /* 非致命 */ }
}

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

// 存在性文本探测：先 count() 即时判断——避免 textContent() 在元素不存在时自动等满默认超时（30s）。
// 这是关键性能修复：地址错误/拒付/确认号等探测在“无匹配”时都会命中该陷阱。
async function textOf(locator) {
  try {
    if (!(await locator.count())) return null;
    return await locator.first().textContent({ timeout: 1500 });
  } catch {
    return null;
  }
}

// COUNTRY_CODES 来自 country-data.mjs（含权威 201 国 + 常见简称别名，单一事实源；见顶部 import）

/**
 * 填卡并提交。
 * @param {object} p
 * @param {string} p.continueUrl - Cart/Checkout 返回的收银台地址
 * @param {object} p.address {email,country,region?,first,last,address1,address2?,city,zip,phone}
 * @param {object} p.card {number,expiry,cvc,name}
 * @param {boolean} [p.headful=false]
 * @param {boolean} [p.noSubmit=false] - 只填不提交（测试用）
 * @param {number} [p.waitOtpMs=0] - 遇挑战时等待验证码回填的最长时长
 * @param {string} [p.otpFile="/tmp/aicard-otp.txt"]
 * @param {string} [p.outDir="./artifacts"]
 * @param {(msg:string)=>void} [p.onProgress]
 * @returns {Promise<{outcome:string, signals:object, artifacts:string[], order:object|null}>}
 */
export async function fillCheckout(p) {
  const chromium = await loadPlaywrightChromium(p.onProgress);

  if (!p.continueUrl) throw new FillError("NO_URL", "Missing continueUrl");
  if (!p.card?.number || !p.card?.expiry || !p.card?.cvc) throw new FillError("NO_CARD", "Missing complete card details");

  const outDir = pathResolve(p.outDir || "./artifacts");
  const otpFile = pathResolve(p.otpFile || "/tmp/aicard-otp.txt");
  const waitOtpMs = Number(p.waitOtpMs || 0);
  const log = p.onProgress || (() => {});
  // 实时步骤事件流：每步真实发生时写一条 JSONL 到 progressFile，供 agent 后台 tail 逐步呈现（AI 动态编排，非写死模板）。
  const progressFile = p.progressFile ? pathResolve(p.progressFile) : null;
  const emitStep = (tag, shotPath) => {
    const m = STEP_EVENTS[tag];
    if (!m) return;
    // masked 步骤（填卡）绝不带截图路径——含明文卡面
    appendStepEvent(progressFile, m.masked ? { evt: "step", ...m } : { evt: "step", ...m, ...(shotPath ? { shot: shotPath } : {}) });
  };
  mkdirSync(outDir, { recursive: true });
  if (existsSync(otpFile)) rmSync(otpFile);
  // 注：progressFile 的重置由调用方（shop.mjs）负责——它在 checkout 之前还要先写 issue_card 事件，
  // 若在此重置会冲掉那些前置事件。fillCheckout 只向其追加收银台各步事件。

  const A = p.address || {};
  const result = { outcome: null, signals: {}, artifacts: [], order: null };
  const _t0 = Date.now();
  const _perf = (s) => { if (process.env.AICARD_PERF) console.error(`[perf] ${s}: ${((Date.now() - _t0) / 1000).toFixed(1)}s`); };

  const browser = await launchWithAutoInstall(chromium, {
    headless: !(p.headful || p.assist), // assist 兜底模式强制可见窗口，让用户手动完成
    // stealth 借鉴 browser-use：不破解验证码，只让自动化浏览器更不像 bot → 降低 Shop 反爬挑战触发率。
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
      "--disable-infobars",
      "--no-default-browser-check",
      "--no-first-run",
    ],
  }, log);
  // 出口代理（借鉴 hermes：住宅/轮换代理是最有效的反爬手段——IP 信誉 > 指纹）。
  // 从 p.proxy 或环境变量读取(AICARD_PROXY / HTTPS_PROXY / ALL_PROXY)，透传给 Playwright；不设则直连。
  const proxy = parseProxy(p.proxy || process.env.AICARD_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY);
  if (proxy) log(`Using egress proxy ${proxy.server}${proxy.username ? " (auth)" : ""}`);
  const ctx = await browser.newContext({
    ...(proxy ? { proxy } : {}),
    // locale 保留 en-US：这是【功能性归一】——强制收银台英文渲染，我们的填单选择器大量依赖英文文本
    //（Continue to shipping / Shipping method / 条款关键词…）。跟随系统真实 locale 会让非英文机器上
    // 收银台渲染成其它语言、英文选择器失配。语言信号以此为【单一真相源】：navigator.languages 与
    // Accept-Language 均由 Playwright 按 locale 自动派生，不再手动写死（避免多处矛盾）。
    locale: "en-US",
    // 不写死 timezoneId：收货地址是动态的，且时区应匹配【真实机器/IP 地理】而非收货地址
    //（真人可能在 A 地下单寄 B 地）。留空用系统真实时区，指纹最自洽；写死反而制造矛盾。
    viewport: { width: 1280, height: 1600 },
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  // 指纹隐身：抹掉常见 headless/自动化特征（webdriver / languages / plugins / chrome runtime / permissions / WebGL vendor）。
  // 纯"更像真人"的伪装，不涉及破解验证码；只在避免触发挑战这一层借鉴 browser-use。
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // 不覆盖 navigator.languages：由 Playwright 按 context.locale 自动设置，避免与 locale 矛盾的第二处写死
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] }); // 非空插件列表
    window.chrome = window.chrome || { runtime: {} }; // headless 下常缺失 window.chrome
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = (params) =>
        params && params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }
    // WebGL 厂商/渲染器伪装成常见真实值（headless 会暴露 SwiftShader/Google 等特征）
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
        return getParam.call(this, p);
      };
    } catch { /* ignore */ }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  // 诊断截图用【视口】而非 fullPage：fullPage 需整页渲染+拼接，长收银台页每张 ~0.5-1s，
  // 多张累计数秒纯开销；视口截图快很多且已覆盖当前可视区(1280×1600)足够定位问题。
  // 注意：成功凭证图另在 success 分支单独 fullPage 截取，不受此影响。
  const shot = async (tag) => {
    const path = pathResolve(outDir, `co-${tag}.png`);
    await page.screenshot({ path }).catch(() => {});
    result.artifacts.push(path);
    emitStep(tag, path); // 顺带派生结构化步骤事件（实时流）
    return path;
  };
  const same = (a, b) => String(a).replace(/\s/g, "").toLowerCase() === String(b).replace(/\s/g, "").toLowerCase();
  const fill = async (sel, val) => {
    if (val == null) return false;
    const el = page.locator(sel).first();
    try {
      await el.waitFor({ state: "visible", timeout: 6000 });
      await el.fill(String(val));
      // 回读验证：自动补全控件（如 Shopify 地址栏 Google Places）会把直接塞入的纯文本清掉 → 值留不住。
      let v = await el.inputValue().catch(() => "");
      if (!same(v, val)) {
        // 兜底：逐字符输入触发控件、等下拉出现、Esc 关下拉保留已输入文本，再回读。
        await el.click().catch(() => {});
        await el.fill("").catch(() => {});
        await el.type(String(val), { delay: 18 });
        await page.waitForTimeout(300); // 等自动补全下拉渲染
        await page.keyboard.press("Escape").catch(() => {}); // 关下拉、保留输入的文本
        v = await el.inputValue().catch(() => "");
      }
      return v.trim().length > 0;
    } catch {
      return false;
    }
  };

  try {
    log("Opening checkout…");
    // waitUntil:"commit" 一提交导航即返回（比 domcontentloaded 快很多，重页面不会卡）；
    // 网络抖动重试：最多 3 次，命中即返回；全失败也不硬崩，交给下方早检判断可用性。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(p.continueUrl, { waitUntil: "commit", timeout: 20000 });
        break;
      } catch {
        if (attempt < 3) { log(`Checkout load timed out, retrying ${attempt}/2…`); await page.waitForTimeout(1000); }
      }
    }
    await page.waitForTimeout(400);
    await shot("01-open");

    // 收银台有效性早检（两段，避免误杀“正在加载骨架”的有效收银台）：
    // ① 立即检测明确死链文案——死链（404）会即时显示错误页；用 checkout/payment 关键词兜底防误判。
    const earlyBody = (await page.locator("body").textContent().catch(() => "")) || "";
    if (/\b404\b|not found|page not found|页面不存在|无法找到/i.test(earlyBody) && !/checkout|payment|shipping|收银|付款/i.test(earlyBody)) {
      result.outcome = "checkout_unavailable";
      result.signals.reason = "Checkout link is invalid or expired (404). Please regenerate continueUrl with `shop cart` before paying again.";
      await shot("01b-unavailable");
      return finish(browser, result);
    }
    // ② 有效收银台可能仍在渲染骨架——给表单字段充足时间出现（命中即退，正常网络 1-3s，不影响快路径）。
    //    真死链已被 ① 立即拦截，走到这里多是慢网络，故给到 60s 再判失效，避免误杀有效收银台。
    const checkoutReady = await page
      .locator('input[type="email"],input[name="email"],select[name*="country" i],input[autocomplete="address-line1"],input[name="address1"]')
      .first()
      .waitFor({ state: "visible", timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    let ready = checkoutReady;
    if (!ready) {
      // 兜底：reload 一次再等——偶发首屏没渲染出表单（如 ivyusa 首访），重载常能救回，避免误报 checkout_unavailable
      log("Checkout form not visible yet; reloading once…");
      await page.reload({ waitUntil: "commit", timeout: 20000 }).catch(() => {});
      ready = await page
        .locator('input[type="email"],input[name="email"],select[name*="country" i],input[autocomplete="address-line1"],input[name="address1"]')
        .first()
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!ready) {
      // bot 拦截识别（借鉴 hermes/browser-use）：表单一直不出现时，若标题/页面是 Cloudflare/反爬拦截页，
      // 归为专门的 bot_blocked（而非笼统 checkout_unavailable），给"重试/换住宅代理"可操作指引——不破解验证码。
      const title = ((await page.title().catch(() => "")) || "");
      const body = ((await page.locator("body").textContent().catch(() => "")) || "").slice(0, 600);
      if (/just a moment|attention required|checking your browser|ddos protection|access denied|are you a robot|verify you are human|请稍候|安全验证|人机验证/i.test(title + " " + body)) {
        result.outcome = "bot_blocked";
        result.signals.botBlockTitle = title.slice(0, 80);
        result.signals.reason = `Blocked by anti-bot protection (page: "${title.slice(0, 60)}"); this is bot protection that cannot be bypassed. You can try: retrying later; configuring a residential proxy (--proxy / env HTTPS_PROXY) to change the egress IP and reduce the chance of being blocked; some merchants have very strong anti-bot measures that may not be completable automatically.`;
        await shot("01c-bot-blocked");
        return finish(browser, result);
      }
      result.outcome = "checkout_unavailable";
      result.signals.reason = "Checkout form failed to load (form still not present after reload; usually a network issue or an invalid link). Please check your network or regenerate continueUrl with `shop cart`.";
      await shot("01b-unavailable");
      return finish(browser, result);
    }

    // 国家（先选，电话/邮编校验依赖它）——等 options 加载 + label/ISO 代码多重匹配 + 切换后等字段重渲染
    if (A.country) {
      const country = page.locator('select[autocomplete="country"],select[name*="countryCode" i],select[name*="country" i]').first();
      if (await country.count()) {
        try {
          await country.waitFor({ state: "visible", timeout: 6000 });
          await page.waitForTimeout(150);
          const cc = COUNTRY_CODES[A.country.toLowerCase()] || (/^[a-z]{2}$/i.test(A.country.trim()) ? A.country.trim().toUpperCase() : null);
          result.signals.countrySelected = await selectOptionSmart(country, A.country, cc);
          await page.waitForTimeout(250); // 国家切换后地址/电话字段会重渲染
        } catch {
          result.signals.countrySelected = false;
        }
      }
    }
    _perf("country-done");
    log("Filling shipping info…");
    // ⚠️ 顺序填，勿并行：实测并发 fill() 在部分收银台会字段错位（邮箱进 First name、姓并进 Address 等）。
    // 正确性 > 省那 1s。fill 用 el.fill 直接赋值，本身很快，顺序总耗时也就 1-2s。
    await fill('input[type="email"],input[name="email"],input#email', A.email);
    await fill('input[autocomplete="given-name"],input[name="firstName"]', A.first);
    await fill('input[autocomplete="family-name"],input[name="lastName"]', A.last);
    await fill('input[autocomplete="address-line1"],input[name="address1"]', A.address1);
    if (A.address2) await fill('input[autocomplete="address-line2"],input[name="address2"]', A.address2);
    await fill('input[autocomplete="address-level2"],input[name="city"],input[placeholder*="City" i],input[placeholder*="城市" i]', A.city);
    await fill('input[autocomplete="postal-code"],input[name="postalCode"],input[name="zip"],input[placeholder*="Postal" i],input[placeholder*="邮政" i]', A.zip);
    await fill('input[autocomplete="tel"],input[type="tel"]', A.phone);
    _perf("fields-filled");

    // 填完邮箱后，Shop 可能弹出 "Confirm it's you" 登录框（灰色遮罩挡住州选择/配送/卡字段）。
    // 在选州之前就关掉它 = 跳过登录、以访客继续（免 OTP）。稍等它渲染出来再关。
    await page.waitForTimeout(400);
    await dismissOverlays(page);
    if (A.region) {
      // State/省 下拉：优先【可见】的那个——部分收银台有多个同名 zone select，隐藏的只有占位项，
      // 用 .first() 会误抓到它导致选不中（实测 dallastoyswholesale/idspring 均如此）。
      // 等它可见 + options 真正灌入（选完国家后异步填充）再选，并轮询重试到选中或超时（~7s）。
      const visSel = 'select[autocomplete*="address-level1" i]:visible,select[name="zone" i]:visible,select[name*="province" i]:visible,select[name*="state" i]:visible';
      const anySel = 'select[autocomplete*="address-level1" i],select[name="zone" i],select[name*="province" i],select[name*="state" i]';
      let ok = false;
      for (let i = 0; i < 28 && !ok; i++) {
        let st = page.locator(visSel).first();
        if (!(await st.count().catch(() => 0))) st = page.locator(anySel).first(); // 无可见则退而求其次
        if (await st.count().catch(() => 0)) {
          const optCount = await st.locator("option").count().catch(() => 0);
          if (optCount > 1) ok = await selectOptionSmart(st, A.region, null); // options 已灌入（不止占位项）才选
        }
        if (!ok) await page.waitForTimeout(250);
      }
      result.signals.regionSelected = ok;
    }
    await shot("02-address");
    _perf("address-filled");

    // 地址校验错误检测（国家/州未选中等）→ 明确报错，不带着错误往下跑到迷惑的 fill_failed
    const addrErr = await textOf(page.getByText(/select a country|select a state|select a province|enter a valid|请选择|请输入有效/i));
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
        ? `Country '${A.country}' did not match any option in this checkout (the merchant may not ship to this region). Available: ${avail.slice(0, 10).join(", ")}${avail.length > 10 ? " …" : ""}`
        : `Country '${A.country}' could not be selected, and the checkout's country list could not be read`;
      await shot("02b-address-error");
      if (!p.assist) return finish(browser, result);
    }
    if (A.region && result.signals.regionSelected === false) {
      result.outcome = "address_incomplete";
      result.signals.reason = `State/province could not be selected: '${A.region}' (please verify that the --region value matches a province/state name for this country)`;
      await shot("02b-address-error");
      if (!p.assist) return finish(browser, result);
    }
    if (result.signals.addressError && /state|province|州|省/i.test(result.signals.addressError) && !A.region) {
      result.outcome = "address_incomplete";
      result.signals.reason = "This checkout requires a state/province, but --region was not provided. Please add it.";
      await shot("02b-address-error");
      if (!p.assist) return finish(browser, result);
    }

    // 勾选“必填的同意/条款”复选框：经典多步收银台常在 Information 步要求勾 T&C/隐私/年龄确认，
    // 不勾则“Continue to shipping”点不动、到不了支付页（实测 1stphorm）。只勾必填/明显条款项，绝不碰营销订阅。
    result.signals.termsAccepted = await acceptRequiredTerms(page, log);

    // 多步 checkout：逐个点“继续”把支付区带出来
    const clickContinue = async () => {
      for (const label of ["Continue to shipping", "继续", "Continue to payment", "Continue"]) {
        const b = page.locator(`button:has-text("${label}")`).first();
        if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(1500); }
      }
    };
    await clickContinue();
    // 反应式条款兜底：若被“请接受条款”校验拦下（acceptRequiredTerms 因无标签/动态无属性没抓到的 React 受控框），
    // 点复选框的【可见包裹】(label[for]/祖先 label/父级)触发 React onChange——直接改隐藏 input 的 checked 不生效——再重试 Continue。
    const termsErr = await textOf(page.getByText(/please indicate.*(terms|condition)|accept the terms|must accept|must agree|please agree.*(terms|condition)|请.*(同意|接受).*条款/i));
    if (termsErr) {
      const n = await acceptTermsReactive(page, log);
      if (n) { result.signals.termsAccepted = (result.signals.termsAccepted || 0) + n; await clickContinue(); }
    }
    // 点“继续”后 Shop 登录弹窗可能再次出现（遮挡配送/卡字段）——再关一次跳过登录。
    await dismissOverlays(page);
    // 提交地址（失焦）触发 Shopify 算运费：最后填的字段仍聚焦时，部分收银台不会去 fetch 运费率，
    // 导致配送方式一直不出现。主动 blur 当前字段，促使其计算运费。
    await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    await page.waitForTimeout(600);

    // 等配送方式真正加载完（骨架→真实单选项）再填卡：Shopify 在配送方式解析完成后会重渲染 payment 区，过早填卡会被清空
    log("Waiting for shipping methods to load…"); // 收银台算运费率可能较久（最多约 45s），此处给出进度、避免看着像卡住
    const ship = await waitShippingReady(page);
    result.signals.shippingReady = ship.picked;
    result.signals.shippingVia = ship.via; // 遥测：配送就绪的识别分支(radio/methodRow/priced/none)
    _perf("shipping-ready");
    await shot("03-shipping");

    // 配送不可用（如批发店最低起订/重量门槛）：收银台会明确报错。以【报错文案】为准判定——
    // 哪怕有残留 radio 让 ship.picked 误报，只要出现 "Shipping not available / do not meet" 等，
    // 就是发不了货，点 Pay 必失败。提前拦截、返回 shipping_not_ready（未填卡、未提交、未扣款），
    // 让上层清楚提示“该单不满足配送要求，请调整购物车或换商户”，而不是去撞一个注定失败的付款。
    const shipErr = await textOf(
      page.getByText(/shipping (is )?not available|not (eligible|available) for shipping|do not meet|does not qualify|no shipping (methods|options) available|无法配送|不满足.*配送|没有可用的?配送/i)
    );
    if (shipErr) {
      result.outcome = "shipping_not_ready";
      result.signals.shippingReady = false; // 以报错为准，纠正可能被残留 radio 带偏的 picked
      result.signals.reason = `Checkout shipping is unavailable: ${shipErr.slice(0, 160)} (common with wholesale-store minimum-order/weight thresholds; no card entered, no charge made). Please adjust the cart quantity/amount or switch merchants.`;
      await shot("03b-shipping-unavailable");
      if (!p.assist) return finish(browser, result);
    }

    // 主动选中"Credit card"支付方式：部分收银台默认落在 Shop Pay/PayPal，信用卡区收起，卡 iframe 不挂载。
    // 已选中则不动；未选中才点（radio id=basic-creditCards，或按文本匹配）。不阻断——选不中交给下方 iframe 检测判定。
    try {
      const ccRadio = page.locator('#basic-creditCards,input[type="radio"][id*="creditcard" i],input[type="radio"][value*="creditcard" i]').first();
      if ((await ccRadio.count()) && !(await ccRadio.isChecked().catch(() => false))) {
        await ccRadio.check({ timeout: 2500 }).catch(async () => {
          await page.getByText(/^\s*credit card\s*$|credit\/debit card|信用卡/i).first().click({ timeout: 2000 }).catch(() => {});
        });
        await page.waitForTimeout(700); // 等卡 iframe 挂载
      }
    } catch { /* ignore：交给下方卡 iframe 检测 */ }

    // 等待卡字段 iframe
    log("Waiting for and filling card details…");
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      found = page.frames().some((f) => FRAME.number(f.url() || "") || FRAME.number(f.name() || ""));
      if (!found) await page.waitForTimeout(250);
    }
    if (!found) {
      // 区分“商户不支持信用卡（仅 PayPal/钱包）” vs “真不是付款页”——避免误诊成配送/网络问题。
      const hasCardOption = (await page.getByText(/credit card|debit card|信用卡|银行卡|card number|卡号/i).count().catch(() => 0)) > 0;
      const hasWalletOnly = (await page.getByText(/paypal|apple pay|google pay|afterpay|shop pay/i).count().catch(() => 0)) > 0;
      if (!hasCardOption && hasWalletOnly) {
        result.outcome = "card_not_supported";
        result.signals.reason = "This merchant does not support credit/debit card payment (wallets only, e.g. PayPal), so the virtual card cannot be used. Please switch to a merchant that supports credit cards.";
        await shot("04-no-card-option");
        return finish(browser, result); // 换商户才有用，assist 也补不出卡选项
      }
      result.outcome = "no_card_iframe";
      await shot("04-no-iframe");
      if (p.assist) return assistWait(browser, result, page, shot, log, p);
      return finish(browser, result);
    }
    _perf("card-iframe-found");

    await dismissOverlays(page); // 关闭 Shop "Confirm it's you" 等遮挡卡字段的弹窗
    _perf("overlays-dismissed");

    // 勾选"账单地址同收货地址"：部分商户（如 eyeshinecosmetics）默认【不勾】且账单地址必填——
    // 不勾则点 Pay 会触发账单地址一堆必填红框（Enter a first name/city/ZIP…）、无法提交、白点一次 Pay。
    // 勾上即以收货地址作账单地址，跳过手填账单。
    result.signals.billingSameAsShipping = await ensureBillingSameAsShipping(page, log);

    // 填卡（可重复调用）：每字段先读现值，缺失/被清空才重填，blur 触发校验格式化。返回 number/expiry/cvc 是否都已就位
    const fillCard = async () => {
      for (const k of ["number", "expiry", "cvc", "name"]) {
        const fr = page.frames().find((f) => FRAME[k](f.url() || "") || FRAME[k](f.name() || ""));
        const sig = (result.signals[`card_${k}`] ||= { located: false, filled: false });
        sig.located = !!fr;
        if (!fr) continue;
        try {
          const inp = fr.locator(INPUT[k]).first();
          await inp.waitFor({ state: "visible", timeout: 8000 });
          const want = String(p.card[k]).replace(/\s/g, "");
          let cur = (await inp.inputValue().catch(() => "")).replace(/\s/g, "");
          if (cur !== want) {
            // 点击聚焦：部分商户(如 redragonshop)卡 iframe 输入框"可见但点不动"(被遮挡/不稳定)，
            // 默认 click 会每字段干等满 30s 后 fill_failed。缩短超时 + scrollIntoView + force 兜底，点不动就强制点。
            await inp.click({ timeout: 4000 }).catch(async () => {
              await inp.scrollIntoViewIfNeeded().catch(() => {});
              await inp.click({ timeout: 4000, force: true }).catch(() => {});
            });
            await inp.fill("").catch(() => {});
            await inp.type(String(p.card[k]), { delay: 22 });
            await inp.evaluate((el) => el.blur()).catch(() => {}); // 触发 Shopify 卡字段校验/格式化
            cur = (await inp.inputValue().catch(() => "")).replace(/\s/g, "");
          }
          sig.filled = cur.length > 0;
        } catch (e) {
          sig.error = e.message.split("\n")[0];
        }
      }
      return ["number", "expiry", "cvc"].every((k) => result.signals[`card_${k}`]?.filled);
    };

    await fillCard();
    _perf("card-filled");
    await page.waitForTimeout(500); // 短暂落定；提交前 fillCard() 会再复检重填
    await shot("05-card-filled");

    // assist 兜底：填完能填的（含卡号，脚本内存填入）→ 保持窗口让用户补齐并手动点付款
    if (p.assist) return assistWait(browser, result, page, shot, log, p);

    // 提交前复检并重填：Shopify 重渲染可能清空卡 iframe，此处是唯一能保证“点付款那一刻卡字段有值”的地方
    if (!(await fillCard())) {
      result.outcome = "fill_failed";
      await shot("05b-refill-failed");
      return finish(browser, result);
    }

    if (p.noSubmit) { result.outcome = "filled_no_submit"; return finish(browser, result); }

    // ⚠️ 运费方式必需但未加载出来 → 点 Pay 会卡在 "Processing…"（实测本次）。
    //    在点付款【之前】中止：未提交、未扣款、可安全重试。避免“已提交但状态未知”的模糊态。
    if (ship.required && !ship.picked) {
      result.outcome = "shipping_not_ready";
      result.signals.reason = "Shipping method did not load (checkout shipping rates not ready; clicking Pay would hang). Payment was not submitted and no charge was made — please retry (regenerate continueUrl with `shop cart`, then pay).";
      await shot("05c-shipping-not-ready");
      return finish(browser, result);
    }

    // 提交（真实扣款）
    log("Submitting payment…");
    // 选“立即付款”按钮：优先 Shopify 固定 id；否则按无障碍名匹配。
    // 关键：不能用 button[type=submit] + .first()——会命中 DOM 靠前的隐藏助手按钮
    // <button aria-hidden tabindex=-1>Submit</button>，点它被装饰层拦截而超时。getByRole 天然排除 aria-hidden 元素。
    let pay = page.locator("button#checkout-pay-button").first();
    if (!(await pay.isVisible().catch(() => false))) {
      pay = page.getByRole("button", { name: /pay now|complete order|place order|立即付款|付款|下单|结账/i }).first();
    }
    await pay.waitFor({ state: "visible", timeout: 10000 });
    await pay.scrollIntoViewIfNeeded().catch(() => {});
    // ⚠️ 防重复扣款：点 Pay 后款可能已进处理器。标记 paySubmitted，
    //    上层据此判断——除非明确 declined，否则绝不重试（重试=重复扣款）。
    result.signals.paySubmitted = true;
    try {
      await pay.click({ timeout: 15000 });
    } catch {
      await pay.click({ timeout: 15000, force: true }); // 装饰性覆盖层拦截时强制点
    }
    // 提交后轮询结果（不用 networkidle，Shopify 埋点长连接会吃满超时）：
    // 每 1s 探测一次。success/declined 立即停；challenge_3ds 不立即停——
    // 大多数 3DS 是 frictionless（无感）：ACS iframe 出现但会自动通过变 success。
    // 给它最多 ~10s 自动完成；只有持续是挑战才当作“真需要用户输验证码”。
    // 轮询上限放大到 ~90s：付款 "Processing…"（含 frictionless 3DS + 建单）在慢网络下可能 >20s，
    // 过早返回 pending 会造成“款可能已扣但状态未知”的危险模糊态。success/declined/真挑战都提前退出，
    // 只有真正慢/卡的情况才等满。
    log("Waiting for payment result…"); // 处理/建单/frictionless 3DS 可能持续几十秒，给出进度
    let outcome = "pending";
    let challengeStreak = 0;
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(1000);
      outcome = await detect(page, result);
      if (outcome === "success" || outcome === "declined" || outcome === "address_incomplete") break;
      if (outcome === "challenge_3ds" || outcome === "challenge_captcha") {
        if (++challengeStreak >= 12) break; // 持续 ~12s 仍是挑战 → 真挑战（需用户交互）
        continue; // frictionless：再给几秒自动通过
      }
      challengeStreak = 0; // pending（处理中）：重置，继续等到终态
    }
    await shot("06-after-pay");

    // 3DS/验证码降级：多步导航（如 UQPAY：选认证方式 → Next[此步触发发码] → 出现 OTP 输入框 → 填码 → Submit）。
    // 单一循环内：① 先看是否已到 OTP 输入步；到了就等验证码文件并回填提交；② 没到就点“下一步/发送”推进多步流程；
    // 全程轮询终态。验证码由用户写入 otpFile 后自动回填。
    if ((outcome === "challenge_3ds" || outcome === "challenge_captcha") && waitOtpMs > 0) {
      result.signals.challenge = outcome;
      await shot("07-challenge");
      log(`Verification required (${outcome}). Navigating 3DS; provide the code → it will be read from ${otpFile}.`);
      await page.waitForTimeout(2000); // 等 3DS iframe 加载

      // 定位 3DS 挑战 frame：优先 URL 特征（UQPAY/AlchemyPay/ACS/3DS/challenge），再退回文本特征。
      // 关键：只在该 frame 内找 OTP 框/点按钮——否则会误匹配 Shopify 主页面的地址/邮箱文本框，误判“已到输入步”。
      const find3dsFrame = async () => {
        for (const fr of page.frames()) {
          if (/uqpay|alchemypay|acs|three_?ds|3-?d-?secure|emv3ds|threeds|\/challenge/i.test(fr.url() || "")) return fr;
        }
        for (const fr of page.frames()) {
          try {
            if (await fr.getByText(/transaction verification|authentication mode|secure checkout|verification code|one[- ]time|请输入|验证码/i).count().catch(() => 0)) return fr;
          } catch { /* 下一个 */ }
        }
        return null;
      };
      // 在 3DS frame 内找【可见】OTP 输入框：先按 otp/code 特征，再退回该 frame 内的通用输入框
      const findOtpInput = async (fr) => {
        if (!fr) return null;
        const sels = [
          'input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="code" i],input[id*="otp" i],input[id*="code" i],input[placeholder*="otp" i],input[placeholder*="code" i]',
          'input[type="tel"],input[type="text"],input[type="password"],input[type="number"]',
        ];
        for (const sel of sels) {
          try {
            const inp = fr.locator(sel).first();
            if ((await inp.count()) && (await inp.isVisible().catch(() => false))) return inp;
          } catch { /* 下一个 */ }
        }
        return null;
      };
      // 在 3DS frame 内点“下一步/发送”推进多步（不含 Submit/Verify——那属于填码后的提交步，避免过早提交空表单）
      const clickAdvance = async (fr) => {
        if (!fr) return false;
        const cands = await fr.locator('button, input[type="submit"], input[type="button"], [role="button"], a').all().catch(() => []);
        for (const c of cands) {
          try {
            if (!(await c.isVisible().catch(() => false))) continue;
            const t = (((await c.textContent().catch(() => "")) || "") + " " + ((await c.getAttribute("value").catch(() => "")) || "")).trim().toLowerCase();
            if (/^(next|continue|proceed|get otp|send code|获取|下一步|发送)\b/.test(t) || /^(next|continue|proceed)$/.test(t)) {
              await c.click({ timeout: 3000 });
              result.signals.threeDSAdvanced = t.slice(0, 30);
              log("3DS advance: " + t.slice(0, 30));
              return true;
            }
          } catch { /* 下一个 */ }
        }
        return false;
      };
      // 在 3DS frame 内填码并提交：回车 + 遍历可点元素按文本匹配 SUBMIT（不依赖 role/tag，兼容 <a>/<div>/<input>）。
      // getByRole("button") 对 UQPAY 的非语义 SUBMIT（<div>/<a>）返回 0 → 跳过点击 → 码填了没提交。
      // 改用与 clickAdvance 相同、已验证可点 "Next" 的遍历方式；click 失败再 force 兜底。
      const submitOtp = async (fr, inp, code) => {
        await inp.click().catch(() => {});
        await inp.fill(code).catch(() => {});
        await inp.press("Enter").catch(() => {}); // 很多 OTP 表单回车即提交
        const cands = await fr.locator('button, input[type="submit"], input[type="button"], [role="button"], a, div[onclick], span[onclick], [class*="btn" i], [class*="button" i]').all().catch(() => []);
        for (const c of cands) {
          try {
            if (!(await c.isVisible().catch(() => false))) continue;
            const t = (((await c.textContent().catch(() => "")) || "") + " " + ((await c.getAttribute("value").catch(() => "")) || "")).trim().toLowerCase();
            if (/^(submit|verify|confirm|continue|ok|确认|提交|验证|下一步)\b/.test(t) || /^(submit|verify|confirm|continue|ok)$/.test(t)) {
              await c.scrollIntoViewIfNeeded().catch(() => {});
              await c.click({ timeout: 4000 }).catch(async () => {
                await c.click({ timeout: 4000, force: true }).catch(() => {});
              });
              return;
            }
          } catch { /* 下一个 */ }
        }
      };

      const deadline = Date.now() + waitOtpMs;
      let otpRequested = false;
      let submitCount = 0;
      let lastSubmit = 0;
      let lastAdvance = 0;
      while (Date.now() < deadline) {
        outcome = await detect(page, result);
        if (outcome === "success" || outcome === "declined") break;

        const fr = await find3dsFrame();
        const inp = await findOtpInput(fr);
        if (inp) {
          // 已到 OTP 输入步。OTP 框仍在 = 尚未提交成功：填码并提交，未推进则每 ~8s 重试（最多 3 次）。
          if (!otpRequested) {
            otpRequested = true;
            await shot("07b-otp-step");
            log("OTP input ready — waiting for the code…");
          }
          if (existsSync(otpFile) && submitCount < 3 && Date.now() - lastSubmit > 5000) {
            const code = readFileSync(otpFile, "utf8").trim();
            if (code) {
              log(`Submitting verification code (attempt ${submitCount + 1})…`);
              await submitOtp(fr, inp, code);
              submitCount++;
              lastSubmit = Date.now();
              await page.waitForTimeout(4000);
              // 诊断：截图 + dump 提交后 3DS frame 的可见文案（报错/拒付/processing 一目了然）
              await shot(`otp-try${submitCount}`);
              try {
                const f2 = await find3dsFrame();
                const t2 = f2 ? ((await f2.locator("body").textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 260) : "(no 3ds frame)";
                log(`3DS frame after submit ${submitCount}: ${t2}`);
              } catch { /* ignore */ }
            }
          }
          // 提交后扫描 3DS frame 内错误文案（主页面 detect 看不到 iframe 内部）→ 快速失败，不空转到超时。
          if (submitCount > 0 && fr) {
            const ferr = await textOf(fr.getByText(/incorrect|invalid|failed|expired|wrong|does ?n['’]?t match|not match|错误|无效|过期|失败|不正确/i));
            if (ferr) {
              outcome = "challenge_3ds";
              result.signals.otpError = ferr.trim().slice(0, 120);
              result.signals.reason = `Verification code was not accepted: ${ferr.trim().slice(0, 80)} (wrong or expired code). Please obtain a new code and retry.`;
              log("OTP rejected by 3DS: " + ferr.trim().slice(0, 60));
              break;
            }
            // 3 次提交后仍停在输入框、且无明确报错 → 提前中止（码错/过期或提交未被接受），不空转到超时
            if (submitCount >= 3 && Date.now() - lastSubmit > 12000) {
              outcome = "challenge_3ds";
              result.signals.reason = "Still stuck at the input step after 3 verification-code submissions (wrong/expired code, or the submission was not accepted). Please obtain a new code and retry.";
              log("OTP not accepted after 3 attempts — aborting early");
              break;
            }
          }
        } else if (submitCount === 0 && Date.now() - lastAdvance > 4000) {
          // 尚未出现 OTP 输入框：在 3DS frame 内点“下一步/发送”推进（该步会触发发码到发卡方邮箱/手机）
          lastAdvance = Date.now();
          if (!(await clickAdvance(fr))) result.signals.threeDSAdvanced ??= false;
          await page.waitForTimeout(2500);
        }
        await page.waitForTimeout(1500);
      }
      await shot("08-after-challenge");
    }

    result.outcome = outcome;
    if (outcome === "success") {
      result.order = await extractOrder(page);
      // 持久化付款凭证图到 ~/.aicard/receipts/（感谢页，无完整卡面），路径随结果返回供用户留存/售后
      try {
        const dir = pathJoin(homedir(), ".aicard", "receipts");
        mkdirSync(dir, { recursive: true });
        const safe = String(result.order.number || "order").replace(/[^A-Za-z0-9_-]/g, "");
        const file = pathJoin(dir, `receipt-${safe}-${Date.now()}.png`);
        await page.screenshot({ path: file, fullPage: true });
        result.order.receiptImage = file;
      } catch { /* 凭证图失败不影响下单结果 */ }
    }
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
  // 每次 selectOption 限时 2.5s：目标下拉可能是隐藏/占位空壳（多个同名 zone select 时会误抓到它），
  // 不加超时则每次失败各卡默认 30s，多次尝试累计数分钟。命中正确下拉时 2.5s 绰绰有余。
  const trySel = async (arg) => {
    try { await sel.selectOption(arg, { timeout: 2500 }); return true; } catch { return false; }
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
  log("⚠️ Could not fully automate. A visible browser window is open with address/card prefilled — please complete the remaining fields (country/state/verification code) and click Pay. (The card number is already filled by the script; no need to type it.)");
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
  // 成功以 URL 为主（Shopify 订单状态页最可靠）：/thank-you /thank_you 或 /orders/<id>。
  if (/\/(thank_you|thank-you)\b/.test(u) || /\/orders\/[A-Za-z0-9]/.test(u)) return "success";
  // 文本兜底：只认强确认措辞（"order is confirmed" / "confirmation #" / 订单已确认），
  // 不用泛泛的 "thank you / 感谢"——营销页/footer 常有，会误判成功。
  if (await page.getByText(/your order is confirmed|order is confirmed|confirmation\s*#|订单已确认|订单确认成功/i).count().catch(() => 0)) return "success";
  // ⚠️ 明确的拒付/错误文案必须【先于】frame 挑战检测：Shopify 收银台常驻一个隐藏 turnstile frame，
  //    若先判 captcha frame 会永远命中它、把"declined"挡在后面 → 拒付探测不到、空转到超时（实测本次）。
  const err = await textOf(
    page.getByText(/declined|incorrect|insufficient funds|not be processed|could not be processed|支付失败|card was declined|余额不足|无法处理/i)
  );
  if (err) { result.signals.formError = err.trim().slice(0, 200); return "declined"; }
  // 地址校验红框（State/国家/邮编未选或无效）→ 可恢复的 address_incomplete，而非误判 pending
  const addrErr = await textOf(page.getByText(/select a (state|province|country)|enter a valid|请选择.*(州|省|国家)|请输入有效/i));
  if (addrErr) { result.signals.addressError = addrErr.trim().slice(0, 120); return "address_incomplete"; }
  const fr = page.frames();
  if (fr.some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.url() || ""))) return "challenge_captcha";
  // 3DS：只认 ACS/3DS 特征 URL；不用宽泛的 secure|authorize（Shopify 正常 iframe 也含这些词→误报）。
  // 注意：frictionless 3DS 也会短暂出现此 iframe，靠调用方“持续 ~10s 才当真挑战”的逻辑区分无感/真挑战。
  if (fr.some((f) => /\b3ds\b|3-?d-?secure|three_?ds|[/.]acs[/.]|acs\d|\/challenge/i.test(f.url() || ""))) return "challenge_3ds";
  return "pending";
}

// 把账单地址归一化为"同收货地址"，兼容两种 Shopify 收银台账单控件：
//   ① 复选框 "Use shipping address as billing address"（id=billingAddressCheckbox / name=billingAddress）
//   ② 单选按钮 "Same as shipping address" / "Use a different billing address"
// 返回是否已置为"同收货"（已是/成功置上=true；控件存在却置不上=false；无已知控件=true 不阻断）。
// 只补齐、绝不反向操作（已勾/已选的不会取消）。
// 勾选"必填的同意/条款"复选框（T&C / 隐私 / 年龄确认 / 加州 P65 等），否则 Continue 点不动、进不了支付页。
// 判定：必填(required/aria-required) 或 label/name/id 含条款同意类词；【严格排除】营销订阅(news/offers/marketing)。
// 返回勾上的数量。只补齐、force 兜底自定义样式复选框；绝不勾可选营销项。
async function acceptRequiredTerms(page, log) {
  let checked = 0;
  const els = await page.locator('input[type="checkbox"],[role="checkbox"]').all().catch(() => []);
  const isCk = async (cb, input) => (input ? await cb.isChecked().catch(() => false) : (await cb.getAttribute("aria-checked").catch(() => "")) === "true");
  for (const cb of els) {
    try {
      const input = ((await cb.getAttribute("role").catch(() => "")) || "") !== "checkbox";
      if (await isCk(cb, input)) continue;
      const name = ((await cb.getAttribute("name").catch(() => "")) || "").toLowerCase();
      const id = ((await cb.getAttribute("id").catch(() => "")) || "").toLowerCase();
      const aria = ((await cb.getAttribute("aria-label").catch(() => "")) || "").toLowerCase();
      // 关联/邻近文本：祖先 label → label[for] → 父容器(div/li/fieldset)文本
      let txt = ((await cb.locator("xpath=ancestor::label[1]").first().textContent().catch(() => "")) || "");
      if (!txt && id) txt = ((await page.locator(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`).first().textContent().catch(() => "")) || "");
      if (!txt) txt = (((await cb.locator("xpath=ancestor::*[self::div or self::li or self::fieldset][1]").first().textContent().catch(() => "")) || "")).slice(0, 220);
      const t = (name + " " + id + " " + aria + " " + txt).toLowerCase();
      if (/market|news|offers|newsletter|subscrib|opt.?in|email me|text me|\bsms\b|promo|recurring automated/.test(t)) continue; // 营销订阅：跳过
      const required = (await cb.getAttribute("required").catch(() => null)) !== null || (await cb.getAttribute("aria-required").catch(() => "")) === "true";
      const termsy = /terms|condition|\bagree|\baccept|i have read|privacy|policy|consent|acknowledg|18\s*year|\bage\b|prop.?65|warning|chemical|\blead\b|cancer|reproductive|birth defect|同意|条款|已阅读|年满|授权/.test(t);
      if (!required && !termsy) continue;
      if (input) {
        await cb.check({ timeout: 2500 }).catch(() => cb.check({ timeout: 2000, force: true }).catch(() => cb.click({ timeout: 1500, force: true }).catch(() => {})));
      } else {
        await cb.click({ timeout: 2000 }).catch(() => cb.click({ timeout: 1500, force: true }).catch(() => {}));
      }
      if (await isCk(cb, input)) checked++;
    } catch { /* 下一个 */ }
  }
  if (checked && log) log(`Accepted ${checked} required agreement/terms checkbox(es)`);
  return checked;
}

// 反应式条款兜底：仅在出现"请接受条款"校验后调用。对未勾的非营销复选框，点其【可见包裹】
// (label[for] → 祖先 label → 父元素)触发 React onChange —— Shopify React 受控框直接改隐藏 input
// 的 checked 不会被框架采纳，必须走真实点击。既然校验已明说要条款，此处对无标签/无属性的框也放行点击。
async function acceptTermsReactive(page, log) {
  let clicked = 0;
  const boxes = await page.locator('input[type="checkbox"]').all().catch(() => []);
  for (const cb of boxes) {
    try {
      if (await cb.isChecked().catch(() => false)) continue;
      const name = ((await cb.getAttribute("name").catch(() => "")) || "").toLowerCase();
      const id = ((await cb.getAttribute("id").catch(() => "")) || "");
      let near = ((await cb.locator("xpath=ancestor::*[self::label or self::div or self::li][1]").first().textContent().catch(() => "")) || "");
      if (!near && id) near = ((await page.locator(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`).first().textContent().catch(() => "")) || "");
      const t = (name + " " + id + " " + near).toLowerCase();
      if (/market|news|offers|newsletter|subscrib|opt.?in|email me|text me|\bsms\b|promo|recurring automated/.test(t)) continue; // 营销订阅：跳过
      // 点可见包裹触发 React：label[for] → 祖先 label → 父元素
      if (id) await page.locator(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`).first().click({ timeout: 1500 }).catch(() => {});
      if (!(await cb.isChecked().catch(() => false))) await cb.locator("xpath=ancestor::label[1]").first().click({ timeout: 1500 }).catch(() => {});
      if (!(await cb.isChecked().catch(() => false))) await cb.locator("xpath=..").first().click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(200);
      if (await cb.isChecked().catch(() => false)) clicked++;
    } catch { /* 下一个 */ }
  }
  if (clicked && log) log(`Reactively accepted ${clicked} terms checkbox(es) via wrapper click`);
  return clicked;
}

async function ensureBillingSameAsShipping(page, log) {
  // ① 标准复选框：默认已勾→原样；未勾→勾上（check 被自定义样式吞掉时点 label 兜底）
  try {
    const cb = page.locator('#billingAddressCheckbox,input[type="checkbox"][name="billingAddress" i]').first();
    if (await cb.count()) {
      if (await cb.isChecked().catch(() => false)) return true;
      await cb.check({ timeout: 3000 }).catch(async () => {
        await page.locator('label[for="billingAddressCheckbox"]').first().click({ timeout: 2000 }).catch(() => {});
      });
      const ok = await cb.isChecked().catch(() => false);
      if (ok && log) log("Billing address set to same as shipping (checkbox)");
      return ok; // 有复选框即以它为准
    }
  } catch { /* 落到 radio 分支 */ }

  // ② 单选按钮式：选中"Same as shipping address"（默认可能选中了"用不同账单地址"，需切回）
  try {
    const sameRadio = page
      .getByRole("radio", { name: /same as shipping|use shipping address as billing|billing.*same as shipping|账单.*(相同|同).*收货|与收货地址相同/i })
      .first();
    if (await sameRadio.count()) {
      if (await sameRadio.isChecked().catch(() => false)) return true;
      await sameRadio.check({ timeout: 3000 }).catch(() => {});
      if (!(await sameRadio.isChecked().catch(() => false))) {
        // check 被自定义样式吞掉时点关联 label 文本兜底
        await page.getByText(/same as shipping address|use shipping address as billing|与收货地址相同/i).first().click({ timeout: 2000 }).catch(() => {});
      }
      const ok = await sameRadio.isChecked().catch(() => false);
      if (ok && log) log("Billing address set to same as shipping (radio)");
      return ok;
    }
  } catch { /* ignore */ }

  // ③ 既无复选框也无已知 radio：多为无独立账单区/默认即同收货——不阻断
  return true;
}

/** 关闭会遮挡卡字段的弹窗（Shop "Confirm it's you" 登录框等） */
// 等配送方式区就绪：骨架占位消失、出现真实单选项后选中第一项，再等 payment 区重渲染落定。
// 关键：Shopify 在配送方式解析完成后会重挂载卡 iframe，过早填卡会被清空（corkcicle 尤甚）。
async function waitShippingReady(page) {
  // 运费方式是下单必需项。这里等它真正加载出可选项并选中；返回 {picked, required}。
  // required=是否存在“Shipping method”区（存在却没选上 = 未就绪，点 Pay 会卡在 Processing）。
  const radios = page.locator('input[type="radio"][name*="delivery" i],input[type="radio"][name*="shipping" i]');
  const heading = page.getByText(/shipping method|delivery method|配送方式|运送方式|shipping options/i);
  // 单一配送方式时 Shopify 新版收银台【不渲染可勾选 radio】，而是把该方式渲染成静态行（默认即选中，
  // 容器 id 含 shipping_methods-<hash>）。只认 radio 会对这类收银台系统性误报 picked=false → 误判
  // shipping_not_ready。故一并识别这类"已渲染出配送方式行"作为"已就绪/默认选中"（仅在无 radio 时启用，
  // 避免与多选项 radio 分支抢答）。
  const methodRow = page.locator('[id*="shipping_method" i],[id*="delivery_method" i]');
  // 经典多步收银台（Cart›Information›Shipping›Payment 分页）：配送在上一步已选，Payment 页无 radio/methodRow，
  // 仅以"Shipping … $X.XX"摘要行呈现。识别【已计价的配送摘要】= 配送已定，避免空等 45s、且防误判 shipping_not_ready。
  // 要求 $ 紧跟 shipping 且带两位小数——避开促销横幅（如 "Order $150 … Free Standard Shipping"，$ 在 shipping 前）。
  const priced = page.getByText(/shipping\b[^$\n]{0,25}\$\s?\d{1,4}[.,]\d{2}/i);
  // 进入即先 blur 一次主动触发算费——越早触发运费请求，就绪越快（否则要等下方周期性 blur）。
  await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
  let picked = false;
  let via = "none"; // 遥测：靠哪条分支判定就绪(radio 多选项 / methodRow 单选项 / priced 经典摘要 / none 未就绪)
  for (let i = 0; i < 150 && !picked; i++) { // 最多 ~45s 等运费率加载（配送必需，尽量等它出来）；命中即退出
    const radioCount = await radios.count().catch(() => 0);
    if (radioCount > 0) {
      const first = radios.first();
      if (await first.isVisible().catch(() => false)) { // 只认可见 radio——"配送不可用"态常留隐藏 radio，会误判就绪
        if (!(await first.isChecked().catch(() => false))) await first.check().catch(() => {});
        picked = await first.isChecked().catch(() => false); // 确认真的选中了才算就绪（check 可能被重渲染吞掉）
        if (picked) { via = "radio"; break; }
      }
    } else if ((await methodRow.count().catch(() => 0)) > 0 && (await methodRow.first().isVisible().catch(() => false))) {
      // 无 radio 但配送方式行已渲染出来（单一方式，默认选中）= 已就绪
      picked = true;
      via = "methodRow";
      break;
    } else if ((await priced.count().catch(() => 0)) > 0 && (await priced.first().isVisible().catch(() => false))) {
      // 经典多步收银台：支付页只有"Shipping … $X.XX"已计价摘要，无配送控件 = 配送已在上一步选定 = 已就绪
      picked = true;
      via = "priced";
      break;
    }
    // 每 ~2.5s 主动 blur 一次，促使 Shopify 重新拉取运费率——骨架长时间卡住常因运费请求没被触发。
    // 早期更勤(每 8 轮≈2.5s)以尽快触发算费；命中即退出，不影响就绪即走。
    if (i > 0 && i % 8 === 0) {
      await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    }
    await page.waitForTimeout(300); // 骨架加载中或该单无配送方式（数字商品/免运费）
  }
  const required = (await heading.count().catch(() => 0)) > 0; // 有运费区标题=本单需要运费方式
  await page.waitForTimeout(350); // 短暂 settle；卡字段被清空由“提交前复检重填”兜底
  return { picked, required, via };
}

// 关掉遮挡结账表单的弹窗，重点是 Shop "Confirm it's you" 登录框：
// 邮箱被识别为已有 Shop 账号时会弹出它（带灰色遮罩，挡住州选择/配送/卡字段）。
// 我们的目标是【跳过登录、以访客身份继续结账】——所以只关闭弹窗，绝不点 "Send code"/"Continue"
//（那会触发 OTP 登录，反而要用户去收验证码）。关闭即免 OTP。
async function dismissOverlays(page) {
  await page.keyboard.press("Escape").catch(() => {});
  const closers = [
    'button[aria-label="Close"]',
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    'button[aria-label*="关闭"]',
    '[role="button"][aria-label*="close" i]',
    '[role="dialog"] button:has-text("✕")',
    '[role="dialog"] button:has-text("×")',
  ];
  for (const sel of closers) {
    try {
      const b = page.locator(sel).first();
      if ((await b.count()) && (await b.isVisible())) await b.click({ timeout: 800 });
    } catch {
      /* ignore */
    }
  }
  // Shop 弹窗常渲染在 shop/pay iframe 内（或其 shadow DOM，Playwright CSS 会自动穿透 open shadow root）
  for (const f of page.frames()) {
    if (/shop|pay/i.test((f.url() || "") + (f.name() || ""))) {
      try {
        const b = f
          .locator('button[aria-label*="close" i], [role="button"][aria-label*="close" i], button:has-text("×"), button:has-text("✕")')
          .first();
        if (await b.count()) await b.click({ timeout: 800 });
      } catch {
        /* ignore */
      }
    }
  }
  await page.waitForTimeout(200);
}

export async function extractOrder(page) {
  const url = page.url();
  const m = url.match(/\/orders\/([^/?#]+)/) || url.match(/order[_-]?(?:number|id)=([^&]+)/i);
  let number = null;
  // 只认明确的订单号格式：Confirmation/Order/订单 后带 # + 字母数字码（如 X0FCMYJAT / 1023）
  const t = await textOf(page.getByText(/(confirmation|order|订单)\s*#\s*[A-Z0-9]{3,}/i));
  if (t) { const mm = t.match(/#\s*([A-Z0-9]{3,})/i); if (mm) number = mm[1]; }
  // 感谢页订单汇总（尽力而为，跨商户可能拿不到）：商品行 + 合计
  const items = await page
    .locator('[class*="summary"] [class*="product"], [aria-label*="order summary" i] li, [role="table"] [role="row"]')
    .evaluateAll((els) =>
      els
        .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
        .filter((s) => s && s.length < 160)
        .slice(0, 10)
    )
    .catch(() => []);
  // 感谢页金额明细（权威最终扣款额只在此处：--amount 只是商品价，运费/税是收银台结算才加的）。
  // 对订单汇总区整段文本做正则：兼容“标签与金额连写”（如 igloocoolers 的 "TotalUSD$24.63"），
  // \b 词边界在这种连写下会失配，故改用“标签 + 少量非数字字符 + 货币金额”。
  let sumText = await textOf(page.locator('[aria-label*="order summary" i],[class*="order-summary" i],[class*="summary" i]').first());
  if (!sumText || !/[£$€¥]/.test(sumText)) sumText = (await page.locator("body").textContent().catch(() => "")) || "";
  sumText = sumText.replace(/\s+/g, " ");
  const pick = (re) => { const mm = sumText.match(re); return mm ? mm[1].replace(/\s/g, "") : null; };
  const CUR = "([£$€¥][\\d,]+\\.\\d{2})";
  const subtotal = pick(new RegExp("subtotal\\D{0,12}?" + CUR, "i"));
  const shippingFee = pick(new RegExp("(?:shipping|delivery)\\D{0,20}?" + CUR, "i"));
  const tax = pick(new RegExp("tax(?:es)?\\D{0,12}?" + CUR, "i"));
  // 合计：Total 但排除 Subtotal（lookbehind），取其后第一个货币金额
  const total = pick(new RegExp("(?<!sub)total\\D{0,12}?" + CUR, "i"));
  // 配送方式（"Shipping method" 标题下一行）
  const shippingMethod = await textOf(
    page.getByText(/shipping method|配送方式|运送方式/i).locator("xpath=following::*[1]")
  );
  let merchant = null;
  try { merchant = new URL(url).host.replace(/\.myshopify\.com$/, "") || null; } catch { /* ignore */ }
  return {
    url,
    id: m ? m[1] : null,
    number,
    merchant,
    items: items.length ? items : null,
    subtotal: subtotal || null,
    shippingFee: shippingFee || null,
    tax: tax || null,
    total: total || null,
    shippingMethod: shippingMethod ? shippingMethod.replace(/\s+/g, " ").trim().slice(0, 80) : null,
  };
}

// 加载 playwright（购物/收银台自动化所需），带【运行时自愈】：
// 全局包被后台自动更新重装后，optionalDependencies 的 playwright 常半截安装
// （本包内 node_modules/playwright 残缺 / playwright-core 缺失），import 失败。
// 此处失败即尝试 npm i -g playwright 修复；本包内若残留【损坏】副本会遮蔽全局解析，删之令其回退。
// 修复完成后重试；ESM 可能缓存失败解析 → 明确提示重跑（安装已就绪，下次即可用）。
// 解析代理 URL → Playwright proxy 配置。支持 http(s)/socks5，含可选 user:pass@。无效/空则返回 null（直连）。
function parseProxy(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    const server = `${u.protocol}//${u.host}`; // 含端口；协议保留 http/https/socks5
    const proxy = { server };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return null;
  }
}

export async function loadPlaywrightChromium(log) {
  const say = log || (() => {});
  try {
    return (await import("playwright")).chromium;
  } catch (e1) {
    const d1 = (e1?.message || "").split("\n")[0];
    say("Failed to load playwright; attempting auto-repair (npm i -g playwright)…: " + d1);
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("npm", ["i", "-g", "playwright"], { stdio: ["ignore", 2, 2], timeout: 300000 });
    } catch (ie) {
      throw new FillError(
        "PLAYWRIGHT_MISSING",
        `Failed to load playwright and auto-repair was unsuccessful (${d1}). Please run manually: npm i -g playwright (add sudo if you lack permissions); if needed, then run npx playwright install chromium`
      );
    }
    // 删掉本包内【损坏】的 playwright/playwright-core 副本（无 package.json）——它会遮蔽刚装好的全局副本
    try {
      const pkgNM = pathResolve(fileURLToPath(import.meta.url), "../../../node_modules");
      for (const dep of ["playwright", "playwright-core"]) {
        const dp = pathJoin(pkgNM, dep);
        if (existsSync(dp) && !existsSync(pathJoin(dp, "package.json"))) rmSync(dp, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
    try {
      say("playwright repaired; retrying load…");
      return (await import("playwright")).chromium;
    } catch {
      throw new FillError("PLAYWRIGHT_REPAIRED_RERUN", "playwright has been auto-repaired; please re-run the previous command.");
    }
  }
}

// 启动浏览器；若浏览器内核未下载（常见于纯发卡用户首次购物），懒加载自动下 chromium 后重试。
// 进度输出走 stderr（fd 2），保持 stdout 的一行 JSON envelope 干净。
export async function launchWithAutoInstall(chromium, opts, log) {
  try {
    return await chromium.launch(opts);
  } catch (e) {
    const msg = String(e?.message || "");
    if (!/Executable doesn't exist|playwright install|please run|download new browsers/i.test(msg)) throw e;
    log("First purchase: downloading browser engine chromium (~150MB, one-time, reused after)…");
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npx", ["--yes", "playwright", "install", "chromium"], { stdio: ["ignore", 2, 2], timeout: 300000 });
    } catch (ie) {
      throw new FillError(
        "BROWSER_INSTALL_FAILED",
        "Browser engine auto-download failed. Please run manually: npx playwright install chromium (" + String(ie.message).split("\n")[0] + ")"
      );
    }
    log("Browser engine ready, continuing payment…");
    return await chromium.launch(opts);
  }
}

async function finish(browser, result) {
  await browser.close().catch(() => {});
  return result;
}
