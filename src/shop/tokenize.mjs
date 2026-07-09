/**
 * UCP 卡 tokenization：把裸卡面（FPAN + expiry + cvc）换成绑定到具体 checkout 的 token。
 * 纯 server-to-server（无需浏览器）。
 *
 * ⚠️ PCI DSS：发送裸 FPAN 的一方需合规。生产中应由 aicard 后端（已处理卡面）发起，
 *    不要在不合规的客户端直接发 FPAN。
 *
 * 契约来自 UCP tokenization guide / openapi（2026-04-08）：
 *   POST {tokenizerEndpoint}/tokenize
 *   { credential:{ type:"card", card_number_type:"fpan", number, expiry_month, expiry_year, cvc, name },
 *     binding:{ checkout_id, identity:{ access_token } } }
 *   → { token }
 *
 * ⚠️ 待确认：Shopify `dev.shopify.card` handler 的 tokenizer 端点 URL 目前未在公开文档给出
 *    （card-payment-handler spec.md 404）。需从完整 handler 声明的 links 获取，或向 Shopify 申请。
 *    因此本模块的 tokenizerEndpoint 必须显式传入；缺失即报错，不臆造端点。
 */

export class TokenizeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TokenizeError";
    this.code = code;
  }
}

/**
 * @param {object} p
 * @param {string} p.tokenizerEndpoint - card handler 的 tokenizer 基址（待 Shopify 提供）
 * @param {{number:string, expiry:string, cvc:string, name?:string, scheme?:string}} p.card
 * @param {string} p.checkoutId - 绑定的 checkout id（防 token 被跨单复用）
 * @param {string} [p.accessToken] - 代商户 tokenize 时的 identity token
 * @param {string} [p.bearer] - tokenizer 若需鉴权
 * @param {number} [p.timeoutMs=20000]
 * @returns {Promise<{token:string, brand:string|null, last4:string}>}
 */
export async function tokenizeCard(p) {
  if (!p.tokenizerEndpoint) {
    throw new TokenizeError(
      "TOKENIZER_ENDPOINT_UNKNOWN",
      "Missing the card handler's tokenizer endpoint (not published by Shopify, pending confirmation). The pure-API path is not yet available; please use the browser card-fill path."
    );
  }
  if (!p.checkoutId) throw new TokenizeError("NO_CHECKOUT_ID", "tokenize must be bound to a checkout_id");

  const { month, year } = splitExpiry(p.card.expiry);
  const body = {
    credential: {
      type: "card",
      card_number_type: "fpan",
      number: String(p.card.number).replace(/\s/g, ""),
      expiry_month: month,
      expiry_year: year,
      cvc: String(p.card.cvc),
      ...(p.card.name ? { name: p.card.name } : {}),
    },
    binding: {
      checkout_id: p.checkoutId,
      ...(p.accessToken ? { identity: { access_token: p.accessToken } } : {}),
    },
  };

  const headers = { "Content-Type": "application/json" };
  if (p.bearer) headers.Authorization = `Bearer ${p.bearer}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), p.timeoutMs || 20000);
  let res;
  try {
    res = await fetch(`${p.tokenizerEndpoint.replace(/\/+$/, "")}/tokenize`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new TokenizeError("TOKENIZE_NETWORK", `tokenize request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new TokenizeError("TOKENIZE_FAILED", `tokenize failed HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j.token) throw new TokenizeError("TOKENIZE_NO_TOKEN", "tokenize did not return a token");

  return {
    token: j.token,
    brand: p.card.scheme || null,
    last4: String(p.card.number).replace(/\D/g, "").slice(-4),
  };
}

/** "MM/YY" | "MM/YYYY" | "MM-YY" → { month:int, year:int(4位) } */
function splitExpiry(expiry) {
  const [mmRaw, yyRaw] = String(expiry).split(/[/\-\s]+/);
  const month = parseInt(mmRaw, 10);
  let year = parseInt(yyRaw, 10);
  if (year < 100) year += 2000;
  return { month, year };
}
