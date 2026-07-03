/**
 * Shopify Cart：拼单（create_cart）+ 查询（get_cart）
 *
 * 全程匿名 + Profile。返回 totals（含税/运费估算）与 continue_url（收银台入口）。
 * continue_url 即后续 CheckoutFiller 打开的收银台地址。
 */
import { ucpCall, shopEndpoint } from "./ucp.mjs";

/**
 * 创建购物车。
 * @param {object} p
 * @param {string} p.shopDomain - 商户域名
 * @param {Array<{variantId:string, quantity?:number}>} p.items
 * @param {{country?:string, region?:string, postalCode?:string}} [p.address] - 影响税/运费估算
 * @param {string} [p.profile]
 * @returns {Promise<object>} 归一化购物车
 */
export async function createCart(p) {
  const endpoint = shopEndpoint(p.shopDomain);
  const line_items = p.items.map((it) => ({ quantity: it.quantity || 1, item: { id: it.variantId } }));
  const cart = { line_items };

  if (p.address) {
    const ctx = {};
    if (p.address.country) ctx.address_country = p.address.country;
    if (p.address.region) ctx.address_region = p.address.region;
    if (p.address.postalCode) ctx.postal_code = p.address.postalCode;
    if (Object.keys(ctx).length) cart.context = ctx;
  }

  const res = await ucpCall(endpoint, "create_cart", { cart }, { profile: p.profile });
  return normalizeCart(res);
}

/** 查询购物车当前状态 */
export async function getCart(p) {
  const endpoint = shopEndpoint(p.shopDomain);
  const res = await ucpCall(endpoint, "get_cart", { id: p.cartId }, { profile: p.profile });
  return normalizeCart(res);
}

function normalizeCart(res) {
  const c = res.cart || res;
  // UCP totals 是数组：[{ type:"subtotal"|"total"|"tax"|"shipping", amount, display_text }]
  // 金额为最小货币单位（如美分）→ 转主单位，便于 pay --amount 直接使用
  const toMajor = (v) => (v == null ? null : Math.round(Number(v)) / 100);
  const pick = (arr, type) => {
    const t = (Array.isArray(arr) ? arr : []).find((x) => x.type === type);
    return t ? toMajor(t.amount) : null;
  };
  return {
    cartId: c.id,
    currency: c.currency || null,
    subtotal: pick(c.totals, "subtotal"),
    tax: pick(c.totals, "tax"),
    shipping: pick(c.totals, "shipping") ?? pick(c.totals, "shipping_estimate"),
    total: pick(c.totals, "total"),
    totals: c.totals,
    continueUrl: c.continue_url || null,
    lineItems: (c.line_items || []).map((li) => ({
      variantId: li.item?.id,
      quantity: li.quantity,
      title: li.item?.title || li.title || null,
      price: toMajor(li.item?.price),
      lineTotal: pick(li.totals, "total"),
    })),
    expiresAt: c.expires_at || null,
    raw: c,
  };
}
