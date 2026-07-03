/**
 * Shopify Catalog：语义搜索 + 商品详情
 *
 * - 不指定 shopDomain → Global Catalog（全网跨商户，catalog.shopify.com）
 * - 指定 shopDomain   → Storefront Catalog（限定单店，{shop}/api/ucp/mcp）
 *
 * 工具：search_catalog（自然语言搜）/ get_product（选定后取全部规格与结账链接）
 */
import { ucpCall, GLOBAL_CATALOG_ENDPOINT, CATALOG_PROFILE, shopEndpoint } from "./ucp.mjs";
import { COUNTRY_CODES, COUNTRIES } from "./country-data.mjs";

/**
 * 语义搜索商品。
 * @param {object} p
 * @param {string} p.query - 自然语言查询，如 "wireless headphones under $100"
 * @param {string} [p.shopDomain] - 提供则限定单店（Storefront），否则全网（Global）
 * @param {number} [p.maxPriceMinor] - 价格上限（最小货币单位，如美分）
 * @param {boolean} [p.available] - 仅在售
 * @param {string} [p.country] - 收货国家 ISO-2，如 "US" / "GB"
 * @param {number} [p.limit=10]
 * @param {string} [p.cursor] - 翻页游标
 * @param {string} [p.profile]
 * @returns {Promise<{products: object[], cursor: string|null, hasNext: boolean, scope: string}>}
 */
export async function searchCatalog(p) {
  const endpoint = p.shopDomain ? shopEndpoint(p.shopDomain) : GLOBAL_CATALOG_ENDPOINT;

  const catalog = { query: p.query };
  const filters = {};
  if (p.maxPriceMinor != null) filters.price = { max: p.maxPriceMinor };
  if (p.available != null) filters.available = p.available;
  if (Object.keys(filters).length) catalog.filters = filters;

  const context = {};
  if (p.country) context.address_country = toIso(p.country);
  if (Object.keys(context).length) catalog.context = context;

  catalog.pagination = { limit: p.limit || 10 };
  if (p.cursor) catalog.pagination.cursor = p.cursor;

  const res = await ucpCall(endpoint, "search_catalog", { catalog }, { profile: p.profile || CATALOG_PROFILE, retries: 2 });
  const out = normalizeSearch(res, p.shopDomain ? "storefront" : "global");
  // 默认排除疑似测试/开发店（*.myshopify.com、test/demo 命名）；传 excludeTest:false 保留
  if (p.excludeTest !== false) {
    const before = out.products.length;
    out.products = out.products.filter((prod) => !isTestStore(prod.merchantDomain || prod.variants?.[0]?.merchantDomain));
    out.excludedTestCount = before - out.products.length;
  }
  return out;
}

/**
 * 获取单个商品完整详情（含全部规格 variant 与结账链接）。
 * @param {object} p
 * @param {string} p.id - 商品 id（gid）
 * @param {string} [p.shopDomain]
 * @param {string} [p.profile]
 * @returns {Promise<object>} 归一化后的商品
 */
export async function getProduct(p) {
  const endpoint = p.shopDomain ? shopEndpoint(p.shopDomain) : GLOBAL_CATALOG_ENDPOINT;
  const res = await ucpCall(endpoint, "get_product", { catalog: { id: p.id } }, { profile: p.profile || CATALOG_PROFILE, retries: 2 });
  return normalizeProduct(res.product || res);
}

// ---------- 响应归一化（屏蔽 UCP 字段细节，对上层给稳定结构）----------

function normalizeSearch(res, scope) {
  const list = res.products || res.results || [];
  const page = res.pagination || {};
  return {
    products: list.map(normalizeProduct),
    cursor: page.cursor || null,
    hasNext: !!page.has_next_page,
    scope,
  };
}

function normalizeProduct(pr) {
  const variants = (pr.variants || []).map((v) => {
    const checkoutUrl = v.checkout_url || v.url || null;
    return {
      variantId: v.id,
      title: v.title,
      price: toMajor(v.price?.amount ?? pr.price_range?.min?.amount),
      currency: v.price?.currency ?? pr.price_range?.min?.currency ?? null,
      available: v.availability?.available ?? (typeof v.availability === "boolean" ? v.availability : null),
      checkoutUrl,
      merchantDomain: cleanDomain(v.seller?.domain || pr.seller?.domain) || domainFromUrl(checkoutUrl),
      merchantName: v.seller?.name || pr.seller?.name || null,
      options: v.options || null,
      description: typeof v.description === "object" ? v.description?.plain ?? null : v.description ?? null,
    };
  });
  return {
    productId: pr.id,
    title: pr.title,
    description: typeof pr.description === "object" ? pr.description?.plain ?? null : pr.description ?? null,
    url: pr.url,
    image: pr.media?.[0]?.url || pr.image || null,
    priceMin: toMajor(pr.price_range?.min?.amount),
    priceMax: toMajor(pr.price_range?.max?.amount),
    currency: pr.price_range?.min?.currency ?? variants[0]?.currency ?? null,
    merchantDomain: cleanDomain(pr.seller?.domain) || variants[0]?.merchantDomain || null,
    merchantName: pr.seller?.name || variants[0]?.merchantName || null,
    detailUrl: cleanUrl(variants[0]?.checkoutUrl),
    options: (pr.options || []).map((o) => ({
      name: o.name,
      values: (o.values || []).map((v) =>
        typeof v === "object" ? { label: v.label, available: v.available !== false } : { label: v, available: true }
      ),
    })),
    images: (pr.media || []).map((m) => m?.url).filter(Boolean),
    variants,
  };
}

/**
 * 按用户选择的规格（如 {Color:"Black", Size:"L"}）在 variants 中匹配对应 variant。
 * @param {object} product - normalizeProduct 结果
 * @param {Record<string,string>} selection - 规格名→值（大小写不敏感）
 * @returns {object|null} 命中的 variant
 */
export function matchVariant(product, selection) {
  const want = Object.entries(selection).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]);
  return (
    (product.variants || []).find((variant) => {
      const opts = variant.options || [];
      return want.every(([k, v]) => opts.some((o) => o.name?.toLowerCase() === k && o.label?.toLowerCase() === v));
    }) || null
  );
}

/** UCP 金额为最小货币单位（如美分）→ 转主单位（假设 2 位小数货币） */
function toMajor(minor) {
  return minor == null ? null : Math.round(Number(minor)) / 100;
}
function domainFromUrl(u) {
  if (!u) return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}
function cleanDomain(d) {
  if (!d) return null;
  return String(d).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** 疑似测试/开发店：店铺名含 test/demo/sandbox/staging。
 *  ⚠️ 不能用 .myshopify.com 判断——那是所有 Shopify 店（含正式大牌 corkcicle.myshopify.com）的收银台后端，非测试标志。 */
export function isTestStore(domain) {
  const d = String(domain || "").toLowerCase();
  if (!d) return false;
  const store = d.replace(/^www\./, "").split(".")[0]; // 店铺名段（如 twinoakstest / corkcicle）
  return /(^|[-_])(test|demo|sandbox|staging)([-_]|$)/.test(store) || /(^test|test$|^demo|demo$|sandbox|staging)/.test(store);
}

/** 国家名或 ISO → ISO-2（UCP context.address_country 用 ISO；search --country 可传名或 ISO） */
function toIso(c) {
  if (!c) return c;
  const cin = String(c).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(cin)) return cin.toUpperCase();
  return COUNTRY_CODES[cin] || COUNTRIES.find((x) => x.name.toLowerCase() === cin)?.code || c;
}

/** 商品详情链接：用 variant 的 checkout_url，去掉 agent 追踪参数 _gsid */
function cleanUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    url.searchParams.delete("_gsid");
    return url.toString();
  } catch {
    return u;
  }
}
