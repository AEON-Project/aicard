/**
 * Order MCP：get_order 按需查询订单状态。
 *
 * 端点：POST https://{shop-domain}/api/ucp/mcp（单店端点）
 * 工具：get_order，参数 id = gid://shopify/Order/{数字}，来自 complete_checkout 的响应。
 *
 * ⚠️ 认证：需 Token tier（Global API JWT + `read_global_api_orders` scope）。
 *
 * ⚠️ 可见性边界（关键）：只能查【你的 agent 通过 complete_checkout 完成的订单】。
 *    通过网页收银台 continue_url 完成的订单（即当前浏览器填卡路径的单）会被 Shopify
 *    平台过滤，get_order 与 webhook 都拿不到。那种情况请改用 checkout 成功页返回的
 *    order.number / order.url（见 checkout-filler.extractOrder）或用户邮箱确认。
 *
 * ⚠️ 不要轮询 get_order —— 订单变更应订阅 Order webhooks（HMAC 用 client_secret 验签）。
 *    get_order 仅用于：买家主动查看、补漏 webhook、按需取最新状态。
 */
import { ucpCall, shopEndpoint } from "./ucp.mjs";

/**
 * @param {object} p
 * @param {string} p.orderId - gid://shopify/Order/{数字}（来自 complete_checkout）
 * @param {string} p.shopDomain - 下单的商户域名（get_order 是单店端点）
 * @param {string} p.bearer - Token tier JWT（必需）
 * @param {string} [p.profile]
 * @returns {Promise<object>} 归一化订单
 */
export async function getOrder(p) {
  if (!p.bearer) {
    const e = new Error("Order tracking requires Token tier credentials (Bearer JWT + read_global_api_orders scope)");
    e.code = "ORDER_AUTH_REQUIRED";
    throw e;
  }
  if (!p.shopDomain) {
    const e = new Error("Missing shopDomain: get_order is a single-store endpoint {shop}/api/ucp/mcp");
    e.code = "ORDER_NO_SHOP";
    throw e;
  }
  const res = await ucpCall(shopEndpoint(p.shopDomain), "get_order", { id: p.orderId }, { profile: p.profile, bearer: p.bearer });
  return normalizeOrder(res);
}

export function normalizeOrder(res) {
  const o = res.order || res;
  const events = o.fulfillment?.events || o.fulfillment_events || [];
  const pickTotal = (type) => {
    const arr = Array.isArray(o.totals) ? o.totals : [];
    const t = arr.find((x) => x.type === type);
    return t ? Math.round(Number(t.amount)) / 100 : null;
  };
  return {
    id: o.id,
    status: o.status || null,
    fulfillmentStatus: o.fulfillment_status || o.fulfillment?.status || null,
    currency: o.currency || null,
    subtotal: pickTotal("subtotal"),
    tax: pickTotal("tax"),
    shipping: pickTotal("shipping"),
    total: pickTotal("total"),
    lineItems: (o.line_items || []).map((li) => ({
      title: li.item?.title || li.title || null,
      quantity: li.quantity,
    })),
    trackings: events
      .filter((e) => e.tracking_number)
      .map((e) => ({
        status: e.type || e.status || null,
        carrier: e.carrier || e.company || null,
        number: e.tracking_number,
        url: e.tracking_url || null,
      })),
    events: events.map((e) => ({ type: e.type || e.status || null, at: e.happened_at || e.timestamp || null })),
    raw: o,
  };
}
