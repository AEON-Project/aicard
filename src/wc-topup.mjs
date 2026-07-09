/**
 * inlineWalletConnectTopup：余额/gas 不足时，通过 WalletConnect 让用户在钱包 App 里
 * 确认一笔（或两笔）转账，把 USDT / BNB 充到本地会话钱包。
 *
 * 由 `create` 与 `shop pay`（发新卡）共用：两者都需要"余额不足→交互补足→继续"的同一套逻辑，
 * 且补足金额必须来自服务端返回的真实付款要求（已含开卡费），避免用户凭面额猜金额而少充、被迫二次充值。
 */
import {
  withWallet,
  requestERC20Transfer,
  requestNativeTransfer,
  setStatus,
} from "./walletconnect.mjs";
import { BSC_RPC_URL, USDT_BSC } from "./constants.mjs";
import { logInfo } from "./output.mjs";

export const AUTO_GAS_BNB = "0.0003";

/**
 * @param {object} p
 * @param {string} p.sessionAddress 本地会话钱包地址（收款方）
 * @param {string|null} p.amount USDT 补足金额（字符串，如 "2.000000"）；null=不充 USDT
 * @param {boolean} p.needGas 是否同时补一笔 BNB 作 approve gas
 */
export async function inlineWalletConnectTopup({ sessionAddress, amount, needGas }) {
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
