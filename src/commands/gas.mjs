/**
 * gas 命令：通过 WalletConnect 从主钱包向本地钱包转 BNB（withdraw 时支付 gas）
 */
import { loadConfig } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import {
  withWallet,
  requestNativeTransfer,
  setStatus,
} from "../walletconnect.mjs";
import { BSC_RPC_URL } from "../constants.mjs";

const DEFAULT_GAS_AMOUNT = "0.001";

export async function gas(opts) {
  const config = loadConfig();

  if (!config.privateKey || !config.address) {
    console.error(JSON.stringify({
      error: "No local wallet found. Run 'aicard setup --check' first to auto-create one.",
    }));
    process.exit(1);
  }

  const amount = opts.amount || DEFAULT_GAS_AMOUNT;
  const sessionAddress = config.address;
  console.error(`Local wallet: ${sessionAddress}`);

  try {
    const bal = await getBalanceByAddress(sessionAddress);
    console.error(`Current balance: ${bal.bnb} BNB`);
  } catch {}

  let bnbTxHash = null;

  await withWallet({ amount, token: "BNB" }, async ({ signClient, session, peerAddress }) => {
    const { createPublicClient, http } = await import("viem");
    const { bsc } = await import("viem/chains");
    const publicClient = createPublicClient({
      chain: bsc,
      transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
    });

    setStatus("signing", { amount, token: "BNB", to: sessionAddress });
    console.error(`\nRequesting BNB transfer: ${amount} BNB → ${sessionAddress}`);
    console.error("Please confirm the transaction in your wallet app...");

    bnbTxHash = await requestNativeTransfer(signClient, session, {
      from: peerAddress,
      to: sessionAddress,
      value: amount,
    });
    setStatus("tx_submitted", { txHash: bnbTxHash, amount, token: "BNB" });
    console.error(`BNB transfer submitted: ${bnbTxHash}`);
    console.error("Waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: bnbTxHash,
      timeout: 60_000,
    });
    if (receipt.status !== "success") {
      throw new Error("BNB transfer transaction reverted");
    }

    setStatus("confirmed", { txHash: bnbTxHash, amount, token: "BNB" });
    console.error("BNB transfer confirmed.");
  });

  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { bnb: "unknown" };
  }

  console.log(JSON.stringify({
    success: true,
    localWallet: {
      address: sessionAddress,
      bnb: finalBalance.bnb,
    },
    transaction: bnbTxHash,
  }, null, 2));
  process.exit(0);
}
