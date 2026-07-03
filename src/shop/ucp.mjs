/**
 * UCP (Universal Commerce Protocol) JSON-RPC over HTTP 客户端
 *
 * Shopify agentic commerce 的 catalog / cart / checkout / orders 能力统一通过
 * MCP `tools/call` 暴露。此模块封装：profile 注入、请求签发、响应解析、错误归一。
 *
 * 运行时不需要重的 Shopify SDK —— 端点就是 JSON-RPC，用 Node 内置 fetch 直连。
 */
import { logVerbose } from "../output.mjs";

// 默认 Agent Profile（标识 Agent，用于能力协商）。
// 生产应替换为自托管的 well-known https URL（用 `ucp profile init` 生成后托管）。
export const DEFAULT_PROFILE =
  process.env.UCP_AGENT_PROFILE ||
  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/cart-and-checkout.json";

// Catalog 调用需要声明了 catalog 能力的 profile（与 cart/checkout 的 profile 区分）
export const CATALOG_PROFILE =
  process.env.UCP_CATALOG_PROFILE ||
  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json";

// 全网商品目录端点（跨商户搜索）
export const GLOBAL_CATALOG_ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";

/** 由商户域名构造单店 UCP 端点 */
export function shopEndpoint(shopDomain) {
  const d = String(shopDomain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${d}/api/ucp/mcp`;
}

export class UcpError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "UcpError";
    this.code = code;
    Object.assign(this, extra);
  }
}

let _id = 0;

/**
 * 调用一个 UCP 工具。
 * @param {string} endpoint - UCP MCP 端点
 * @param {string} toolName - 工具名，如 "search_catalog" / "create_cart"
 * @param {object} args - 工具 arguments（不含 meta；meta 会自动注入）
 * @param {{profile?:string, bearer?:string, idempotencyKey?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<object>} 解析后的工具结果（structuredContent 优先，否则解析 text content）
 */
export async function ucpCall(endpoint, toolName, args, opts = {}) {
  const { retries = 0, ...rest } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      return await ucpCallOnce(endpoint, toolName, args, rest);
    } catch (e) {
      lastErr = e;
      // 只对瞬时错误重试（网络 / 限流 / 服务端 -32000）；业务错误直接抛出
      const retriable =
        e.code === "UCP_NETWORK" || e.code === "UCP_RATE_LIMITED" || (e.code === "UCP_RPC_ERROR" && e.rpcCode === -32000);
      if (!retriable || attempt === retries) throw e;
    }
  }
  throw lastErr;
}

async function ucpCallOnce(endpoint, toolName, args, opts = {}) {
  const { profile = DEFAULT_PROFILE, bearer, idempotencyKey, timeoutMs = 30000 } = opts;

  const meta = { "ucp-agent": { profile } };
  if (idempotencyKey) meta["idempotency-key"] = idempotencyKey;

  const body = {
    jsonrpc: "2.0",
    method: "tools/call",
    id: ++_id,
    params: { name: toolName, arguments: { meta, ...args } },
  };

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    logVerbose(`[ucp] → ${toolName} @ ${endpoint}`);
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new UcpError("UCP_NETWORK", `UCP request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new UcpError("UCP_RATE_LIMITED", "Rate limited by UCP endpoint", {
      retryAfter: res.headers.get("retry-after"),
    });
  }

  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new UcpError("UCP_BAD_RESPONSE", `Non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }

  if (json.error) {
    throw new UcpError("UCP_RPC_ERROR", json.error.message || "UCP RPC error", {
      rpcCode: json.error.code,
      data: json.error.data,
    });
  }

  const result = json.result ?? {};
  if (result.isError) {
    const raw = result.content?.map((c) => c.text).filter(Boolean).join(" ") || "UCP tool error";
    // UCP 把可读原因放在 payload 的 messages[]，其余是一大坨 profile/capabilities。提取 messages 作为人类可读错误。
    let msg = raw;
    let messages;
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p?.messages) && p.messages.length) {
        msg = p.messages.map((m) => m.content).filter(Boolean).join("; ") || raw;
        messages = p.messages.map((m) => ({ code: m.code, content: m.content, severity: m.severity, path: m.path }));
      }
    } catch { /* 非 JSON：用原文 */ }
    throw new UcpError("UCP_TOOL_ERROR", msg.slice(0, 400), messages ? { messages } : {});
  }

  // 结构化内容优先；否则解析首个 text content（UCP 常把 payload 作为 JSON 字符串放这里）
  if (result.structuredContent) return result.structuredContent;
  const textContent = result.content?.find((c) => c.type === "text")?.text;
  if (textContent) {
    try {
      return JSON.parse(textContent);
    } catch {
      return { text: textContent };
    }
  }
  return result;
}
