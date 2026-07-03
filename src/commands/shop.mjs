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
    let htmlPath = null;
    if (opts.html) {
      const { renderProductsHtml } = await import("../shop/render.mjs");
      const { writeFileSync } = await import("node:fs");
      const html = await renderProductsHtml(r.products, { title: `“${opts.query}” 的结果` });
      writeFileSync(opts.html, html);
      htmlPath = opts.html;
    }
    emitOk("shop.search", {
      scope: r.scope,
      count: r.products.length,
      excludedTest: r.excludedTestCount || 0,
      excludedNoCard: r.excludedNoCard || 0, // 被剔除的【确认不收信用卡】商户数（无法确认的不剔除、予以保留）
      sortedBy: r.sortedBy || "relevance",
      hasNext: r.hasNext,
      cursor: r.cursor,
      htmlPath,
      products: r.products,
    });
  } catch (e) {
    emitErr("shop.search", e.code || "SHOP_SEARCH_FAILED", { message: e.message, retryAfter: e.retryAfter });
  }
}

/** 商品详情：get_product → 规格(颜色/尺码)/描述/图/可选 variants，供用户选规格 */
export async function product(opts) {
  try {
    if (!opts.id) return emitErr("shop.product", "MISSING_ID", { message: "缺少 --id（商品 gid，来自 search 结果的 productId）" });
    const { getProduct } = await import("../shop/catalog.mjs");
    const p = await getProduct({ id: opts.id, shopDomain: opts.shop });
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
    });
  } catch (e) {
    emitErr("shop.product", e.code || "SHOP_PRODUCT_FAILED", { message: e.message });
  }
}

/** 拼单算价：create_cart → totals + continueUrl */
export async function cart(opts) {
  try {
    if (!opts.shop) return emitErr("shop.cart", "MISSING_SHOP", { message: "缺少 --shop（商户域名，来自 search 结果的 merchantDomain）" });
    if (!opts.variant) return emitErr("shop.cart", "MISSING_VARIANT", { message: "缺少 --variant（商品规格 gid，来自 search 结果）" });
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
      ...(testBackend ? { warning: `⚠️ 该商户收银台后端是测试店（${backendHost}），下单不是真实交易。shop pay 默认会拦截，如确需测试加 --allow-test。` } : {}),
      ...(c.acceptsCard === false ? { warning: "⚠️ 该商户不收信用卡（仅 " + (c.paymentMethods || []).join("/") + "），虚拟卡无法付款，请换支持信用卡的商户。" } : {}),
      lineItems: c.lineItems,
      expiresAt: c.expiresAt,
    });
  } catch (e) {
    // variant 不存在：多因把 Global 目录的 variant 丢给 storefront。给可操作提示。
    const notFound = /does not exist|not found/i.test(e.message || "") && /variant/i.test(JSON.stringify(e.messages || e.message || ""));
    emitErr("shop.cart", notFound ? "VARIANT_NOT_FOUND" : e.code || "SHOP_CART_FAILED", {
      message: e.message,
      ...(e.messages ? { messages: e.messages } : {}),
      ...(notFound ? { hint: "该 variant 在此商户不存在。请用 `shop search --shop <该商户域名> --query \"<商品名>\"` 重新取该店的 variantId 再建车（勿用 Global get_product 里的变体，可能与 storefront 不一致）。" } : {}),
      retryAfter: e.retryAfter,
    });
  }
}

/** 发卡 + 填卡付款：issueCard（完整卡面内存）→ fillCheckout（真实提交） */
export async function pay(opts) {
  try {
    if (!opts.continueUrl) return emitErr("shop.pay", "NO_URL", { message: "缺少 --continue-url（来自 shop cart 的 continueUrl）" });
    const amount = opts.amount != null ? Number(opts.amount) : null;
    if (!amount || isNaN(amount) || amount <= 0) return emitErr("shop.pay", "NO_AMOUNT", { message: "缺少或非法 --amount（应等于购物车 total，正数）" });

    // 拦截测试店：continueUrl 的后端 host 才是真实收银台后端（vanity 域名可能套在 twinoakstest 等测试店上）。
    // 默认禁用测试商家；确需测试用 --allow-test 放行。
    const backendHost = (() => { try { return new URL(opts.continueUrl).host; } catch { return null; } })();
    const { isTestStore } = await import("../shop/catalog.mjs");
    if (isTestStore(backendHost) && !opts.allowTest) {
      return emitErr("shop.pay", "TEST_STORE_BLOCKED", {
        message: `该商户收银台后端是测试店（${backendHost}），下单不是真实交易。请提示用户并询问是否继续；用户确认后加 --allow-test 重跑即可继续。`,
        backendHost,
        needsConfirm: true, // 非死路：这是"确认门"，用户同意后 --allow-test 放行
      });
    }

    // 收货信息严格校验 → 结构化错误（逻辑严谨，一次性列出所有缺失）
    const shipping = { email: opts.email, first: opts.first, last: opts.last, address1: opts.address1, city: opts.city, zip: opts.zip, country: opts.country, phone: opts.phone };
    const REQUIRED = ["email", "first", "last", "address1", "city", "zip", "country", "phone"];
    const missing = REQUIRED.filter((k) => !shipping[k] || !String(shipping[k]).trim());
    if (missing.length) return emitErr("shop.pay", "MISSING_SHIPPING_FIELDS", { message: `缺少收货信息：${missing.join("、")}`, missing });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(shipping.email).trim()))
      return emitErr("shop.pay", "INVALID_EMAIL", { message: "邮箱格式无效（必须是用户本人真实邮箱，用于收订单/物流）", field: "email" });

    // country 值有效性前置校验（是否已知国家名/ISO 代码）；"该店是否配送该国家"仍需收银台运行时确认
    const { COUNTRY_CODES, COUNTRIES } = await import("../shop/country-data.mjs");
    const cin = String(shipping.country).trim().toLowerCase();
    const countryValid = !!COUNTRY_CODES[cin] || COUNTRIES.some((c) => {
      const n = c.name.toLowerCase();
      return c.code.toLowerCase() === cin || n === cin || (cin.length >= 3 && n.includes(cin));
    });
    if (!countryValid)
      return emitErr("shop.pay", "INVALID_COUNTRY", { message: `国家 '${shipping.country}' 不是已知国家名或 ISO 代码（示例：United States / US / Hong Kong / GB）`, field: "country" });

    const { findUsableCard, markCardUsed } = await import("../shop/cards.mjs");
    const { fillCheckout } = await import("../shop/checkout-filler.mjs");

    // 1. 先用本地可用卡（面额够且未用）→ 命中则跳过钱包，直接付款
    let card = findUsableCard(amount);
    let orderNo = card?.orderNo || null;
    let cardSource = "cache";

    // 2. 无可用卡 → 发新卡（需钱包 USDT）。一次性卡模型下"卡充值"即"发新卡"。
    if (!card) {
      logInfo("> No usable cached card; issuing a new card (charging USDT from wallet)...");
      const { issueCard } = await import("../shop/card-issuer.mjs");
      try {
        const issued = await issueCard({ amount, appId: opts.appId, serviceUrl: opts.serviceUrl, privateKey: opts.privateKey });
        card = issued.card;
        orderNo = issued.orderNo;
        cardSource = "new";
      } catch (e) {
        // 分级降级：钱包不足/缺 gas/未配置 → 明确指引下一步
        const hint = {
          INSUFFICIENT_USDT: "钱包 USDT 不足。请先给钱包充值：aicard topup --amount <n>",
          NEEDS_APPROVE_GAS: "本地钱包缺 BNB 做首次 approve。请先：aicard gas",
          WALLET_NOT_CONFIGURED: "钱包未配置。请先：aicard setup --check",
          AMOUNT_OUT_OF_RANGE: "本单金额不在单卡可发区间 $0.6~$800，请换商品或拆分订单（金额须等于购物车总额，无法单独调整）。",
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
        "本单需要 3DS 验证码（当前验证未完成 = 未授权 = 未扣款）。要完成：改用后台 " +
        "`aicard shop pay --wait-otp 600000 …`（同参数）再走一次，遇“请把验证码给我”时把码 `echo` 到 " +
        "/tmp/aicard-otp.txt 自动回填。切勿用不带 --wait-otp 反复重跑。";
    } else if (paid) {
      // pending / error：点过 Pay 但结果真不明 → 危险，禁止重跑
      suggestion =
        `⚠️ 已提交付款但结果未确认（${r.outcome}）——款项【可能已成功扣除】。` +
        `禁止重跑 shop pay（会重复扣款）。请先核实是否已成交` +
        `（收货邮箱确认邮件 / 本地 ~/.aicard/receipts 凭证图 / 商户订单页），再由你决定后续。`;
    } else if (r.outcome === "declined") {
      suggestion = "卡被拒（未扣款）。脚本不自动重试；如需换卡/改信息，由你重新发起。";
    } else if (r.outcome === "card_not_supported") {
      // 未点付款、未扣款：商户只收 PayPal/钱包，不收信用卡，虚拟卡用不了 → 只能换商户
      suggestion = "该商户不支持信用卡/借记卡（仅 PayPal 等钱包），虚拟卡无法使用（未扣款）。请换一家支持信用卡付款的商户。assist 也补不出卡选项。";
    } else if (r.outcome === "shipping_not_ready") {
      suggestion = "配送方式始终未加载（已尽量等待；未扣款、未下单）。脚本不自动重试；是否稍后重新发起由你决定。";
    } else if (r.outcome === "checkout_unavailable") {
      suggestion = "收银台链接失效/过期（未扣款）。脚本不自动重试；如需继续，由你重新生成 continueUrl 后发起。";
    } else if (shipUnsupported) {
      suggestion = `该商户仅配送：${avail.slice(0, 6).join(", ")}${avail.length > 6 ? " …" : ""} —— 收货国家不在其中（未扣款）。请换收货国家或换商户。`;
    } else if (["fill_failed", "no_card_iframe", "address_incomplete"].includes(r.outcome)) {
      suggestion = "填单未完成、未提交付款（未扣款）。脚本不自动重试；可由你用 --assist 手动完成本单，或重新发起。";
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
              note: cardSource === "cache" ? "复用缓存卡，未开新卡、未动钱包" : "新开虚拟卡（从钱包扣 USDT）",
            },
            shipTo: { name: `${opts.first} ${opts.last}`.trim(), email: opts.email, phone: opts.phone, address: shipAddr },
            billingSameAsShipping: true,
            proofImage: r.order?.receiptImage || null, // 本地付款凭证图（感谢页截图），持久留档/售后用
            reopenVia: [
              "商户确认邮件（发到收货邮箱）里的 View your order 链接——持久可打开",
              "感谢页的 Download to track with Shop（Shop app，需 Shop 账号）",
              "本地 proofImage 凭证图（离线留档）",
            ],
            note: "浏览器路径 web 订单：orderNumber 是商户确认号（非 Shopify API Global ID），不可用 get_order 查询。orderUrl 会话绑定、不可二次打开；二次查看请用 reopenVia。",
          }
        : null;

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

/** 订单跟踪（需 Token tier 凭证；无则提示降级到收银台确认信息） */
export async function track(opts) {
  try {
    if (!opts.shop) return emitErr("shop.track", "ORDER_NO_SHOP", { message: "缺少 --shop（get_order 是单店端点，需下单商户域名）" });
    const bearer = opts.bearer || process.env.UCP_ORDER_TOKEN;
    if (!bearer) {
      return emitErr("shop.track", "ORDER_AUTH_REQUIRED", {
        message: "订单跟踪需 Token tier 凭证（--bearer 或 env UCP_ORDER_TOKEN）。注意：仅能查通过纯 API complete_checkout 完成的单；浏览器填卡的单请用付款成功返回的 order.number / order.url。",
      });
    }
    const { getOrder } = await import("../shop/orders.mjs");
    const o = await getOrder({ orderId: opts.order, bearer, shopDomain: opts.shop });
    emitOk("shop.track", o);
  } catch (e) {
    emitErr("shop.track", e.code || "SHOP_TRACK_FAILED", { message: e.message });
  }
}
