/**
 * `aicard shop` 命令族：Shopify 购物闭环编排
 *   search → cart → pay（发卡+填卡付款）→ track
 *
 * 每个子命令输出标准 envelope，供 skill 层做 C 端引导。
 * 卡面数据只在 pay 内部内存流转，envelope 只回末 4 位。
 */
import { emitOk, emitErr, logInfo } from "../output.mjs";

/** 语义搜索商品（不带 --shop 走全网 Global，带则限定单店 Storefront） */
export async function search(opts) {
  try {
    const { searchCatalog } = await import("../shop/catalog.mjs");
    const r = await searchCatalog({
      query: opts.query,
      shopDomain: opts.shop,
      country: opts.country,
      maxPriceMinor: opts.maxPrice ? Math.round(parseFloat(opts.maxPrice) * 100) : undefined,
      available: true,
      limit: opts.limit ? Number(opts.limit) : 30,
      cursor: opts.cursor,
      excludeTest: !opts.includeTest,
      requireCard: true, // 只支持信用卡：选品阶段就剔除不收卡/无法确认收卡的商户（虚拟卡只能用于收卡店）
      sort: opts.sort,
    });
    // 富展示产物：--html 出可点击 HTML（可作 Artifact）；--image 出 PNG（内联自动显示、零点击）。
    let htmlPath = null;
    let imagePath = null;
    if (opts.html || opts.image) {
      const { renderProductsHtml, renderHtmlToImage } = await import("../shop/render.mjs");
      const { writeFileSync } = await import("node:fs");
      const html = await renderProductsHtml(r.products, { title: `Results for “${opts.query}”` });
      if (opts.html) { writeFileSync(opts.html, html); htmlPath = opts.html; }
      if (opts.image) { await renderHtmlToImage(html, opts.image, { log: (m) => logInfo("> " + m) }); imagePath = opts.image; }
    }
    emitOk("shop.search", {
      scope: r.scope,
      count: r.products.length,
      excludedTest: r.excludedTestCount || 0,
      excludedNoCard: r.excludedNoCard || 0, // 被剔除的【确认不收信用卡】商户数（无法确认的不剔除、予以保留）
      sortedBy: r.sortedBy || "relevance",
      hasNext: r.hasNext,
      cursor: r.cursor,
      ...(htmlPath ? { htmlPath } : {}),
      ...(imagePath ? { imagePath } : {}),
      products: r.products,
    });
  } catch (e) {
    emitErr("shop.search", e.code || "SHOP_SEARCH_FAILED", { message: e.message, retryAfter: e.retryAfter });
  }
}

/** 商品详情：get_product → 规格(颜色/尺码)/描述/图/可选 variants，供用户选规格 */
export async function product(opts) {
  try {
    if (!opts.id) return emitErr("shop.product", "MISSING_ID", { message: "Missing --id (product gid, from the productId in search results)" });
    const { getProduct } = await import("../shop/catalog.mjs");
    const p = await getProduct({ id: opts.id, shopDomain: opts.shop });

    let htmlPath = null;
    if (opts.html) {
      const { writeFileSync } = await import("node:fs");
      const { renderProductHtml } = await import("../shop/render.mjs");
      const html = await renderProductHtml(
        { ...p, image: p.images?.[0], specText: p.variants[0]?.description || p.description },
        { buyPrompt: `Buy ${p.title}` }
      );
      writeFileSync(opts.html, html);
      htmlPath = opts.html;
    }

    emitOk("shop.product", {
      title: p.title,
      description: p.description,
      priceMin: p.priceMin,
      priceMax: p.priceMax,
      currency: p.currency,
      merchantDomain: p.merchantDomain,
      merchantName: p.merchantName,
      detailUrl: p.detailUrl,
      images: p.images,
      options: p.options, // 规格维度：颜色/尺码等（含每个值是否有货）
      specText: p.variants[0]?.description || p.description, // 详细规格文字（材质/克重/产地/洗涤）
      variantCount: p.variants.length,
      // 每个规格组合 → variantId（供选规格后拼单）
      variants: p.variants.map((v) => ({ variantId: v.variantId, options: v.options, price: v.price, available: v.available })),
      ...(htmlPath ? { htmlPath } : {}),
    });
  } catch (e) {
    emitErr("shop.product", e.code || "SHOP_PRODUCT_FAILED", { message: e.message });
  }
}

/** 拼单算价：create_cart → totals + continueUrl */
export async function cart(opts) {
  try {
    if (!opts.shop) return emitErr("shop.cart", "MISSING_SHOP", { message: "Missing --shop (merchant domain, from the merchantDomain in search results)" });
    if (!opts.variant) return emitErr("shop.cart", "MISSING_VARIANT", { message: "Missing --variant (product variant gid, from search results)" });
    const { createCart } = await import("../shop/cart.mjs");
    const { isTestStore } = await import("../shop/catalog.mjs");
    const c = await createCart({
      shopDomain: opts.shop,
      items: [{ variantId: opts.variant, quantity: opts.qty ? Number(opts.qty) : 1 }],
      address: { country: opts.country, region: opts.region, postalCode: opts.zip },
    });
    // 检测收银台真实后端：vanity 域名（如 naturallife.com）可能套在测试店（twinoakstest.myshopify.com）上，
    // 只有 continueUrl 才暴露后端。标记出来，供 pay 拦截 / 用户知情。
    const backendHost = (() => { try { return new URL(c.continueUrl).host; } catch { return null; } })();
    const testBackend = isTestStore(backendHost);
    emitOk("shop.cart", {
      cartId: c.cartId,
      currency: c.currency,
      subtotal: c.subtotal,
      tax: c.tax,
      shipping: c.shipping,
      total: c.total,
      continueUrl: c.continueUrl,
      backendHost,
      testBackend, // true = 收银台后端是测试店（如 twinoakstest），下单非真实交易
      acceptsCard: c.acceptsCard, // false = 该商户不收信用卡（仅 PayPal 等钱包），虚拟卡无法付款
      paymentMethods: c.paymentMethods,
      ...(testBackend ? { warning: `⚠️ This merchant's checkout backend is a test store (${backendHost}); placing an order is not a real transaction. shop pay blocks this by default; add --allow-test if you really need to test.` } : {}),
      ...(c.acceptsCard === false ? { warning: "⚠️ This merchant does not accept credit cards (only " + (c.paymentMethods || []).join("/") + "); the virtual card cannot be used to pay. Please switch to a merchant that accepts credit cards." } : {}),
      lineItems: c.lineItems,
      expiresAt: c.expiresAt,
    });
  } catch (e) {
    // variant 不存在：多因把 Global 目录的 variant 丢给 storefront。给可操作提示。
    const notFound = /does not exist|not found/i.test(e.message || "") && /variant/i.test(JSON.stringify(e.messages || e.message || ""));
    emitErr("shop.cart", notFound ? "VARIANT_NOT_FOUND" : e.code || "SHOP_CART_FAILED", {
      message: e.message,
      ...(e.messages ? { messages: e.messages } : {}),
      ...(notFound ? { hint: "This variant does not exist at this merchant. Use `shop search --shop <this merchant domain> --query \"<product name>\"` to fetch this store's variantId, then build the cart (do not use variants from the Global get_product, as they may not match the storefront)." } : {}),
      retryAfter: e.retryAfter,
    });
  }
}

/** 发卡 + 填卡付款：issueCard（完整卡面内存）→ fillCheckout（真实提交） */
export async function pay(opts) {
  try {
    if (!opts.continueUrl) return emitErr("shop.pay", "NO_URL", { message: "Missing --continue-url (from the continueUrl in shop cart)" });
    const amount = opts.amount != null ? Number(opts.amount) : null;
    if (!amount || isNaN(amount) || amount <= 0) return emitErr("shop.pay", "NO_AMOUNT", { message: "Missing or invalid --amount (must equal the cart total, a positive number)" });

    // 拦截测试店：continueUrl 的后端 host 才是真实收银台后端（vanity 域名可能套在 twinoakstest 等测试店上）。
    // 默认禁用测试商家；确需测试用 --allow-test 放行。
    const backendHost = (() => { try { return new URL(opts.continueUrl).host; } catch { return null; } })();
    const { isTestStore } = await import("../shop/catalog.mjs");
    if (isTestStore(backendHost) && !opts.allowTest) {
      return emitErr("shop.pay", "TEST_STORE_BLOCKED", {
        message: `This merchant's checkout backend is a test store (${backendHost}); placing an order is not a real transaction. Please notify the user and ask whether to continue; once the user confirms, rerun with --allow-test to proceed.`,
        backendHost,
        needsConfirm: true, // 非死路：这是"确认门"，用户同意后 --allow-test 放行
      });
    }

    // 收货信息严格校验 → 结构化错误（逻辑严谨，一次性列出所有缺失）
    const shipping = { email: opts.email, first: opts.first, last: opts.last, address1: opts.address1, city: opts.city, zip: opts.zip, country: opts.country, phone: opts.phone };
    const REQUIRED = ["email", "first", "last", "address1", "city", "zip", "country", "phone"];
    const missing = REQUIRED.filter((k) => !shipping[k] || !String(shipping[k]).trim());
    if (missing.length) return emitErr("shop.pay", "MISSING_SHIPPING_FIELDS", { message: `Missing shipping information: ${missing.join(", ")}`, missing });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(shipping.email).trim()))
      return emitErr("shop.pay", "INVALID_EMAIL", { message: "Invalid email format (must be the user's own real email, used to receive order/shipping notices)", field: "email" });

    // country 值有效性前置校验（是否已知国家名/ISO 代码）；"该店是否配送该国家"仍需收银台运行时确认
    const { COUNTRY_CODES, COUNTRIES } = await import("../shop/country-data.mjs");
    const cin = String(shipping.country).trim().toLowerCase();
    const countryValid = !!COUNTRY_CODES[cin] || COUNTRIES.some((c) => {
      const n = c.name.toLowerCase();
      return c.code.toLowerCase() === cin || n === cin || (cin.length >= 3 && n.includes(cin));
    });
    if (!countryValid)
      return emitErr("shop.pay", "INVALID_COUNTRY", { message: `Country '${shipping.country}' is not a known country name or ISO code (examples: United States / US / Hong Kong / GB)`, field: "country" });

    const { findUsableCard, markCardUsed } = await import("../shop/cards.mjs");
    const { fillCheckout, appendStepEvent } = await import("../shop/checkout-filler.mjs");

    // 实时步骤事件流（可选）：agent 后台跑 shop pay + tail 此文件，逐步呈现进度。
    // shop.mjs 负责重置文件并写 checkout 之前的 issue_card 事件；fillCheckout 只向其追加收银台各步。
    const progressFile = opts.progressFile ? String(opts.progressFile) : null;
    if (progressFile) { try { const { rmSync, existsSync } = await import("node:fs"); if (existsSync(progressFile)) rmSync(progressFile); } catch {} }
    const step = (event) => appendStepEvent(progressFile, event);

    // 1. 先用本地可用卡（面额够且未用）→ 命中则跳过钱包，直接付款
    let card = findUsableCard(amount);
    let orderNo = card?.orderNo || null;
    let cardSource = "cache";

    // 2. 无可用卡 → 发新卡（需钱包 USDT）。一次性卡模型下"卡充值"即"发新卡"。
    step({ evt: "step", id: "issue_card", label: "Issue card", status: "running" });
    if (!card) {
      logInfo("> No usable cached card; issuing a new card (charging USDT from wallet)...");
      const { issueCard } = await import("../shop/card-issuer.mjs");
      try {
        const issued = await issueCard({ amount, appId: opts.appId, serviceUrl: opts.serviceUrl, privateKey: opts.privateKey, autoFund: true });
        card = issued.card;
        orderNo = issued.orderNo;
        cardSource = "new";
      } catch (e) {
        step({ evt: "step", id: "issue_card", label: "Issue card", status: "failed", note: e.code || "CARD_ISSUE_FAILED" });
        // 分级降级：钱包不足/缺 gas/未配置 → 明确指引下一步
        const hint = {
          INSUFFICIENT_USDT: "Insufficient USDT in wallet. Please fund the wallet first: aicard topup --amount <n>",
          NEEDS_APPROVE_GAS: "Local wallet lacks BNB for the first approve. Please run first: aicard gas",
          WALLET_NOT_CONFIGURED: "Wallet not configured. Please run first: aicard setup --check",
          AMOUNT_OUT_OF_RANGE: "This order's amount is outside the per-card issuable range $0.6~$800. Please change the product or split the order (the amount must equal the cart total and cannot be adjusted separately).",
        }[e.code];
        return emitErr("shop.pay", e.code || "CARD_ISSUE_FAILED", {
          message: e.message,
          ...(hint ? { hint } : {}),
          ...(e.required != null ? { required: e.required, available: e.available } : {}),
        });
      }
    } else {
      logInfo(`> Using cached card •••• ${String(card.number).slice(-4)} (face $${card.amount}); paying directly, wallet untouched.`);
    }
    step({ evt: "step", id: "issue_card", label: "Issue card", status: "done", note: cardSource === "new" ? `Issued new card •••• ${String(card.number).slice(-4)}` : `Reused cached card •••• ${String(card.number).slice(-4)}` });

    // 3. 填卡付款
    const address = {
      email: opts.email,
      country: opts.country,
      region: opts.region,
      first: opts.first,
      last: opts.last,
      address1: opts.address1,
      address2: opts.address2,
      city: opts.city,
      zip: opts.zip,
      phone: opts.phone,
    };
    logInfo("> Opening checkout and auto-filling card to pay...");
    const r = await fillCheckout({
      continueUrl: opts.continueUrl,
      address,
      card,
      headful: !!opts.headful,
      assist: !!opts.assist,
      noSubmit: !!opts.fillOnly,
      waitOtpMs: opts.waitOtp ? Number(opts.waitOtp) : 0,
      otpFile: opts.otpFile,
      outDir: opts.out,
      progressFile, // 收银台各步事件追加到此文件（实时流）
      onProgress: (m) => logInfo("> " + m),
    });

    // 4. 支付成功 → 标记一次性卡已用（退出可用列表）
    if (r.outcome === "success" && orderNo) markCardUsed(orderNo, { usedFor: opts.continueUrl });

    // 根据结果给下一步建议：区分「可 assist 恢复」与「不可恢复（配送限制等）」
    let suggestion = null;
    const avail = r.signals?.availableCountries;
    const cc = String(opts.country || "").toLowerCase();
    const shipUnsupported =
      r.outcome === "address_incomplete" &&
      Array.isArray(avail) &&
      avail.length > 0 &&
      !avail.some((c) => c.toLowerCase().includes(cc) || cc.includes(c.toLowerCase()));
    // 🚫 铁律：脚本【绝不自动重试付款】。任何非成功结果只报告状态，是否再下单完全由用户决定。
    //    这是防重复扣款的根本保证（尤其点过 Pay 后结果不明时，重跑=重复扣款）。
    const paid = !!r.signals?.paySubmitted;
    if (r.outcome === "success") {
      // 成功，无需建议
    } else if (r.outcome === "challenge_3ds" || r.outcome === "challenge_captcha") {
      // 真 3DS 挑战：验证未完成 = 未授权 = 未扣款。完成方式=用一次后台 --wait-otp 会话式回填验证码
      //（这不是盲目重试；abandoned 3DS 不产生扣款，故安全）。
      suggestion =
        "This order requires a 3DS verification code (the current verification is incomplete = not authorized = not charged). To complete it: switch to the background " +
        "`aicard shop pay --wait-otp 600000 …` (same parameters) and run once more; when it asks “please give me the verification code”, `echo` the code to " +
        "/tmp/aicard-otp.txt to auto-fill it. Never rerun repeatedly without --wait-otp.";
    } else if (paid) {
      // pending / error：点过 Pay 但结果真不明 → 危险，禁止重跑
      suggestion =
        `⚠️ Payment was submitted but the result is unconfirmed (${r.outcome}) — the funds [may already have been charged]. ` +
        `Do NOT rerun shop pay (it would double-charge). Please first verify whether the transaction went through ` +
        `(confirmation email in the shipping inbox / local ~/.aicard/receipts proof image / merchant order page), then decide what to do next.`;
    } else if (r.outcome === "declined") {
      suggestion = "Card was declined (not charged). The script does not auto-retry; if you want to switch cards or change details, reinitiate it yourself.";
    } else if (r.outcome === "card_not_supported") {
      // 未点付款、未扣款：商户只收 PayPal/钱包，不收信用卡，虚拟卡用不了 → 只能换商户
      suggestion = "This merchant does not support credit/debit cards (only wallets like PayPal); the virtual card cannot be used (not charged). Please switch to a merchant that accepts credit card payment. Even assist cannot conjure a card option.";
    } else if (r.outcome === "shipping_not_ready") {
      suggestion = "The shipping method never loaded (waited as long as possible; not charged, no order placed). The script does not auto-retry; whether to reinitiate later is up to you.";
    } else if (r.outcome === "checkout_unavailable") {
      suggestion = "The checkout link is invalid/expired (not charged). The script does not auto-retry; if you want to continue, regenerate the continueUrl and reinitiate it yourself.";
    } else if (shipUnsupported) {
      suggestion = `This merchant only ships to: ${avail.slice(0, 6).join(", ")}${avail.length > 6 ? " …" : ""} — the shipping country is not among them (not charged). Please change the shipping country or switch merchants.`;
    } else if (["fill_failed", "no_card_iframe", "address_incomplete"].includes(r.outcome)) {
      suggestion = "Form filling did not complete and payment was not submitted (not charged). The script does not auto-retry; you can complete this order manually with --assist, or reinitiate it.";
    }

    // 支付成功 → 组装结构化收据（收货/金额来自入参，卡末4/结果来自结果，确认号/明细/凭证图来自感谢页）
    const shipAddr = [opts.address1, opts.address2, opts.city, opts.region, opts.zip, opts.country].filter(Boolean).join(", ");
    const receipt =
      r.outcome === "success"
        ? {
            status: "confirmed",
            merchant: r.order?.merchant || (() => { try { return new URL(opts.continueUrl).host.replace(/\.myshopify\.com$/, ""); } catch { return null; } })(),
            orderNumber: r.order?.number || null,
            orderUrl: r.order?.url || null,
            orderUrlDurable: false, // ⚠️ 实测：感谢页 URL 会话绑定，新浏览器打开会被弹回首页要求登录，不可二次打开
            purchasedAt: new Date().toISOString(),
            // 卡实扣总额：优先感谢页最终 total（含运费/税，权威）；抓不到才回退 --amount（仅商品价，可能偏小）。
            amountCharged: r.order?.total || `$${amount}`,
            amountSource: r.order?.total ? "checkout_total" : "cli_amount_fallback",
            currency: "USD",
            subtotal: r.order?.subtotal || null,
            shippingFee: r.order?.shippingFee || null,
            tax: r.order?.tax || null,
            total: r.order?.total || null,
            items: r.order?.items || null,
            shippingMethod: r.order?.shippingMethod || null,
            payment: {
              scheme: card.scheme,
              last4: String(card.number).slice(-4),
              source: cardSource,
              // 人类可读文案直接进数据，避免渲染时丢失
              note: cardSource === "cache" ? "Reused a cached card; no new card issued, wallet untouched" : "Issued a new virtual card (USDT charged from wallet)",
            },
            shipTo: { name: `${opts.first} ${opts.last}`.trim(), email: opts.email, phone: opts.phone, address: shipAddr },
            billingSameAsShipping: true,
            proofImage: r.order?.receiptImage || null, // 本地付款凭证图（感谢页截图），持久留档/售后用
            reopenVia: [
              "The View your order link in the merchant confirmation email (sent to the shipping inbox) — durable and reopenable",
              "The thank-you page's Download to track with Shop (Shop app, requires a Shop account)",
              "The local proofImage receipt image (offline record)",
            ],
            note: "Browser-path web order: orderNumber is the merchant confirmation number (not a Shopify API Global ID) and cannot be queried with get_order. orderUrl is session-bound and cannot be reopened; to view again, use reopenVia.",
          }
        : null;

    // 终态步骤事件（收据）：收尾实时流，供 agent 呈现最终结果
    step({
      evt: "step",
      id: "receipt",
      label: "Receipt",
      status: r.outcome === "success" ? "done" : "skipped",
      ...(receipt?.orderNumber ? { note: `Order ${receipt.orderNumber}` } : { note: r.outcome }),
    });

    // 下单流程时间线 HTML（自包含，Artifact 直显）。【安全】渲染器只嵌无卡面截图，
    // 填卡节点仅"已打码"占位，绝不内嵌 05-card-filled（含明文卡号/CVC）。
    let timelineHtmlPath = null;
    if (opts.html) {
      try {
        const { writeFileSync } = await import("node:fs");
        const { renderOrderTimelineHtml } = await import("../shop/render.mjs");
        const html = await renderOrderTimelineHtml(r, receipt, {
          title: `Order flow — ${receipt?.merchant || (() => { try { return new URL(opts.continueUrl).host; } catch { return "checkout"; } })()}`,
          card: { source: cardSource, last4: String(card.number).slice(-4), amount },
        });
        writeFileSync(opts.html, html);
        timelineHtmlPath = opts.html;
      } catch (e) {
        logInfo(`> Timeline render failed (non-fatal): ${e.message}`);
      }
    }

    // 卡面绝不进 envelope，只回末 4 位与结果
    emitOk("shop.pay", {
      cardSource,
      cardOrderNo: orderNo,
      cardLast4: String(card.number).slice(-4),
      cardScheme: card.scheme,
      outcome: r.outcome,
      ...(receipt ? { receipt } : {}),
      order: r.order,
      artifacts: r.artifacts,
      ...(timelineHtmlPath ? { timelineHtmlPath } : {}),
      ...(progressFile ? { progressFile } : {}),
      signals: r.signals,
      ...(suggestion ? { suggestion } : {}),
    });
  } catch (e) {
    emitErr("shop.pay", e.code || "SHOP_PAY_FAILED", {
      message: e.message,
      ...(e.required != null ? { required: e.required, available: e.available } : {}),
    });
  }
}

/** 列出本地缓存的虚拟卡（脱敏，只显示末 4 位） */
export async function cards() {
  try {
    const { listCardsSafe } = await import("../shop/cards.mjs");
    const list = listCardsSafe();
    emitOk("shop.cards", { count: list.length, usable: list.filter((c) => !c.used).length, cards: list });
  } catch (e) {
    emitErr("shop.cards", "SHOP_CARDS_FAILED", { message: e.message });
  }
}

/**
 * 读取实时步骤事件流（shop pay --progress-file 写的 JSONL），渲染成图文步骤视图。
 * 供 agent 边 tail 边重复调用 → 刷新同一个 Artifact，实现"实时图文、AI 动态编排"。
 * 【安全】渲染委托 renderStepStreamHtml：填卡步骤只打码占位、绝不嵌卡面截图。
 */
export async function steps(opts) {
  try {
    if (!opts.progressFile)
      return emitErr("shop.steps", "MISSING_PROGRESS_FILE", { message: "Missing --progress-file (the JSONL written by `shop pay --progress-file`)" });
    const { readFileSync, existsSync, writeFileSync } = await import("node:fs");
    if (!existsSync(opts.progressFile))
      return emitErr("shop.steps", "NO_EVENTS_YET", { message: "Progress file not created yet; the run may not have started.", progressFile: opts.progressFile });

    const events = readFileSync(opts.progressFile, "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.evt === "step" && e.id);

    let htmlPath = null;
    if (opts.html) {
      const { renderStepStreamHtml } = await import("../shop/render.mjs");
      const html = await renderStepStreamHtml(events, { title: opts.title || "Order progress" });
      writeFileSync(opts.html, html);
      htmlPath = opts.html;
    }

    // 折叠为每步最新状态（首见顺序），回摘要供 agent 判断进度/是否结束
    const latest = {}; const order = [];
    for (const e of events) { if (!(e.id in latest)) order.push(e.id); latest[e.id] = e; }
    const summary = order.map((id) => ({ id, label: latest[id].label, status: latest[id].status, note: latest[id].note || null }));
    const terminal = order.includes("receipt") || summary.some((s) => s.status === "failed");

    emitOk("shop.steps", { count: events.length, steps: summary, terminal, ...(htmlPath ? { htmlPath } : {}) });
  } catch (e) {
    emitErr("shop.steps", e.code || "SHOP_STEPS_FAILED", { message: e.message });
  }
}

/** 订单跟踪（需 Token tier 凭证；无则提示降级到收银台确认信息） */
export async function track(opts) {
  try {
    if (!opts.shop) return emitErr("shop.track", "ORDER_NO_SHOP", { message: "Missing --shop (get_order is a single-store endpoint and needs the order's merchant domain)" });
    const bearer = opts.bearer || process.env.UCP_ORDER_TOKEN;
    if (!bearer) {
      return emitErr("shop.track", "ORDER_AUTH_REQUIRED", {
        message: "Order tracking requires Token tier credentials (--bearer or env UCP_ORDER_TOKEN). Note: only orders completed via pure API complete_checkout can be queried; for browser-filled orders, use the order.number / order.url returned on successful payment.",
      });
    }
    const { getOrder } = await import("../shop/orders.mjs");
    const o = await getOrder({ orderId: opts.order, bearer, shopDomain: opts.shop });
    emitOk("shop.track", o);
  } catch (e) {
    emitErr("shop.track", e.code || "SHOP_TRACK_FAILED", { message: e.message });
  }
}
