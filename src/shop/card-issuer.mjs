/**
 * CardIssuer：发一张虚拟卡并返回【完整卡面】（number/expiry/cvc），全程内存流转 + 入本地卡列表。
 *
 * 复用 x402.mjs 的手动签名提交路径，拿到服务端【未脱敏】原始响应，从中提取完整卡面
 * 直接交给 CheckoutFiller，并缓存到本地卡列表（cards.mjs）供后续购物复用。
 * 卡面不经过 CLI stdout、不写日志、不入 sanitize。
 *
 * 前置：本地会话钱包需已有足够 USDT + 首次 approve 授权。
 * 本模块不触发 WalletConnect 交互充值（那是 `aicard create` 的前台交互流程）；
 * 余额/授权不足则报错，提示用户先 `aicard topup` / `aicard create` 完成充值与授权。
 */
import axios from "axios";
import { createX402Api, fetchPaymentRequirements } from "../x402.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import { resolve } from "../config.mjs";
import { MIN_AMOUNT, MAX_AMOUNT, POLL_INTERVAL, MAX_POLLS } from "../constants.mjs";
import { extractCard, addCard } from "./cards.mjs";

export class CardError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "CardError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * @param {object} p
 * @param {number} p.amount - 卡面额（USD）
 * @param {string} [p.appId="TEST000001"]
 * @param {string} [p.serviceUrl]
 * @param {string} [p.privateKey]
 * @returns {Promise<{orderNo:string, card:{number,expiry,cvc,name,scheme}, amount:number}>}
 */
export async function issueCard(p) {
  const serviceUrl = resolve(p.serviceUrl, "AGENT_PAY_SERVICE_URL", "serviceUrl");
  const privateKey = resolve(p.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  if (!privateKey) throw new CardError("WALLET_NOT_CONFIGURED", "本地钱包未配置，请先运行 aicard setup --check");

  const amount = Number(p.amount);
  if (isNaN(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT)
    throw new CardError("AMOUNT_OUT_OF_RANGE", `金额需在 $${MIN_AMOUNT} ~ $${MAX_AMOUNT}`, { min: MIN_AMOUNT, max: MAX_AMOUNT });

  const appId = p.appId || "TEST000001";
  const url = `${serviceUrl}/open/ai/x402/card/create?amount=${encodeURIComponent(amount)}&appId=${encodeURIComponent(appId)}`;

  // 1. 取 x402 付款要求
  const req = await fetchPaymentRequirements(url);

  // 2. 余额 / 授权检查（不足即报错，不做交互充值）
  const { address, usdt, bnbRaw } = await getWalletBalance(privateKey);
  if (parseFloat(usdt) < req.amountUsdt)
    throw new CardError("INSUFFICIENT_USDT", `USDT 不足：需 ${req.amountUsdt}，当前 ${usdt}。请先 aicard topup`, { required: req.amountUsdt, available: usdt });
  const allowance = await getAllowance(address);
  if (allowance < BigInt(req.amountWei) && bnbRaw === 0n)
    throw new CardError("NEEDS_APPROVE_GAS", "需要 approve 授权但本地钱包无 BNB。请先 aicard gas，或用 aicard create 完成首次授权");

  // 3. 手动签名并提交（沿用第一次的精确金额，避免二次请求金额漂移）
  const { client } = createX402Api(privateKey);
  const { x402HTTPClient } = await import("@aeon-ai-pay/core/client");
  const httpClient = new x402HTTPClient(client);
  const raw402 = req.raw402Response;
  const getHeader = (name) => {
    const v = raw402.headers[name] ?? raw402.headers[name.toLowerCase()];
    return typeof v === "string" ? v : undefined;
  };
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, raw402.data);
  const payload = await client.createPaymentPayload(paymentRequired);
  const payHeaders = httpClient.encodePaymentSignatureHeader(payload);

  let response;
  try {
    response = await axios.get(url, { headers: { ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE" } });
  } catch (e) {
    throw new CardError("PAYMENT_FAILED", `发卡支付失败: ${e.message}`, { status: e.response?.status });
  }

  const orderNo = req.orderNo || response.data?.model?.orderNo || response.data?.orderNo || null;

  // 4. 从未脱敏 raw response 提取完整卡面；首响应未 ready 则轮询
  let card = extractCard(response.data);
  if (!card && orderNo) card = await pollForCard(serviceUrl, orderNo);
  if (!card) throw new CardError("CARD_NOT_READY", "发卡请求已提交但未取到完整卡面", { orderNo });

  // 5. 入本地卡列表（供后续购物复用）
  addCard({ orderNo, ...card, amount, currency: "USD" });

  return { orderNo, card, amount };
}

async function pollForCard(serviceUrl, orderNo) {
  for (let i = 0; i < MAX_POLLS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, i <= 5 ? 2000 : POLL_INTERVAL));
    try {
      const res = await axios.get(`${serviceUrl}/open/ai/x402/card/status?orderNo=${encodeURIComponent(orderNo)}`);
      const card = extractCard(res.data);
      if (card) return card;
      if (res.data?.model?.orderStatus === "FAIL") return null;
    } catch {
      /* 轮询期间的瞬时错误忽略 */
    }
  }
  return null;
}
