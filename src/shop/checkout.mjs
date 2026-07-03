/**
 * Shopify Checkout MCP：create_checkout（cart→checkout）+ complete_checkout（token 下单）。
 *
 * ⚠️ complete_checkout 需 Token tier（Bearer JWT + 完成购买权限）。
 * ⚠️ 提交的 payment instrument 必须是 tokenized credential（见 tokenize.mjs），不接受裸卡号。
 *
 * 这是纯 API 支付路径（M2），当前受限于 Shopify card tokenizer 端点未公开，
 * 尚不能端到端真跑；浏览器填卡（checkout-filler.mjs）仍是已验证的主路径。
 */
import { ucpCall, shopEndpoint } from "./ucp.mjs";

/** cart → checkout，拿 checkoutId + status（+ 可能的 continue_url） */
export async function createCheckout({ shopDomain, cartId, bearer, profile }) {
  const res = await ucpCall(shopEndpoint(shopDomain), "create_checkout", { cart_id: cartId }, { profile, bearer });
  const c = res.checkout || res;
  return { checkoutId: c.id, status: c.status || null, continueUrl: c.continue_url || null, raw: c };
}

/** 用 tokenized instrument 完成结账下单（需 Token tier + status=ready_for_complete） */
export async function completeCheckout({ shopDomain, checkoutId, token, handlerId = "shopify.card", brand, last4, bearer, profile, idempotencyKey }) {
  const instrument = {
    handler_id: handlerId,
    type: "card",
    credential: { type: "token", token },
    ...(brand || last4 ? { display: { brand, last_digits: last4 } } : {}),
  };
  const res = await ucpCall(
    shopEndpoint(shopDomain),
    "complete_checkout",
    { id: checkoutId, checkout: { payment: { instruments: [instrument] } } },
    { profile, bearer, idempotencyKey: idempotencyKey || globalThis.crypto?.randomUUID?.() }
  );
  const c = res.checkout || res;
  return {
    status: c.status || null,
    orderId: c.order?.id || c.order_id || null,
    order: c.order || null,
    continueUrl: c.continue_url || null,
    raw: c,
  };
}
