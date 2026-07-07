/**
 * 收银台填单 兼容性 + 效率 回归 harness（多商户、跨品类、真实调用、fill-only 不提交）
 *   检索 → 建车 → shop pay --fill-only（填齐地址/配送/账单/卡，停在点 Pay 前）→ 采集 perf 分阶段耗时 + shippingVia + signals
 *
 * 运行：
 *   node test/checkout-fill.mjs                         # 默认品类各 1 家做冒烟
 *   AICARD_TEST_PER_CAT=3 node test/checkout-fill.mjs   # 每品类 3 家，更广覆盖
 *   AICARD_TEST_SHOPS="eyeshinecosmetics.com|gid://shopify/ProductVariant/44549238489276" node test/checkout-fill.mjs
 *                                                        # 只测指定 shop|variant（可逗号分隔多个）
 * 前置：本地有可用缓存卡（aicard shop cards 至少 1 张 usable，否则 pay 会试发新卡而失败）；需联网。
 * 安全：全程 --fill-only（只填不提交），不真实下单、不扣款、不消费卡；卡面不落本脚本，截图入 os.tmpdir()。
 * 判据：outcome=filled_no_submit 且 shippingReady/billingSameAsShipping/卡四字段 均 true → 该商户"填单到点支付前"成功。
 *       其余（shipping_not_ready/card_not_supported/checkout_unavailable/bot_blocked…）多为真实商户约束，逐条列出。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = "bin/cli.mjs";
const RESULTS = process.env.AICARD_TEST_RESULTS || join(tmpdir(), "aicard-fill-results.jsonl");
process.chdir(ROOT);

// 收货地址（测试用，可用 env 覆盖）。邮箱默认占位——fill-only 不发邮件，格式合法即可。
const ADDR = [
  "--country", process.env.AICARD_TEST_COUNTRY || "United States",
  "--region", process.env.AICARD_TEST_REGION || "California",
  "--city", process.env.AICARD_TEST_CITY || "Los Angeles",
  "--zip", process.env.AICARD_TEST_ZIP || "90001",
  "--first", "Michael", "--last", "Johnson",
  "--email", process.env.AICARD_TEST_EMAIL || "checkout-test@example.com",
  "--address1", "742 Evergreen Terrace", "--phone", "2135554821",
];

// spawnSync 调 CLI：stderr 重定向到【文件】而非管道——Playwright 的 chromium 子进程会占住 stderr 管道 fd，
// 用管道会让 spawnSync 一直等 EOF 直到超时。stdout 取一行 JSON envelope，stderr 文件解析 [perf] 分阶段耗时。
function cli(args, { timeout = 200000, perf = false } = {}) {
  const env = perf ? { ...process.env, AICARD_PERF: "1" } : process.env;
  const errFile = join(tmpdir(), `aicard-test-err-${Math.random().toString(36).slice(2)}.txt`);
  const efd = openSync(errFile, "w");
  let r;
  try { r = spawnSync("node", [CLI, ...args], { encoding: "utf8", timeout, env, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", efd] }); }
  finally { closeSync(efd); }
  let stderr = ""; try { stderr = readFileSync(errFile, "utf8"); unlinkSync(errFile); } catch { /* */ }
  const line = (r.stdout || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  let json = null; try { json = JSON.parse(line); } catch { /* */ }
  const P = {}; for (const m of stderr.matchAll(/\[perf\]\s+([\w-]+):\s+([\d.]+)s/g)) P[m[1]] = parseFloat(m[2]);
  return { json: json || { ok: false, error: (r?.error?.message || "no json").split("\n")[0] }, perf: P };
}

const DEFAULT_CATS = {
  mug: ["coffee mug", "ceramic mug"],
  shoes: ["running shoes", "sneakers"],
  clothes: ["cotton t-shirt", "hoodie"],
  fan: ["portable fan", "mini electric fan"],
  headphones: ["bluetooth headphones", "earbuds"],
  home: ["scented candle", "throw pillow"],
  bag: ["backpack", "tote bag"],
  accessories: ["leather wallet", "sunglasses"],
};
const PER_CAT = Number(process.env.AICARD_TEST_PER_CAT || 1);

const done = new Set();
if (existsSync(RESULTS)) for (const l of readFileSync(RESULTS, "utf8").split("\n")) { try { const o = JSON.parse(l); if (o.shop) done.add(o.shop); } catch { /* */ } }

// 1) 收集商户：显式 AICARD_TEST_SHOPS 优先；否则按品类检索去重取商户
let picks = [];
if (process.env.AICARD_TEST_SHOPS) {
  picks = process.env.AICARD_TEST_SHOPS.split(",").map((s) => { const [shop, variant] = s.trim().split("|"); return { cat: "custom", shop, variant, title: shop, price: null }; });
} else {
  const seen = new Set(done);
  for (const [cat, qs] of Object.entries(DEFAULT_CATS)) {
    let got = 0;
    for (const q of qs) {
      if (got >= PER_CAT) break;
      const { json: r } = cli(["shop", "search", "--query", q, "--limit", "10"], { timeout: 60000 });
      if (!r?.ok) continue;
      for (const p of r.data.products || []) {
        const shop = p.merchantDomain;
        if (!shop || seen.has(shop)) continue;
        const v = (p.variants || []).find((x) => x.available) || (p.variants || [])[0];
        if (!v?.variantId || !(p.priceMin >= 3 && p.priceMin <= 150)) continue;
        picks.push({ cat, shop, variant: v.variantId, title: (p.title || "").slice(0, 34), price: p.priceMin });
        seen.add(shop); got++;
        if (got >= PER_CAT) break;
      }
    }
  }
}
console.log(`=== 候选 ${picks.length} 家（已完成跳过 ${[...picks].filter((p) => done.has(p.shop)).length}） ===`);
for (const p of picks) console.log(`[${p.cat}] ${p.shop} | ${p.title}${p.price ? " | $" + p.price : ""}`);

// 2) 逐个 cart → pay --fill-only
for (const p of picks) {
  if (done.has(p.shop)) continue;
  const { json: cart } = cli(["shop", "cart", "--shop", p.shop, "--variant", p.variant, "--qty", "1", "--country", "US", "--zip", process.env.AICARD_TEST_ZIP || "90001"], { timeout: 60000 });
  if (!cart?.ok) { appendFileSync(RESULTS, JSON.stringify({ cat: p.cat, shop: p.shop, phase: "cart", ok: false, note: (cart?.data?.message || cart?.error || "").slice(0, 60) }) + "\n"); console.log(`\n[${p.cat}] ${p.shop} cart FAIL`); continue; }
  const d = cart.data;
  if (d.testBackend || d.acceptsCard === false) { appendFileSync(RESULTS, JSON.stringify({ cat: p.cat, shop: p.shop, phase: "cart", ok: null, note: d.testBackend ? "测试店" : "不收卡" }) + "\n"); console.log(`\n[${p.cat}] ${p.shop} SKIP(${d.testBackend ? "测试店" : "不收卡"})`); continue; }
  const amt = d.total || d.subtotal || p.price || "9.99";
  const { json: pay, perf: P } = cli(["shop", "pay", "--continue-url", d.continueUrl, "--amount", String(amt), "--fill-only", "--out", join(tmpdir(), "aicard-test-" + p.shop.replace(/[^a-z0-9]/gi, "")), ...ADDR], { timeout: 200000, perf: true });
  const s = pay?.data?.signals || {};
  const ph = {
    open_country: P["country-done"] ?? null,
    fields: (P["fields-filled"] != null && P["country-done"] != null) ? +(P["fields-filled"] - P["country-done"]).toFixed(1) : null,
    region_overlay: (P["address-filled"] != null && P["fields-filled"] != null) ? +(P["address-filled"] - P["fields-filled"]).toFixed(1) : null,
    shipWait: (P["shipping-ready"] != null && P["address-filled"] != null) ? +(P["shipping-ready"] - P["address-filled"]).toFixed(1) : null,
    card: (P["card-filled"] != null && P["overlays-dismissed"] != null) ? +(P["card-filled"] - P["overlays-dismissed"]).toFixed(1) : null,
    total: P["card-filled"] ?? null,
  };
  const okFill = pay?.data?.outcome === "filled_no_submit" && s.shippingReady && s.billingSameAsShipping && s.card_number?.filled && s.card_expiry?.filled && s.card_cvc?.filled;
  const rec = { cat: p.cat, shop: p.shop, phase: "pay", outcome: pay?.data?.outcome || pay?.error, okFill: !!okFill, via: s.shippingVia || "?", ph, sig: { c: s.countrySelected, r: s.regionSelected, sh: s.shippingReady, b: s.billingSameAsShipping, cd: !!(s.card_number?.filled && s.card_expiry?.filled && s.card_cvc?.filled) }, reason: (s.reason || "").slice(0, 80) };
  appendFileSync(RESULTS, JSON.stringify(rec) + "\n");
  console.log(`\n[${p.cat}] ${p.shop} => okFill=${okFill} via=${rec.via} total=${ph.total}s shipWait=${ph.shipWait}s outcome=${rec.outcome}`);
}

// 3) 汇总（读全部落盘，含续跑前）
const all = [];
for (const l of readFileSync(RESULTS, "utf8").split("\n")) { try { const o = JSON.parse(l); if (o.shop) all.push(o); } catch { /* */ } }
const pays = all.filter((r) => r.phase === "pay");
const ok = pays.filter((r) => r.okFill);
const num = (xs) => xs.filter((x) => x != null && !isNaN(x));
const avg = (xs) => num(xs).length ? +(num(xs).reduce((a, b) => a + b, 0) / num(xs).length).toFixed(1) : "-";
const max = (xs) => num(xs).length ? Math.max(...num(xs)) : "-";
console.log("\n\n================= 汇总 =================");
console.log(`商户 ${all.length} | cart失败 ${all.filter((r) => r.phase === "cart" && r.ok === false).length} | 跳过(测试店/不收卡) ${all.filter((r) => r.ok === null).length} | 进入填单 ${pays.length}`);
console.log(`★ 填单成功(到点支付前): ${ok.length}/${pays.length} = ${pays.length ? Math.round(ok.length / pays.length * 100) : 0}%`);
console.log(`\n--- 用时(成功样本, 秒) ---`);
console.log(`  我方固定开销(总-运费等待): avg ${avg(ok.map((r) => (r.ph?.total != null && r.ph?.shipWait != null) ? +(r.ph.total - r.ph.shipWait).toFixed(1) : null))}`);
console.log(`  商户算运费等待(不可控变量): avg ${avg(ok.map((r) => r.ph?.shipWait))} / max ${max(ok.map((r) => r.ph?.shipWait))}`);
console.log(`  总墙钟: avg ${avg(ok.map((r) => r.ph?.total))} / max ${max(ok.map((r) => r.ph?.total))}`);
const via = {}; for (const r of ok) via[r.via] = (via[r.via] || 0) + 1;
console.log(`\n--- 收银台结构分布(shippingVia): ${JSON.stringify(via)} ---`);
console.log(`\n--- 未成功 ---`);
for (const r of pays.filter((r) => !r.okFill)) console.log(`  [${r.cat}] ${r.shop}: ${r.outcome} sig=${JSON.stringify(r.sig)} ${r.reason}`);
console.log(`\n结果落盘: ${RESULTS}（删除即重新全量测；断了重跑自动续）`);
