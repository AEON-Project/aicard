import { createX402Api, decodePaymentResponse, fetchPaymentRequirements } from "../x402.mjs";
import { resolve } from "../config.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import { sanitizeOutput } from "../sanitize.mjs";
import axios from "axios";
import {
  MIN_AMOUNT, MAX_AMOUNT, POLL_INTERVAL, MAX_POLLS,
  BSC_RPC_URL, USDT_BSC,
} from "../constants.mjs";
import {
  withWallet,
  requestERC20Transfer,
  requestNativeTransfer,
  setStatus,
  WalletConnectError,
} from "../walletconnect.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

const AUTO_GAS_BNB = "0.0003";

export async function create(opts) {
  logInfo("Creating Agent Card...");
  const serviceUrl = resolve(opts.serviceUrl, "AGENT_PAY_SERVICE_URL", "serviceUrl");
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const { amount, poll, appId, dryRun } = opts;
  const amountNum = parseFloat(amount);

  // 1. 参数校验
  if (!serviceUrl) {
    emitErr("create", "SERVICE_URL_MISSING", {
      message: "Missing service URL. This should not happen — default is built-in. Run: aicard setup --service-url <url> to override.",
    });
    return;
  }
  if (!privateKey) {
    emitErr("create", "WALLET_NOT_CONFIGURED");
    return;
  }
  // 2. 限额校验
  if (isNaN(amountNum) || amountNum < MIN_AMOUNT) {
    emitErr("create", "AMOUNT_OUT_OF_RANGE", {
      message: `Amount must be at least $${MIN_AMOUNT}. Allowed range: $${MIN_AMOUNT} ~ $${MAX_AMOUNT} USD.`,
      min: MIN_AMOUNT,
      max: MAX_AMOUNT,
    });
    return;
  }
  if (amountNum > MAX_AMOUNT) {
    emitErr("create", "AMOUNT_OUT_OF_RANGE", {
      message: `Amount must not exceed $${MAX_AMOUNT}. Allowed range: $${MIN_AMOUNT} ~ $${MAX_AMOUNT} USD.`,
      min: MIN_AMOUNT,
      max: MAX_AMOUNT,
    });
    return;
  }

  // 3. 第一次请求 x402，获取实际付款要求（带唯一后缀的真实 USDT 金额）
  const url = `${serviceUrl}/open/ai/x402/card/create?amount=${encodeURIComponent(amount)}&appId=${encodeURIComponent(appId)}`;
  logInfo("Fetching payment requirements...");
  let requiredUsdt;
  let paymentReq;
  try {
    paymentReq = await fetchPaymentRequirements(url);
    requiredUsdt = paymentReq.amountUsdt;
    logInfo(`Required: ${requiredUsdt} USDT (pay to ${paymentReq.payTo})`);
  } catch (e) {
    emitErr("create", "PAYMENT_FETCH_FAILED", {
      message: `Failed to fetch payment requirements: ${e.message}`,
    });
    return;
  }

  // 4. 前置检查：预授权 → USDT 余额
  logInfo("Checking wallet...");
  let needTopup = false;
  let needGas = false;
  let sessionAddress;
  let topupAmount = null;

  try {
    const { address, usdt, bnb, bnbRaw } = await getWalletBalance(privateKey);
    sessionAddress = address;
    const usdtNum = parseFloat(usdt);

    logInfo(`Wallet: ${address}`);
    logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);

    // 1. 检查预授权额度（是否已对 facilitator 做过无限额度 approve）
    const allowance = await getAllowance(address);
    const requiredWei = BigInt(paymentReq.amountWei);
    logInfo(`Allowance: ${allowance.toString()} wei, Required: ${requiredWei.toString()} wei`);
    if (requiredWei === 0n) {
      emitErr("create", "INVALID_PAYMENT_AMOUNT", {
        message: "Server returned invalid payment amount (0). Please retry later.",
      });
      return;
    }
    if (allowance >= requiredWei) {
      logInfo("Allowance sufficient, no approve needed.");
    } else {
      // 预授权不足，需要 approve（消耗 BNB gas）
      logInfo(`Approve authorization insufficient (allowance ${allowance} < required ${requiredWei}), need approve.`);
      if (bnbRaw === 0n) {
        needGas = true;
        logInfo("No BNB for approve gas, will request BNB transfer.");
      } else {
        logInfo(`BNB available for approve gas (${bnb} BNB).`);
      }
    }

    // 2. 检查 USDT 余额
    if (usdtNum < requiredUsdt) {
      needTopup = true;
      const shortfall = requiredUsdt - usdtNum;
      topupAmount = shortfall.toFixed(6);
      logInfo(`USDT insufficient: have ${usdtNum}, need ${requiredUsdt}, shortfall ${topupAmount}`);
    } else {
      logInfo(`USDT sufficient: have ${usdtNum}, need ${requiredUsdt}`);
    }

    logInfo(`Decision: needTopup=${needTopup}, needGas=${needGas}${topupAmount ? `, topupAmount=${topupAmount}` : ""}`);

  } catch (e) {
    emitErr("create", "BALANCE_CHECK_FAILED", {
      message: `Balance check failed: ${e.message}`,
    });
    return;
  }

  // Dry-run：跑完前置检查，预演接下来会做什么，不签名/不上链/不打开 WalletConnect
  if (dryRun) {
    const will = [];
    if (needTopup) will.push("fund_usdt_via_walletconnect");
    if (needGas) will.push("fund_bnb_via_walletconnect");
    will.push("approve_or_skip", "sign_payment_eip712", "submit_to_facilitator");
    if (poll) will.push("poll_status");

    const preview = {
      dryRun: true,
      url,
      paymentRequirements: {
        amountUsdt: requiredUsdt,
        amountWei: paymentReq.amountWei,
        asset: paymentReq.asset,
        payTo: paymentReq.payTo,
        orderNo: paymentReq.orderNo,
      },
      wallet: { address: sessionAddress },
      decision: { needTopup, needGas, topupAmount },
      will,
    };
    emitOk("create", preview, { success: true, ...preview });
    return;
  }

  // 余额不足：通过 WalletConnect 内联充值
  if (needTopup || needGas) {
    logInfo("Funding flow triggered...");
    try {
      await inlineWalletConnectTopup({
        sessionAddress,
        amount: needTopup ? topupAmount : null,
        needGas,
      });
    } catch (e) {
      if (e instanceof WalletConnectError) {
        emitErr("create", e.code, { message: e.message });
      } else {
        emitErr("create", "INTERNAL_ERROR", { message: e.message });
      }
      return;
    }

    // 充值完成后重新检查余额
    logInfo("Re-checking wallet balance...");
    try {
      const { usdt, bnb, bnbRaw } = await getWalletBalance(privateKey);
      const usdtNum = parseFloat(usdt);
      logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);

      if (needGas && bnbRaw === 0n) {
        emitErr("create", "INSUFFICIENT_BNB", {
          message: "No BNB for approve transaction after funding. Run 'aicard gas' to add BNB manually.",
          address: sessionAddress,
        });
        return;
      }
      if (usdtNum < requiredUsdt) {
        emitErr("create", "INSUFFICIENT_USDT", {
          message: "Still insufficient USDT after funding.",
          required: `${requiredUsdt} USDT`,
          available: `${usdt} USDT`,
          address: sessionAddress,
        });
        return;
      }
    } catch (e) {
      emitErr("create", "BALANCE_CHECK_FAILED", {
        message: `Balance re-check failed: ${e.message}`,
      });
      return;
    }
  }

  // 5. 用第一次 402 响应手动签名并提交（避免二次请求产生不同金额）
  const { client } = createX402Api(privateKey);

  logInfo(`Creating card: $${amount} USD via ${url}`);

  try {
    const { x402HTTPClient } = await import("@aeon-ai-pay/core/client");
    const httpClient = new x402HTTPClient(client);

    // 从第一次的 402 响应中构造 paymentRequired
    const raw402 = paymentReq.raw402Response;
    const getHeader = (name) => {
      const value = raw402.headers[name] ?? raw402.headers[name.toLowerCase()];
      return typeof value === "string" ? value : undefined;
    };
    const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, raw402.data);

    // 用第一次的精确金额签名
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // 带签名头重新请求同一 URL
    const response = await axios.get(url, {
      headers: { ...paymentHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE" },
    });
    const paymentResponse = decodePaymentResponse(response.headers);
    const orderNo = paymentReq.orderNo || response.data?.model?.orderNo || response.data?.orderNo;

    const sanitizedData = sanitizeOutput(response.data);
    const successData = {
      orderNo,
      data: sanitizedData,
      paymentResponse,
    };

    // 在整个响应中递归查找 cardStatus
    function findCardStatus(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.cardStatus) return obj.cardStatus;
      for (const v of Object.values(obj)) {
        const found = findCardStatus(v);
        if (found) return found;
      }
      return null;
    }
    const initialOrderStatus = response.data?.model?.orderStatus;
    const initialCardStatus = findCardStatus(response.data);
    const cardReady = initialOrderStatus === "SUCCESS" || initialOrderStatus === "FAIL" || initialCardStatus === "ACTIVE";

    if (cardReady) {
      logInfo(`Card ready (orderStatus=${initialOrderStatus}, cardStatus=${initialCardStatus}), no polling needed.`);
      emitOk("create", successData, { success: true, ...successData });
      return;
    }

    if (poll && orderNo) {
      logInfo(`\nPolling status for orderNo: ${orderNo}`);
      const pollResult = await pollStatus(serviceUrl, orderNo);
      successData.pollResult = pollResult;
      emitOk("create", successData, { success: true, ...successData, pollResult });
      return;
    }

    if (poll && !orderNo) {
      logInfo("Warning: No orderNo available for polling. Query status manually.");
    }
    emitOk("create", successData, { success: true, ...successData });
  } catch (error) {
    emitErr("create", "PAYMENT_FAILED", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
  }
}

/**
 * 内联 WalletConnect 充值：在 create 流程内自动完成 USDT + BNB 充值
 */
async function inlineWalletConnectTopup({ sessionAddress, amount, needGas }) {
  // 页面展示：有 USDT 转账时显示 USDT 金额，仅 BNB gas 时显示 BNB 金额
  const pageAmount = amount || (needGas ? AUTO_GAS_BNB : null);
  const pageToken = amount ? "USDT" : "BNB";
  // 需要 gas 且有 USDT 转账时，页面额外显示 Gas Amount 行
  const pageGasAmount = (needGas && amount) ? AUTO_GAS_BNB : null;
  await withWallet({ amount: pageAmount, token: pageToken, gasAmount: pageGasAmount }, async ({ signClient, session, peerAddress }) => {
    const { createPublicClient, http } = await import("viem");
    const { bsc } = await import("viem/chains");
    const publicClient = createPublicClient({
      chain: bsc,
      transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
    });

    // USDT 充值
    if (amount) {
      setStatus("signing", { amount, token: "USDT", to: sessionAddress });
      logInfo(`\nRequesting USDT transfer: ${amount} USDT → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      const usdtTxHash = await requestERC20Transfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        token: USDT_BSC,
        amount,
        decimals: 18,
      });
      setStatus("tx_submitted", { txHash: usdtTxHash, amount, token: "USDT" });
      logInfo(`USDT transfer submitted: ${usdtTxHash}`);
      logInfo("Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: usdtTxHash,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error("USDT transfer transaction reverted");
      }
      logInfo("USDT transfer confirmed.");
    }

    // BNB gas 充值
    if (needGas) {
      // 检查 WC session 是否仍然存活
      try {
        const activeSessions = signClient.session.getAll();
        const sessionAlive = activeSessions.some(s => s.topic === session.topic);
        logInfo(`[WC session] alive=${sessionAlive}, topic=${session.topic}, active_sessions=${activeSessions.length}`);
        if (!sessionAlive) {
          throw new Error("WalletConnect session expired between USDT and BNB transfers. Run 'aicard gas' to add BNB manually.");
        }
      } catch (e) {
        if (e.message.includes("session expired")) throw e;
        logInfo(`[WC session] health check error: ${e.message}`);
      }

      setStatus("signing", { amount: AUTO_GAS_BNB, token: "BNB", to: sessionAddress });
      logInfo(`\nRequesting BNB transfer: ${AUTO_GAS_BNB} BNB → ${sessionAddress} (for approve gas)`);
      logInfo("Please confirm the transaction in your wallet app...");
      const bnbTxHash = await requestNativeTransfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        value: AUTO_GAS_BNB,
      });
      setStatus("tx_submitted", { txHash: bnbTxHash, amount: AUTO_GAS_BNB, token: "BNB" });
      logInfo(`BNB transfer submitted: ${bnbTxHash}`);
      const bnbReceipt = await publicClient.waitForTransactionReceipt({
        hash: bnbTxHash,
        timeout: 60_000,
      });
      if (bnbReceipt.status !== "success") {
        throw new Error("BNB transfer reverted");
      }
      logInfo("BNB transfer confirmed.");
    }

    setStatus("confirmed", { token: amount ? "USDT" : "BNB" });
  });
}

async function pollStatus(serviceUrl, orderNo) {
  for (let i = 1; i <= MAX_POLLS; i++) {
    // 第一次立即查，前5次每2秒快速轮询，之后每5秒
    if (i > 1) {
      const delay = i <= 5 ? 2000 : POLL_INTERVAL;
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await axios.get(
        `${serviceUrl}/open/ai/x402/card/status?orderNo=${encodeURIComponent(orderNo)}`,
      );
      const model = res.data?.model;
      logInfo(`[${i}/${MAX_POLLS}] orderStatus=${model?.orderStatus} channelStatus=${model?.channelStatus}`);

      if (model?.orderStatus === "SUCCESS" || model?.orderStatus === "FAIL" || model?.cardStatus === "ACTIVE") {
        return sanitizeOutput(model);
      }
    } catch (e) {
      logInfo(`[${i}/${MAX_POLLS}] Poll error: ${e.message}`);
    }
  }
  logInfo(`Polling timeout after ${MAX_POLLS} attempts. Check manually with: aicard status --order-no ${orderNo}`);
  return null;
}
