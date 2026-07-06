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
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { homedir } from "node:os";
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
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new FillError("PLAYWRIGHT_MISSING", "未安装 playwright。请运行：npm i -g playwright && npx playwright install chromium");
  }

  if (!p.continueUrl) throw new FillError("NO_URL", "缺少 continueUrl");
  if (!p.card?.number || !p.card?.expiry || !p.card?.cvc) throw new FillError("NO_CARD", "缺少完整卡面");

  const outDir = pathResolve(p.outDir || "./artifacts");
  const otpFile = pathResolve(p.otpFile || "/tmp/aicard-otp.txt");
  const waitOtpMs = Number(p.waitOtpMs || 0);
  const log = p.onProgress || (() => {});
  mkdirSync(outDir, { recursive: true });
  if (existsSync(otpFile)) rmSync(otpFile);

  const A = p.address || {};
  const result = { outcome: null, signals: {}, artifacts: [], order: null };
  const _t0 = Date.now();
  const _perf = (s) => { if (process.env.AICARD_PERF) console.error(`[perf] ${s}: ${((Date.now() - _t0) / 1000).toFixed(1)}s`); };

  const browser = await launchWithAutoInstall(chromium, {
    headless: !(p.headful || p.assist), // assist 兜底模式强制可见窗口，让用户手动完成
    args: ["--disable-blink-features=AutomationControlled"],
  }, log);
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
        await el.type(String(val), { delay: 30 });
        await page.waitForTimeout(500); // 等自动补全下拉渲染
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
    await page.waitForTimeout(800);
    await shot("01-open");

    // 收银台有效性早检（两段，避免误杀“正在加载骨架”的有效收银台）：
    // ① 立即检测明确死链文案——死链（404）会即时显示错误页；用 checkout/payment 关键词兜底防误判。
    const earlyBody = (await page.locator("body").textContent().catch(() => "")) || "";
    if (/\b404\b|not found|page not found|页面不存在|无法找到/i.test(earlyBody) && !/checkout|payment|shipping|收银|付款/i.test(earlyBody)) {
      result.outcome = "checkout_unavailable";
      result.signals.reason = "收银台链接无效或已过期（404）。请用 `shop cart` 重新生成 continueUrl 后再付款。";
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
      result.outcome = "checkout_unavailable";
      result.signals.reason = "收银台表单加载失败（重载后仍未出现表单，多为网络异常或链接失效）。请检查网络或用 `shop cart` 重新生成 continueUrl。";
      await shot("01b-unavailable");
      return finish(browser, result);
    }

    // 国家（先选，电话/邮编校验依赖它）——等 options 加载 + label/ISO 代码多重匹配 + 切换后等字段重渲染
    if (A.country) {
      const country = page.locator('select[autocomplete="country"],select[name*="countryCode" i],select[name*="country" i]').first();
      if (await country.count()) {
        try {
          await country.waitFor({ state: "visible", timeout: 6000 });
          await page.waitForTimeout(200);
          const cc = COUNTRY_CODES[A.country.toLowerCase()] || (/^[a-z]{2}$/i.test(A.country.trim()) ? A.country.trim().toUpperCase() : null);
          result.signals.countrySelected = await selectOptionSmart(country, A.country, cc);
          await page.waitForTimeout(400); // 国家切换后地址/电话字段会重渲染
        } catch {
          result.signals.countrySelected = false;
        }
      }
    }
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

    // 填完邮箱后，Shop 可能弹出 "Confirm it's you" 登录框（灰色遮罩挡住州选择/配送/卡字段）。
    // 在选州之前就关掉它 = 跳过登录、以访客继续（免 OTP）。稍等它渲染出来再关。
    await page.waitForTimeout(600);
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
      if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(1500); }
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
      result.signals.reason = `收银台配送不可用：${shipErr.slice(0, 160)}（常见于批发店最低起订额/重量门槛；未填卡、未扣款）。请调整购物车数量/金额或换商户。`;
      await shot("03b-shipping-unavailable");
      if (!p.assist) return finish(browser, result);
    }

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
        result.signals.reason = "该商户不支持信用卡/借记卡付款（仅 PayPal 等钱包），虚拟卡无法使用。请换一家支持信用卡的商户。";
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
            await inp.click();
            await inp.fill("").catch(() => {});
            await inp.type(String(p.card[k]), { delay: 40 });
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
      result.signals.reason = "配送方式未加载出来（收银台运费率未就绪，点付款会卡住）。未提交付款、未扣款——请重试（用 `shop cart` 重新生成 continueUrl 后再 pay）。";
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

    // 3DS/验证码降级：等待用户把验证码写入 otpFile 后自动回填
    if ((outcome === "challenge_3ds" || outcome === "challenge_captcha") && waitOtpMs > 0) {
      result.signals.challenge = outcome;
      await shot("07-challenge");
      // 多步 3DS（如 UQPAY：选认证方式 → Next → OTP 发到邮箱）：枚举所有 frame 的可点击元素，按文本匹配点前进按钮触发发码
      await page.waitForTimeout(2000); // 等 3DS iframe 加载
      let advanced = false;
      for (let round = 0; round < 2 && !advanced; round++) {
        for (const fr of page.frames()) {
          const cands = await fr.locator('button, input[type="submit"], input[type="button"], [role="button"], a').all().catch(() => []);
          for (const c of cands) {
            try {
              const t = (((await c.textContent().catch(() => "")) || "") + " " + ((await c.getAttribute("value").catch(() => "")) || "")).trim().toLowerCase();
              if (/next|continue|获取|下一步|submit|verify|confirm|proceed|send|发送|确定/.test(t) && (await c.isVisible().catch(() => false))) {
                await c.click({ timeout: 3000 });
                advanced = true;
                result.signals.threeDSAdvanced = t.slice(0, 24);
                log("Clicked 3DS advance button: " + t.slice(0, 24));
                await page.waitForTimeout(3000);
                break;
              }
            } catch { /* 下一个 */ }
          }
          if (advanced) break;
        }
        if (!advanced) await page.waitForTimeout(1500);
      }
      if (!advanced) result.signals.threeDSAdvanced = false;
      await shot("07b-otp-step");
      log(`Verification code required (${outcome}). Send triggered — please provide the code; it will be written to ${otpFile} and filled in.`);
      const deadline = Date.now() + waitOtpMs;
      let filled = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2500);
        if (!filled && existsSync(otpFile)) {
          const code = readFileSync(otpFile, "utf8").trim();
          if (code) {
            log("Verification code received, filling in…");
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
  const fr = page.frames();
  if (fr.some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.url() || ""))) return "challenge_captcha";
  // 3DS：只认 ACS/3DS 特征 URL；不用宽泛的 secure|authorize（Shopify 正常 iframe 也含这些词→误报）。
  // 注意：frictionless 3DS 也会短暂出现此 iframe，靠调用方“持续 ~10s 才当真挑战”的逻辑区分无感/真挑战。
  if (fr.some((f) => /\b3ds\b|3-?d-?secure|three_?ds|[/.]acs[/.]|acs\d|\/challenge/i.test(f.url() || ""))) return "challenge_3ds";
  const err = await textOf(page.getByText(/declined|incorrect|被拒|not be processed|支付失败|card was declined/i));
  if (err) { result.signals.formError = err.trim().slice(0, 200); return "declined"; }
  // 地址校验红框（State/国家/邮编未选或无效）→ 可恢复的 address_incomplete，而非误判 pending
  const addrErr = await textOf(page.getByText(/select a (state|province|country)|enter a valid|请选择.*(州|省|国家)|请输入有效/i));
  if (addrErr) { result.signals.addressError = addrErr.trim().slice(0, 120); return "address_incomplete"; }
  return "pending";
}

/** 关闭会遮挡卡字段的弹窗（Shop "Confirm it's you" 登录框等） */
// 等配送方式区就绪：骨架占位消失、出现真实单选项后选中第一项，再等 payment 区重渲染落定。
// 关键：Shopify 在配送方式解析完成后会重挂载卡 iframe，过早填卡会被清空（corkcicle 尤甚）。
async function waitShippingReady(page) {
  // 运费方式是下单必需项。这里等它真正加载出可选项并选中；返回 {picked, required}。
  // required=是否存在“Shipping method”区（存在却没选上 = 未就绪，点 Pay 会卡在 Processing）。
  const radios = page.locator('input[type="radio"][name*="delivery" i],input[type="radio"][name*="shipping" i]');
  const heading = page.getByText(/shipping method|delivery method|配送方式|运送方式|shipping options/i);
  let picked = false;
  for (let i = 0; i < 150 && !picked; i++) { // 最多 ~45s 等运费率加载（配送必需，尽量等它出来）；命中即退出
    if ((await radios.count().catch(() => 0)) > 0) {
      const first = radios.first();
      if (await first.isVisible().catch(() => false)) { // 只认可见 radio——"配送不可用"态常留隐藏 radio，会误判就绪
        if (!(await first.isChecked().catch(() => false))) await first.check().catch(() => {});
        picked = await first.isChecked().catch(() => false); // 确认真的选中了才算就绪（check 可能被重渲染吞掉）
        if (picked) break;
      }
    }
    // 每 ~5s 主动 blur 当前字段一次，促使 Shopify 重新拉取运费率——骨架长时间卡住常因运费请求没被触发
    if (i > 0 && i % 16 === 0) {
      await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    }
    await page.waitForTimeout(300); // 骨架加载中或该单无配送方式（数字商品/免运费）
  }
  const required = (await heading.count().catch(() => 0)) > 0; // 有运费区标题=本单需要运费方式
  await page.waitForTimeout(500); // 短暂 settle；卡字段被清空由“提交前复检重填”兜底
  return { picked, required };
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
  await page.waitForTimeout(300);
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

// 启动浏览器；若浏览器内核未下载（常见于纯发卡用户首次购物），懒加载自动下 chromium 后重试。
// 进度输出走 stderr（fd 2），保持 stdout 的一行 JSON envelope 干净。
async function launchWithAutoInstall(chromium, opts, log) {
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
        "浏览器内核自动下载失败，请手动运行：npx playwright install chromium（" + String(ie.message).split("\n")[0] + "）"
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
