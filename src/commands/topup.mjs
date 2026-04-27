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
} from "../walletconnect.mjs";
import { BSC_RPC_URL, USDT_BSC } from "../constants.mjs";

export async function topup(opts) {
  const config = loadConfig();

  if (!config.privateKey || !config.address) {
    console.error(JSON.stringify({
      error: "No session key found. Run 'aicard setup --check' first to auto-create one.",
    }));
    process.exit(1);
  }

  const amount = opts.amount || "50";
  const sessionAddress = config.address;
  console.error(`Session key: ${sessionAddress}`);

  try {
    const bal = await getBalanceByAddress(sessionAddress);
    console.error(`Current balance: ${bal.usdt} USDT`);
  } catch {}

  let usdtTxHash = null;

  await withWallet({ amount }, async ({ signClient, session, peerAddress }) => {
    const publicClient = createPublicClient({
      chain: bsc,
      transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
    });

    setStatus("signing", { amount, token: "USDT", to: sessionAddress });
    console.error(`\nRequesting USDT transfer: ${amount} USDT → ${sessionAddress}`);
    console.error("Please confirm the transaction in your wallet app...");

    usdtTxHash = await requestERC20Transfer(signClient, session, {
      from: peerAddress,
      to: sessionAddress,
      token: USDT_BSC,
      amount,
      decimals: 18,
    });
    setStatus("tx_submitted", { txHash: usdtTxHash, amount, token: "USDT" });
    console.error(`USDT transfer submitted: ${usdtTxHash}`);
    console.error("Waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: usdtTxHash,
      timeout: 60_000,
    });
    if (receipt.status !== "success") {
      throw new Error("USDT transfer transaction reverted");
    }
    console.error("USDT transfer confirmed.");
    setStatus("confirmed", { txHash: usdtTxHash, amount, token: "USDT" });
  });

  // 查询最终余额
  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { usdt: "unknown", bnb: "unknown" };
  }

  console.log(JSON.stringify({
    success: true,
    sessionKey: {
      address: sessionAddress,
      usdt: finalBalance.usdt,
      bnb: finalBalance.bnb,
    },
    transaction: usdtTxHash,
  }, null, 2));
  process.exit(0);
}
