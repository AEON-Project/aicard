/**
 * Order Webhook 接收端工具（M2）：验签 + 解析 + 幂等信息。
 *
 * 用于纯 API 路径（complete_checkout）完成的订单的履约/退款/退货变更推送，
 * 作为主通道（不要轮询 get_order）。
 *
 * ⚠️ 注册：无自助订阅 API —— 需联系 Shopify partner manager 服务端登记 delivery URL + topic
 *    （orders/create | orders/updated | orders/delete）。
 *
 * 验签：header `X-Shopify-Hmac-SHA256` = base64(HMAC-SHA256(raw_body, client_secret))。
 *   必须用【原始未解析 body】计算，常量时间比较。
 * 幂等：header `X-Shopify-Webhook-Id` 去重；以最新一条为准。
 * 重试：失败最多 8 次 / 4 小时，指数退避。
 *
 * aicard 是 CLI、不常驻 —— 把下面这几个纯函数接进你后端的 HTTP 路由即可。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeOrder } from "./orders.mjs";

/**
 * 验签。rawBody 必须是【原始未解析】的 Buffer 或 string。
 * @returns {boolean}
 */
export function verifyOrderWebhook(rawBody, hmacHeader, clientSecret) {
  if (!hmacHeader || !clientSecret) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const digest = createHmac("sha256", clientSecret).update(body).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 解析 webhook body → 归一化订单（结构同 get_order） */
export function parseOrderWebhook(rawBody) {
  const json = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  return normalizeOrder(json);
}

/**
 * 一站式处理：验签 → 解析 → 返回幂等信息。
 * @param {object} p
 * @param {Buffer|string} p.rawBody - 原始未解析请求体
 * @param {object} p.headers - 请求头（大小写不敏感）
 * @param {string} p.clientSecret - Dev Dashboard 的 client_secret
 * @returns {{verified:boolean, webhookId:string|null, topic:string|null, order:object|null}}
 */
export function handleOrderWebhook({ rawBody, headers = {}, clientSecret }) {
  const h = (name) => headers[name] ?? headers[name.toLowerCase()];
  const verified = verifyOrderWebhook(rawBody, h("X-Shopify-Hmac-SHA256"), clientSecret);
  return {
    verified,
    webhookId: h("X-Shopify-Webhook-Id") || null,
    topic: h("X-Shopify-Topic") || null,
    order: verified ? parseOrderWebhook(rawBody) : null,
  };
}
