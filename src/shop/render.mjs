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

/** 读取本地图片文件转 data URI（大小限制）；失败返回 null。用于把收银台截图内嵌进 Artifact。 */
export async function readImageDataUri(filePath, { maxBytes = 900_000 } = {}) {
  if (!filePath) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(filePath);
    if (buf.length > maxBytes) return null; // 过大不嵌，避免 HTML 体积失控
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// 让 Artifact 内的卡片可点击：点卡片把一句话作为用户输入回投到对话。
// Claude 桌面端可能通过不同通道暴露该能力，逐一尝试并优雅降级（都不可用则点击无副作用，用户仍可回复数字）。
const SEND_PROMPT_SCRIPT = `
<script>
(function(){
  function send(msg){
    try { if (window.claude && typeof window.claude.sendPrompt === "function") return window.claude.sendPrompt(msg); } catch(e){}
    try { if (typeof window.sendPrompt === "function") return window.sendPrompt(msg); } catch(e){}
    try { window.parent.postMessage({ type: "prompt", prompt: msg }, "*"); } catch(e){}
  }
  document.querySelectorAll("[data-prompt]").forEach(function(el){
    el.style.cursor = "pointer";
    el.addEventListener("click", function(){
      el.classList.add("picked");
      send(el.getAttribute("data-prompt"));
    });
  });
})();
</script>`;

/**
 * 渲染商品卡片 HTML（body 片段 + 内联 <style>，可直接交给 Artifact）。
 * @param {object[]} products - normalizeProduct 结果
 * @param {{title?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function renderProductsHtml(products, { title = "Product Results", clickable = true } = {}) {
  const imgs = await Promise.all(products.map((p) => fetchImageDataUri(p.image)));

  const cards = products
    .map((p, i) => {
      const img = imgs[i];
      const price =
        p.priceMin != null
          ? `$${p.priceMin}${p.priceMax != null && p.priceMax !== p.priceMin ? `–$${p.priceMax}` : ""}`
          : "";
      const desc = p.description ? esc(String(p.description).slice(0, 90)) : "";
      // 点卡片 → 回投 "Buy item #N: <title>" 作为用户输入，agent 接着拉详情/下单。
      const promptAttr = clickable ? ` data-prompt="Buy item #${i + 1}: ${esc(p.title)}"` : "";
      return `<div class="card"${promptAttr}>
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
  <p class="tip">💡 ${clickable ? "Click a card to pick it, or reply" : "Reply"} with a number to select the product you want to buy</p>
</div>${clickable ? SEND_PROMPT_SCRIPT : ""}
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
  .card[data-prompt] { cursor: pointer; }
  .card.picked { outline: 2px solid #111; outline-offset: 1px; }
</style>`;
}

/**
 * 渲染单个商品详情 HTML（大图 + 价格 + 商户 + 规格表 + 描述），自包含可直接 Artifact。
 * @param {object} p - shop.product 的返回（title/priceMin/priceMax/currency/merchantName/images/options/specText/variants…）
 * @param {{buyPrompt?:string}} [opts] - buyPrompt 存在则整卡可点击，点击回投该句下单
 */
export async function renderProductHtml(p, { buyPrompt = null } = {}) {
  const imgUrl = p.image || (Array.isArray(p.images) ? p.images[0] : null);
  const img = await fetchImageDataUri(imgUrl, { width: 700, maxBytes: 900_000 });
  const price =
    p.priceMin != null
      ? `$${p.priceMin}${p.priceMax != null && p.priceMax !== p.priceMin ? `–$${p.priceMax}` : ""}`
      : "";

  // 规格维度（颜色/尺码等）——每个维度列出可选值
  const optionRows = Array.isArray(p.options)
    ? p.options
        .map((o) => {
          const vals = (o.values || o.optionValues || [])
            .map((v) => esc(typeof v === "string" ? v : v.value ?? v.name ?? ""))
            .filter(Boolean)
            .join(" / ");
          return o.name && vals ? `<tr><th>${esc(o.name)}</th><td>${vals}</td></tr>` : "";
        })
        .join("")
    : "";

  const desc = p.specText || p.description || "";
  const buyAttr = buyPrompt ? ` data-prompt="${esc(buyPrompt)}"` : "";

  return `<div class="pwrap">
  <div class="pcard"${buyAttr}>
    ${img ? `<div class="pimg"><img src="${img}" alt=""></div>` : `<div class="pimg noimg">No image</div>`}
    <div class="pbody">
      <div class="ptitle">${esc(p.title)}</div>
      <div class="pmeta"><span class="pprice">${esc(price)}</span><span class="pcur">${esc(p.currency || "")}</span></div>
      <div class="pmerchant">${esc(p.merchantName || p.merchantDomain || "")}</div>
      ${optionRows ? `<table class="pspec">${optionRows}</table>` : ""}
      ${desc ? `<div class="pdesc">${esc(String(desc).slice(0, 600))}</div>` : ""}
      <p class="tip">💡 ${buyPrompt ? "Click the card to buy this item, or reply" : "Reply"} to confirm and continue to checkout</p>
    </div>
  </div>
</div>${buyPrompt ? SEND_PROMPT_SCRIPT : ""}
<style>
  .pwrap { max-width: 760px; margin: 0 auto; padding: 20px; font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #1a1a1a; }
  .pcard { display: grid; grid-template-columns: 300px 1fr; gap: 22px; border: 1px solid #ececec; border-radius: 16px; overflow: hidden; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
  .pcard[data-prompt] { cursor: pointer; }
  .pcard.picked { outline: 2px solid #111; outline-offset: 1px; }
  .pimg { aspect-ratio: 1/1; background: #f6f6f6; display: flex; align-items: center; justify-content: center; }
  .pimg img { width: 100%; height: 100%; object-fit: cover; }
  .pimg.noimg { color: #bbb; font-size: 13px; }
  .pbody { padding: 20px 20px 20px 0; }
  .ptitle { font-size: 20px; font-weight: 650; line-height: 1.3; }
  .pmeta { margin-top: 10px; display: flex; align-items: baseline; gap: 5px; }
  .pprice { font-size: 26px; font-weight: 800; color: #c0392b; }
  .pcur { font-size: 13px; color: #999; }
  .pmerchant { margin-top: 5px; font-size: 13px; color: #999; }
  .pspec { margin-top: 16px; border-collapse: collapse; width: 100%; font-size: 13px; }
  .pspec th { text-align: left; color: #888; font-weight: 500; padding: 6px 12px 6px 0; vertical-align: top; white-space: nowrap; }
  .pspec td { padding: 6px 0; }
  .pdesc { margin-top: 16px; font-size: 13px; color: #555; line-height: 1.6; white-space: pre-wrap; }
  .tip { margin-top: 18px; font-size: 13px; color: #666; }
  @media (max-width: 620px){ .pcard { grid-template-columns: 1fr; } .pbody { padding: 0 20px 20px; } }
</style>`;
}

// 收银台分步截图 tag → 步骤名。含【明文卡面】的 05-card-filled/05b/05c 一律不嵌图（安全红线）。
const STEP_LABELS = {
  "01-open": "Open checkout",
  "02-address": "Fill address",
  "03-shipping": "Wait for shipping rates",
  "06-after-pay": "Submit payment",
  "08-after-challenge": "Confirmed",
};
const CARD_STEP_TAGS = ["05-card-filled", "05b-refill-failed", "05c-shipping-not-ready"];

/**
 * 渲染单次下单流程时间线 HTML：订单摘要（商户/商品/实扣/卡末4/收货）+ 节点截图时间线。
 * 【安全】只内嵌不含卡面的截图；填卡节点仅显示"已打码"占位，绝不嵌 05-card-filled（含明文卡号/CVC）。
 * @param {object} result - fillCheckout 返回（outcome/artifacts/order/signals）
 * @param {object|null} receipt - shop.pay 组装的收据（masked last4/shipTo/amountCharged…）
 * @param {{title?:string}} [opts]
 */
export async function renderOrderTimelineHtml(result, receipt, { title = "Order flow" } = {}) {
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  const tagOf = (fp) => String(fp).split("/").pop().replace(/^co-/, "").replace(/\.png$/i, "");

  // 时间线节点：按拍摄顺序；卡步骤转占位（不嵌图），其余可识别步骤嵌图
  const seen = new Set();
  const nodes = [];
  for (const fp of artifacts) {
    const tag = tagOf(fp);
    if (CARD_STEP_TAGS.includes(tag)) {
      if (seen.has("card")) continue;
      seen.add("card");
      nodes.push({ card: true, label: "Card filled (masked)" });
      continue;
    }
    const label = STEP_LABELS[tag];
    if (!label || seen.has(tag)) continue;
    seen.add(tag);
    const dataUri = await readImageDataUri(fp);
    if (dataUri) nodes.push({ img: dataUri, label });
  }

  const steps = nodes
    .map((n, i) => {
      const shot = n.card
        ? `<div class="shot cardshot"><div class="cardmask">💳<div class="masktip">masked for security</div></div></div>`
        : `<div class="shot"><img src="${n.img}" alt=""></div>`;
      return `<div class="step">${shot}<div class="steplabel"><span class="stepno">${i + 1}</span>${esc(n.label)}</div></div>`;
    })
    .join(`<div class="arrow">→</div>`);

  const rows = [];
  const push = (k, v) => { if (v) rows.push(`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`); };
  if (receipt) {
    push("Merchant", receipt.merchant);
    push("Item", Array.isArray(receipt.items) ? receipt.items.map((it) => it.title || it).join(", ") : receipt.items);
    push("Order #", receipt.orderNumber);
    push("Charged", receipt.amountCharged || receipt.total);
    push("Subtotal", receipt.subtotal);
    push("Shipping", receipt.shippingFee);
    push("Tax", receipt.tax);
    if (receipt.payment) push("Payment", `${receipt.payment.scheme || "Card"} •••• ${receipt.payment.last4 || "----"}`);
    if (receipt.shipTo) push("Ship to", [receipt.shipTo.name, receipt.shipTo.address].filter(Boolean).join(" · "));
  }
  const summary = rows.length ? `<table class="osum">${rows.join("")}</table>` : "";
  const status =
    result?.outcome === "success"
      ? `<span class="ok">✅ Payment successful</span>`
      : `<span class="warn">⚠️ ${esc(result?.outcome || "incomplete")}</span>`;

  return `<div class="owrap">
  <div class="ohead"><h2>${esc(title)}</h2>${status}</div>
  ${summary}
  ${steps ? `<h3>Checkout steps</h3><div class="timeline">${steps}</div>` : ""}
  <p class="tip">🔒 Card details are never shown; the card-entry step is masked. Card-entry screenshots are excluded from this view.</p>
</div>
<style>
  .owrap { max-width: 1000px; margin: 0 auto; padding: 20px; font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #1a1a1a; }
  .ohead { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .ohead h2 { font-size: 20px; font-weight: 650; margin: 0; }
  .ok { color: #1a7f37; font-weight: 600; font-size: 14px; }
  .warn { color: #b26a00; font-weight: 600; font-size: 14px; }
  .osum { border-collapse: collapse; width: 100%; font-size: 14px; border: 1px solid #ececec; border-radius: 12px; overflow: hidden; }
  .osum th { text-align: left; color: #888; font-weight: 500; padding: 9px 14px; background: #fafafa; white-space: nowrap; width: 130px; vertical-align: top; }
  .osum td { padding: 9px 14px; }
  .osum tr + tr th, .osum tr + tr td { border-top: 1px solid #f0f0f0; }
  h3 { font-size: 15px; font-weight: 600; margin: 22px 0 12px; }
  .timeline { display: flex; align-items: flex-start; gap: 6px; overflow-x: auto; padding-bottom: 8px; }
  .step { flex: 0 0 auto; width: 200px; text-align: center; }
  .shot { width: 200px; height: 250px; border: 1px solid #ececec; border-radius: 10px; overflow: hidden; background: #f6f6f6; }
  .shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .cardshot { display: flex; align-items: center; justify-content: center; }
  .cardmask { color: #999; font-size: 40px; text-align: center; }
  .masktip { font-size: 12px; margin-top: 8px; color: #bbb; }
  .steplabel { margin-top: 8px; font-size: 13px; color: #444; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .stepno { width: 20px; height: 20px; border-radius: 50%; background: #111; color: #fff; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; }
  .arrow { flex: 0 0 auto; align-self: center; color: #ccc; font-size: 20px; padding-top: 100px; }
  .tip { margin-top: 18px; font-size: 12px; color: #888; }
</style>`;
}
