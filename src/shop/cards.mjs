/**
 * 本地卡列表：缓存已发的虚拟卡（含完整卡面），供 Shopify 购物复用。
 *
 * 一次性卡模型：一张卡用于一单后标记 used，不再被选用；"卡充值" = 发一张新卡。
 * 余额判断：用发卡时记录的面额（create --amount $X → 卡余额 $X），支付时比对 面额 >= 订单额。
 *
 * ⚠️ 安全：完整卡面（number/cvc/expiry）落盘在 ~/.aicard/cards.json，文件权限 0600。
 *    这是产品明确要求的缓存复用；请勿放入共享/云同步目录。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".aicard");
const CARDS_FILE = join(DIR, "cards.json");

export function loadCards() {
  try {
    return JSON.parse(readFileSync(CARDS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveCards(cards) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), { mode: 0o600 });
  chmodSync(CARDS_FILE, 0o600);
}

/** 追加一张卡（按 orderNo 去重）。返回入库/已存在的卡。 */
export function addCard({ orderNo, number, expiry, cvc, name, scheme, amount, currency }) {
  if (!number || !expiry || !cvc) return null;
  const cards = loadCards();
  if (orderNo) {
    const dup = cards.find((c) => c.orderNo === orderNo);
    if (dup) return dup;
  }
  const card = {
    orderNo: orderNo || null,
    number,
    expiry,
    cvc,
    name: name || "Card Holder",
    scheme: scheme || null,
    amount: amount != null ? Number(amount) : null,
    currency: currency || "USD",
    used: false,
    createdAt: new Date().toISOString(),
    usedAt: null,
    usedFor: null,
  };
  cards.push(card);
  saveCards(cards);
  return card;
}

/** 找一张够付 total 且未用的卡；选够用里面额最小的以减少浪费。无则 null。 */
export function findUsableCard(total) {
  const t = Number(total);
  const usable = loadCards().filter((c) => !c.used && c.number && c.amount != null && c.amount >= t);
  if (!usable.length) return null;
  usable.sort((a, b) => a.amount - b.amount);
  return usable[0];
}

/** 标记某卡已用（一次性）。 */
export function markCardUsed(orderNo, { usedFor } = {}) {
  if (!orderNo) return false;
  const cards = loadCards();
  const c = cards.find((x) => x.orderNo === orderNo);
  if (!c) return false;
  c.used = true;
  c.usedAt = new Date().toISOString();
  c.usedFor = usedFor || null;
  saveCards(cards);
  return true;
}

/** 脱敏列出（展示用，不含完整卡号/CVV/有效期）。 */
export function listCardsSafe() {
  return loadCards().map((c) => ({
    orderNo: c.orderNo,
    last4: String(c.number).slice(-4),
    scheme: c.scheme,
    amount: c.amount,
    currency: c.currency,
    used: c.used,
    createdAt: c.createdAt,
    usedFor: c.usedFor,
  }));
}

// ---------- 从服务端未脱敏 raw response 提取完整卡面（供 create / issueCard 复用）----------

export function extractCard(data) {
  const found = { number: null, cvc: null, expiry: null, expMonth: null, expYear: null, name: null, scheme: null };
  walk(data, found);
  if (!found.number || !found.cvc) return null;
  const expiry = found.expiry || (found.expMonth && found.expYear ? `${found.expMonth}/${found.expYear}` : null);
  if (!expiry) return null;
  if (found.number.includes("•") || found.number.replace(/\D/g, "").length < 12) return null; // 必须是完整卡号
  return {
    number: found.number,
    expiry: normalizeExpiry(expiry),
    cvc: found.cvc,
    name: found.name || "Card Holder",
    scheme: found.scheme || null,
  };
}

function walk(obj, out) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      walk(v, out);
      continue;
    }
    if (v == null || v === "") continue;
    const key = k.toLowerCase().replace(/[-_\s]/g, "");
    if (["cardnumber", "cardno", "pan"].includes(key)) out.number = String(v).replace(/\s/g, "");
    else if (["cvv", "cvv2", "cvc", "cvc2", "securitycode"].includes(key)) out.cvc = String(v);
    else if (["expiry", "expirydate", "expiredate", "cardexpiry", "expirationdate", "validthru"].includes(key)) out.expiry = String(v);
    else if (["expmonth", "expirymonth", "expirationmonth"].includes(key)) out.expMonth = String(v).padStart(2, "0");
    else if (["expyear", "expiryyear", "expirationyear"].includes(key)) out.expYear = String(v);
    else if (["cardscheme", "scheme", "cardtype", "brand"].includes(key)) out.scheme = String(v);
    else if (["cardholder", "holdername", "nameoncard"].includes(key)) out.name = String(v);
  }
}

/** 归一化到 "MM/YY"（Shopify 收银台单框可接受）。 */
function normalizeExpiry(s) {
  if (/^\d{2}\s*\/\s*\d{2}$/.test(s)) return s.replace(/\s/g, "");
  const d = s.replace(/[^\d]/g, "");
  let mm, yy;
  if (/^\d{4}$/.test(d)) {
    mm = d.slice(0, 2);
    yy = d.slice(2);
  } else if (/^\d{6}$/.test(d)) {
    if (parseInt(d.slice(0, 2), 10) > 12) {
      yy = d.slice(2, 4);
      mm = d.slice(4);
    } else {
      mm = d.slice(0, 2);
      yy = d.slice(4);
    }
  } else return s;
  return `${mm}/${yy}`;
}
