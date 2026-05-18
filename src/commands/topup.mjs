/**
 * topup 命令：通过 WalletConnect 为本地钱包追加 USDT
 */
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { loadConfig } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import {
  withWallet,
  requestERC20Transfer,
  setStatus,
  WalletConnectError,
} from "../walletconnect.mjs";
import { BSC_RPC_URL, USDT_BSC } from "../constants.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function topup(opts) {
  const config = loadConfig();

  if (!config.privateKey || !config.address) {
    emitErr("topup", "WALLET_NOT_CONFIGURED", {
      message: "No session key found. Run 'aicard setup --check' first to auto-create one.",
    });
    return;
  }

  const amount = opts.amount || "50";
  const sessionAddress = config.address;
  logInfo(`Session key: ${sessionAddress}`);

  try {
    const bal = await getBalanceByAddress(sessionAddress);
    logInfo(`Current balance: ${bal.usdt} USDT`);
  } catch {}

  let usdtTxHash = null;

  try {
    await withWallet({ amount }, async ({ signClient, session, peerAddress }) => {
      const publicClient = createPublicClient({
        chain: bsc,
        transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
      });

      setStatus("signing", { amount, token: "USDT", to: sessionAddress });
      logInfo(`\nRequesting USDT transfer: ${amount} USDT → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      usdtTxHash = await requestERC20Transfer(signClient, session, {
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
      setStatus("confirmed", { txHash: usdtTxHash, amount, token: "USDT" });
    });
  } catch (e) {
    if (e instanceof WalletConnectError) {
      emitErr("topup", e.code, { message: e.message });
    } else {
      emitErr("topup", "INTERNAL_ERROR", { message: e.message });
    }
    return;
  }

  // 查询最终余额
  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { usdt: "unknown", bnb: "unknown" };
  }

  const data = {
    sessionKey: {
      address: sessionAddress,
      usdt: finalBalance.usdt,
      bnb: finalBalance.bnb,
    },
    transaction: usdtTxHash,
  };
  emitOk("topup", data, { success: true, ...data });
}
