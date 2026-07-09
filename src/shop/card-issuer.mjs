/**
 * CardIssuer：发一张虚拟卡并返回【完整卡面】（number/expiry/cvc），全程内存流转 + 入本地卡列表。
 *
 * 复用 x402.mjs 的手动签名提交路径，拿到服务端【未脱敏】原始响应，从中提取完整卡面
 * 直接交给 CheckoutFiller，并缓存到本地卡列表（cards.mjs）供后续购物复用。
 * 卡面不经过 CLI stdout、不写日志、不入 sanitize。
 *
 * 前置：本地会话钱包需已有首次 approve 授权（无授权则报错，引导先 `aicard create`）。
 * USDT 不足时：autoFund=true 走 WalletConnect 自动补足差额（差额=本次含开卡费的 req.amountUsdt−余额，
 * 服务端权威金额，杜绝凭面额少充/二次充值）；autoFund=false 则报错提示先 `aicard topup`。
 */
import axios from "axios";
import { createX402Api, fetchPaymentRequirements } from "../x402.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import { resolve } from "../config.mjs";
import { MIN_AMOUNT, MAX_AMOUNT, POLL_INTERVAL, MAX_POLLS } from "../constants.mjs";
import { extractCard, addCard } from "./cards.mjs";
import { inlineWalletConnectTopup } from "../wc-topup.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import { logInfo } from "../output.mjs";

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
 * @param {boolean} [p.autoFund=false] - USDT 不足时是否经 WalletConnect 自动补足差额（shop pay 用 true）
 * @returns {Promise<{orderNo:string, card:{number,expiry,cvc,name,scheme}, amount:number}>}
 */
export async function issueCard(p) {
  const serviceUrl = resolve(p.serviceUrl, "AGENT_PAY_SERVICE_URL", "serviceUrl");
  const privateKey = resolve(p.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  if (!privateKey) throw new CardError("WALLET_NOT_CONFIGURED", "Local wallet not configured. Please run aicard setup --check first.");

  const amount = Number(p.amount);
  if (isNaN(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT)
    throw new CardError("AMOUNT_OUT_OF_RANGE", `Amount must be between $${MIN_AMOUNT} and $${MAX_AMOUNT}`, { min: MIN_AMOUNT, max: MAX_AMOUNT });

  const appId = p.appId || "TEST000001";
  const url = `${serviceUrl}/open/ai/x402/card/create?amount=${encodeURIComponent(amount)}&appId=${encodeURIComponent(appId)}`;

  // 1. 取 x402 付款要求
  const req = await fetchPaymentRequirements(url);

  // 2. 余额 / 授权检查
  const { address, usdt, bnbRaw } = await getWalletBalance(privateKey);
  const allowance = await getAllowance(address);
  if (allowance < BigInt(req.amountWei) && bnbRaw === 0n)
    throw new CardError("NEEDS_APPROVE_GAS", "An approve authorization is required but the local wallet has no BNB. Please run aicard gas first, or use aicard create to complete the initial authorization.");

  // USDT 不足：
  //  - autoFund：直接补足差额。差额取自【本次】含开卡费的 req.amountUsdt（服务端权威金额，
  //    非面额，杜绝用户凭面额少充、被迫二次充值）。一次 WalletConnect 确认即可继续下单。
  //  - 非 autoFund：保持原行为，报错让用户先手动 topup。
  if (parseFloat(usdt) < req.amountUsdt) {
    if (!p.autoFund)
      throw new CardError("INSUFFICIENT_USDT", `Insufficient USDT: need ${req.amountUsdt}, currently have ${usdt}. Please run aicard topup first.`, { required: req.amountUsdt, available: usdt });

    const shortfall = req.amountUsdt - parseFloat(usdt);
    logInfo(`> USDT short by ${shortfall.toFixed(6)} (need ${req.amountUsdt}, have ${usdt}); auto-funding the exact shortfall via WalletConnect...`);
    try {
      await inlineWalletConnectTopup({ sessionAddress: address, amount: shortfall.toFixed(6), needGas: false });
    } catch (e) {
      if (e instanceof WalletConnectError) throw new CardError(e.code, e.message);
      throw new CardError("TOPUP_FAILED", `Auto top-up failed: ${e.message}`);
    }

    // 补足后按同一 req 复核，仍不足则报错（不再自动重试，避免重复充值）
    const fresh = await getWalletBalance(privateKey);
    if (parseFloat(fresh.usdt) < req.amountUsdt)
      throw new CardError("INSUFFICIENT_USDT", `Still insufficient USDT after funding: need ${req.amountUsdt}, currently have ${fresh.usdt}.`, { required: req.amountUsdt, available: fresh.usdt });
  }

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
    throw new CardError("PAYMENT_FAILED", `Card issuance payment failed: ${e.message}`, { status: e.response?.status });
  }

  const orderNo = req.orderNo || response.data?.model?.orderNo || response.data?.orderNo || null;

  // 4. 从未脱敏 raw response 提取完整卡面；首响应未 ready 则轮询
  let card = extractCard(response.data);
  if (!card && orderNo) card = await pollForCard(serviceUrl, orderNo);
  if (!card) throw new CardError("CARD_NOT_READY", "Card issuance request submitted but full card details could not be retrieved", { orderNo });

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
