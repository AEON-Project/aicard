/**
 * 商品结果富展示：把 search 结果渲染成图文卡片 HTML（自包含，图片内嵌为 data URI）。
 *
 * 自包含 = 可直接用 Artifact 展示（严格 CSP 下也能显示图），或浏览器/邮件打开。
 * 图片走 Shopify CDN 的 width 参数缩小体积，并限制单图大小，控制 HTML 体积。
 */

/** 下载图片并转 data URI（缩放 + 大小限制）；失败返回 null */
export async function fetchImageDataUri(url, { width = 400, maxBytes = 300_000, timeoutMs = 8000 } = {}) {
  if (!url) return null;
  let u = url;
  if (/cdn\.shopify\.com/.test(u)) u += (u.includes("?") ? "&" : "?") + `width=${width}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, { signal: ctrl.signal });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/jpeg";
    if (!/^image\//.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * 渲染商品卡片 HTML（body 片段 + 内联 <style>，可直接交给 Artifact）。
 * @param {object[]} products - normalizeProduct 结果
 * @param {{title?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function renderProductsHtml(products, { title = "Product Results" } = {}) {
  const imgs = await Promise.all(products.map((p) => fetchImageDataUri(p.image)));

  const cards = products
    .map((p, i) => {
      const img = imgs[i];
      const price =
        p.priceMin != null
          ? `$${p.priceMin}${p.priceMax != null && p.priceMax !== p.priceMin ? `–$${p.priceMax}` : ""}`
          : "";
      const desc = p.description ? esc(String(p.description).slice(0, 90)) : "";
      return `<div class="card">
      <div class="num">${i + 1}</div>
      ${img ? `<div class="imgbox"><img src="${img}" alt=""></div>` : `<div class="imgbox noimg">No image</div>`}
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        ${desc ? `<div class="desc">${desc}</div>` : ""}
        <div class="meta">
          <span class="price">${esc(price)}</span>
          <span class="cur">${esc(p.currency || "")}</span>
        </div>
        <div class="merchant">${esc(p.merchantName || p.merchantDomain || "")}</div>
      </div>
    </div>`;
    })
    .join("\n");

  return `<div class="wrap">
  <h2>${esc(title)}</h2>
  <div class="grid">${cards}</div>
  <p class="tip">💡 Reply with a number to select the product you want to buy</p>
</div>
<style>
  .wrap { max-width: 1100px; margin: 0 auto; padding: 20px; font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #1a1a1a; }
  .wrap h2 { font-size: 20px; font-weight: 650; margin: 0 0 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
  .card { position: relative; border: 1px solid #ececec; border-radius: 14px; overflow: hidden; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.05); transition: box-shadow .15s, transform .15s; }
  .card:hover { box-shadow: 0 6px 20px rgba(0,0,0,.1); transform: translateY(-2px); }
  .num { position: absolute; top: 10px; left: 10px; z-index: 2; width: 26px; height: 26px; border-radius: 50%; background: #111; color: #fff; font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .imgbox { width: 100%; aspect-ratio: 1/1; background: #f6f6f6; display: flex; align-items: center; justify-content: center; }
  .imgbox img { width: 100%; height: 100%; object-fit: cover; }
  .imgbox.noimg { color: #bbb; font-size: 13px; }
  .body { padding: 12px 14px 14px; }
  .title { font-size: 14px; font-weight: 600; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 38px; }
  .desc { font-size: 12px; color: #888; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { margin-top: 8px; display: flex; align-items: baseline; gap: 4px; }
  .price { font-size: 18px; font-weight: 700; color: #c0392b; }
  .cur { font-size: 12px; color: #999; }
  .merchant { margin-top: 4px; font-size: 12px; color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tip { margin-top: 18px; font-size: 13px; color: #666; }
</style>`;
}
