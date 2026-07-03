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
      limit: opts.limit ? Number(opts.limit) : 10,
      cursor: opts.cursor,
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
    const c = await createCart({
      shopDomain: opts.shop,
      items: [{ variantId: opts.variant, quantity: opts.qty ? Number(opts.qty) : 1 }],
      address: { country: opts.country, region: opts.region, postalCode: opts.zip },
    });
    emitOk("shop.cart", {
      cartId: c.cartId,
      currency: c.currency,
      subtotal: c.subtotal,
      tax: c.tax,
      shipping: c.shipping,
      total: c.total,
      continueUrl: c.continueUrl,
      lineItems: c.lineItems,
      expiresAt: c.expiresAt,
    });
  } catch (e) {
    emitErr("shop.cart", e.code || "SHOP_CART_FAILED", { message: e.message, retryAfter: e.retryAfter });
  }
}

/** 发卡 + 填卡付款：issueCard（完整卡面内存）→ fillCheckout（真实提交） */
export async function pay(opts) {
  try {
    if (!opts.continueUrl) return emitErr("shop.pay", "NO_URL", { message: "缺少 --continue-url（来自 shop cart 的 continueUrl）" });
    const amount = opts.amount != null ? Number(opts.amount) : null;
    if (!amount) return emitErr("shop.pay", "NO_AMOUNT", { message: "缺少 --amount（应等于购物车 total）" });

    const { findUsableCard, markCardUsed } = await import("../shop/cards.mjs");
    const { fillCheckout } = await import("../shop/checkout-filler.mjs");

    // 1. 先用本地可用卡（面额够且未用）→ 命中则跳过钱包，直接付款
    let card = findUsableCard(amount);
    let orderNo = card?.orderNo || null;
    let cardSource = "cache";

    // 2. 无可用卡 → 发新卡（需钱包 USDT）。一次性卡模型下"卡充值"即"发新卡"。
    if (!card) {
      logInfo("> 本地无可用卡，正在发新卡（从钱包扣 USDT）...");
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
          AMOUNT_OUT_OF_RANGE: "订单金额超出单卡可发范围，请调整金额。",
        }[e.code];
        return emitErr("shop.pay", e.code || "CARD_ISSUE_FAILED", {
          message: e.message,
          ...(hint ? { hint } : {}),
          ...(e.required != null ? { required: e.required, available: e.available } : {}),
        });
      }
    } else {
      logInfo(`> 命中本地缓存卡 •••• ${String(card.number).slice(-4)}（面额 $${card.amount}），跳过钱包直接付款。`);
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
    logInfo("> 打开收银台并自动填卡付款...");
    const r = await fillCheckout({
      continueUrl: opts.continueUrl,
      address,
      card,
      headful: !!opts.headful,
      noSubmit: !!opts.fillOnly,
      waitOtpMs: opts.waitOtp ? Number(opts.waitOtp) : 0,
      otpFile: opts.otpFile,
      outDir: opts.out,
      onProgress: (m) => logInfo("> " + m),
    });

    // 4. 支付成功 → 标记一次性卡已用（退出可用列表）
    if (r.outcome === "success" && orderNo) markCardUsed(orderNo, { usedFor: opts.continueUrl });

    // 卡面绝不进 envelope，只回末 4 位与结果
    emitOk("shop.pay", {
      cardSource,
      cardOrderNo: orderNo,
      cardLast4: String(card.number).slice(-4),
      cardScheme: card.scheme,
      outcome: r.outcome,
      order: r.order,
      artifacts: r.artifacts,
      signals: r.signals,
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
