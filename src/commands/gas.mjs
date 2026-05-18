/**
 * gas 命令：通过 WalletConnect 从主钱包向本地钱包转 BNB（withdraw 时支付 gas）
 */
import { loadConfig } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import {
  withWallet,
  requestNativeTransfer,
  setStatus,
  WalletConnectError,
} from "../walletconnect.mjs";
import { BSC_RPC_URL } from "../constants.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

const DEFAULT_GAS_AMOUNT = "0.001";

export async function gas(opts) {
  const config = loadConfig();

  if (!config.privateKey || !config.address) {
    emitErr("gas", "WALLET_NOT_CONFIGURED", {
      message: "No local wallet found. Run 'aicard setup --check' first to auto-create one.",
    });
    return;
  }

  const amount = opts.amount || DEFAULT_GAS_AMOUNT;
  const sessionAddress = config.address;
  logInfo(`Local wallet: ${sessionAddress}`);

  try {
    const bal = await getBalanceByAddress(sessionAddress);
    logInfo(`Current balance: ${bal.bnb} BNB`);
  } catch {}

  let bnbTxHash = null;

  try {
    await withWallet({ amount, token: "BNB" }, async ({ signClient, session, peerAddress }) => {
      const { createPublicClient, http } = await import("viem");
      const { bsc } = await import("viem/chains");
      const publicClient = createPublicClient({
        chain: bsc,
        transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
      });

      setStatus("signing", { amount, token: "BNB", to: sessionAddress });
      logInfo(`\nRequesting BNB transfer: ${amount} BNB → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      bnbTxHash = await requestNativeTransfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        value: amount,
      });
      setStatus("tx_submitted", { txHash: bnbTxHash, amount, token: "BNB" });
      logInfo(`BNB transfer submitted: ${bnbTxHash}`);
      logInfo("Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: bnbTxHash,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error("BNB transfer transaction reverted");
      }

      setStatus("confirmed", { txHash: bnbTxHash, amount, token: "BNB" });
      logInfo("BNB transfer confirmed.");
    });
  } catch (e) {
    if (e instanceof WalletConnectError) {
      emitErr("gas", e.code, { message: e.message });
    } else {
      emitErr("gas", "INTERNAL_ERROR", { message: e.message });
    }
    return;
  }

  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { bnb: "unknown" };
  }

  const data = {
    localWallet: {
      address: sessionAddress,
      bnb: finalBalance.bnb,
    },
    transaction: bnbTxHash,
  };
  emitOk("gas", data, { success: true, ...data });
}
