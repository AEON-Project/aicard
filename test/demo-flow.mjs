/**
 * 端到端演示：完整走一遍 C 端购物流程（真实调用，演示模式不提交）
 *   搜索 → 商品详情 → 选规格 → 拼单算价 → 命中缓存卡 → 填卡（noSubmit，不提交）
 *
 * 运行：node test/demo-flow.mjs        （可选 Q="mini refrigerator" 换品类）
 * 前置：本地卡列表有可用卡（先 aicard create 或已缓存）；否则演示止于账单。
 * 安全：noSubmit=true 只填不提交、不会真实扣款；卡号来自 ~/.aicard/cards.json，本脚本不含卡面。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchCatalog, getProduct, matchVariant } from "../src/shop/catalog.mjs";
import { createCart } from "../src/shop/cart.mjs";
import { findUsableCard } from "../src/shop/cards.mjs";
import { fillCheckout } from "../src/shop/checkout-filler.mjs";

const line = "─".repeat(48);
const query = process.env.Q || "cotton t-shirt";

// ① 搜索
console.log(`🛍️  用户：帮我买「${query}」，$50 以内，寄美国\n` + line);
const r = await searchCatalog({ query, country: "US", maxPriceMinor: 5000, available: true, limit: 4 });
console.log("🤖  找到这些：\n");
console.log("| # | 商品 | 价格 | 商户 |");
console.log("|---|------|------|------|");
r.products.forEach((p, i) => console.log(`| ${i + 1} | ${p.title.slice(0, 30)} | $${p.priceMin} | ${p.merchantDomain} |`));
console.log("\n👉 回复序号选择\n" + line);

// ② 选商品（模拟用户选第 1 个能拉详情的；Global 结果不传 shop）
let detail = null;
for (const p of r.products) {
  try { detail = await getProduct({ id: p.productId }); break; } catch { /* 试下一个 */ }
}
if (!detail) { console.log("全部商品详情暂不可用，稍后再试"); process.exit(0); }
console.log("🛍️  用户：1\n" + line);

// ③ 商品详情
console.log("🤖  商品详情：\n");
console.log("   " + detail.title.slice(0, 60));
console.log("   $" + detail.priceMin + "  " + detail.currency + "  ·  " + detail.merchantDomain);
const opts = detail.options || [];
opts.forEach((o) => console.log("   [" + o.name + "] " + o.values.slice(0, 8).map((v) => v.label).join(" / ") + (o.values.length > 8 ? ` …共${o.values.length}` : "")));
console.log("   参数：" + (detail.variants[0]?.description || detail.description || "").replace(/\s+/g, " ").slice(0, 90));
console.log("\n👉 " + (opts.length ? "请回复「" + opts.map((o) => o.name).join("+") + "」，如 " + opts.map((o) => o.values[0].label).join(" ") : "单规格，直接下单") + "\n" + line);

// ④ 选规格（模拟用户选第一个可用组合）
const sel = {};
opts.forEach((o) => { const v = o.values.find((x) => x.available) || o.values[0]; if (v) sel[o.name] = v.label; });
console.log("🛍️  用户：" + (Object.values(sel).join(" ") || "下单") + "\n" + line);
const variant = matchVariant(detail, sel) || detail.variants[0];

// ⑤ 拼单算价
const cart = await createCart({ shopDomain: detail.merchantDomain, items: [{ variantId: variant.variantId }], address: { country: "US", postalCode: "10001" } });
console.log("🤖  已加入购物车：\n");
console.log("   " + detail.title.slice(0, 40) + "  规格：" + (Object.values(sel).join("/") || "默认"));
console.log("   合计  $" + cart.total + "  " + cart.currency);

// ⑥ 选卡（命中缓存卡则跳过钱包）
const card = findUsableCard(cart.total);
console.log("\n🤖  支付方式：" + (card ? `命中本地缓存卡 •••• ${card.number.slice(-4)}（面额 $${card.amount}），无需动用钱包 ✅` : "本地无可用卡 → 需发新卡（钱包扣 USDT）"));
console.log(line);

// ⑦ 填卡（演示，不提交）
if (card && cart.continueUrl) {
  console.log("🤖  打开收银台自动填卡…（演示模式：只填不提交，不会真实扣款）\n");
  const res = await fillCheckout({
    continueUrl: cart.continueUrl,
    address: { email: "buyer-8842@example.com", country: "United States", first: "Demo", last: "User", address1: "1 Main St", city: "New York", zip: "10001", region: "New York", phone: "2125550100" },
    card,
    headful: false,
    noSubmit: true,
    outDir: join(tmpdir(), "aicard-demo-artifacts"),
  });
  const f = (k) => (res.signals["card_" + k]?.filled ? "✓" : "✗");
  console.log("   收银台填卡结果：" + res.outcome);
  console.log("   卡字段填入：卡号 " + f("number") + "  有效期 " + f("expiry") + "  CVC " + f("cvc"));
  console.log("\n✅ 演示到「填卡完成、待提交」。真实下单只需去掉 noSubmit（会真扣 $" + cart.total + " + 真实发货）。");
} else {
  console.log("（无缓存卡，真实场景此处发新卡；演示止于此）");
}
