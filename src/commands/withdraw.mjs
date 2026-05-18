/**
 * withdraw 命令：将 session key 中的资金转回主钱包（USDT + BNB）
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { loadConfig } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import { BSC_RPC_URL, USDT_BSC, ERC20_TRANSFER_ABI } from "../constants.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

const BNB_TRANSFER_GAS = 21000n;

export async function withdraw(opts) {
  logInfo("Reclaiming funds...");
  const config = loadConfig();

  if (!config.privateKey || !config.address) {
    emitErr("withdraw", "WALLET_NOT_CONFIGURED", {
      message: "No session key found. Nothing to withdraw.",
    });
    return;
  }

  const mainWallet = opts.to || config.mainWallet;
  if (!mainWallet) {
    emitErr("withdraw", "NO_MAIN_WALLET", {
      message: "No main wallet address found. Use --to <address> to specify.",
    });
    return;
  }

  const sessionAddress = config.address;
  const account = privateKeyToAccount(config.privateKey);

  const publicClient = createPublicClient({
    chain: bsc,
    transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
  });

  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(BSC_RPC_URL),
  });

  const balance = await getBalanceByAddress(sessionAddress);
  logInfo(`Session key: ${sessionAddress}`);
  logInfo(`Balance: ${balance.usdt} USDT, ${balance.bnb} BNB`);
  logInfo(`Withdraw to: ${mainWallet}`);

  const isWithdrawAll = !opts.amount;

  // 无任何资金
  if (balance.usdtRaw === 0n && balance.bnbRaw === 0n) {
    emitErr("withdraw", "NO_FUNDS", { message: "No funds to withdraw." });
    return;
  }

  let usdtTxHash = null;
  let bnbTxHash = null;

  // 1. 赎回 USDT（有 USDT 才执行）
  if (balance.usdtRaw > 0n) {
    // USDT 转账需要 BNB 作 gas
    if (balance.bnbRaw === 0n) {
      emitErr("withdraw", "INSUFFICIENT_BNB", {
        message: "No BNB for gas. Withdraw is a normal on-chain transfer and requires BNB to pay gas.",
        address: sessionAddress,
        hint: "Run 'aicard gas' to top up BNB via WalletConnect, then retry.",
      });
      return;
    }

    let withdrawAmount = balance.usdtRaw;
    if (opts.amount) {
      const requested = parseUnits(opts.amount, 18);
      if (requested > balance.usdtRaw) {
        emitErr("withdraw", "AMOUNT_EXCEEDS_BALANCE", {
          message: `Requested ${opts.amount} USDT but only ${balance.usdt} available.`,
          requested: opts.amount,
          available: balance.usdt,
        });
        return;
      }
      withdrawAmount = requested;
    }

    try {
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [mainWallet, withdrawAmount],
      });

      logInfo(`\nTransferring ${formatUnits(withdrawAmount, 18)} USDT → ${mainWallet}...`);
      usdtTxHash = await walletClient.sendTransaction({ to: USDT_BSC, data });
      logInfo(`USDT tx: ${usdtTxHash}`);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: usdtTxHash,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error("USDT transfer reverted");
      }
      logInfo("USDT reclaimed.");
    } catch (error) {
      emitErr("withdraw", "WITHDRAW_FAILED", {
        message: `USDT withdraw failed: ${error.message}`,
      });
      return;
    }
  }

  // 2. 赎回剩余 BNB（仅赎回全部时）
  if (isWithdrawAll) {
    const freshBalance = balance.usdtRaw > 0n
      ? await getBalanceByAddress(sessionAddress)
      : balance;

    if (freshBalance.bnbRaw > 0n) {
      try {
        const gasPrice = await publicClient.getGasPrice();
        // 预留 20% buffer 应对 gas price 波动
        const gasCost = BNB_TRANSFER_GAS * (gasPrice * 120n / 100n);
        const sendable = freshBalance.bnbRaw - gasCost;

        if (sendable > 0n) {
          logInfo(`Transferring ${formatUnits(sendable, 18)} BNB → ${mainWallet}...`);
          bnbTxHash = await walletClient.sendTransaction({
            to: mainWallet,
            value: sendable,
            gas: BNB_TRANSFER_GAS,
            gasPrice,
          });
          logInfo(`BNB tx: ${bnbTxHash}`);

          const receipt = await publicClient.waitForTransactionReceipt({
            hash: bnbTxHash,
            timeout: 60_000,
          });
          if (receipt.status !== "success") {
            throw new Error("BNB transfer reverted");
          }
          logInfo("BNB reclaimed.");
        } else {
          logInfo("BNB balance too small to cover transfer gas, skipping.");
        }
      } catch (error) {
        logInfo(`Warning: BNB reclaim failed (${error.message}).`);
      }
    }
  }

  // 查询最终余额
  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { usdt: "unknown", bnb: "unknown" };
  }

  const data = {
    to: mainWallet,
    transactions: {
      usdt: usdtTxHash,
      bnb: bnbTxHash,
    },
    remaining: {
      usdt: finalBalance.usdt,
      bnb: finalBalance.bnb,
    },
  };
  emitOk("withdraw", data, { success: true, ...data });
}
