/**
 * withdraw 命令：将 session key 中的资金转回主钱包（USDT + BNB）
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { loadConfig } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import { BSC_RPC_URL, USDT_BSC, ERC20_TRANSFER_ABI } from "../constants.mjs";

const BNB_TRANSFER_GAS = 21000n;

export async function withdraw(opts) {
  console.error("Reclaiming funds...");
  const config = loadConfig();

  if (!config.privateKey || !config.address) {
    console.error(JSON.stringify({ error: "No session key found. Nothing to withdraw." }));
    process.exit(1);
  }

  const mainWallet = opts.to || config.mainWallet;
  if (!mainWallet) {
    console.error(JSON.stringify({ error: "No main wallet address found. Use --to <address> to specify." }));
    process.exit(1);
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
  console.error(`Session key: ${sessionAddress}`);
  console.error(`Balance: ${balance.usdt} USDT, ${balance.bnb} BNB`);
  console.error(`Withdraw to: ${mainWallet}`);

  const isWithdrawAll = !opts.amount;

  // 无任何资金
  if (balance.usdtRaw === 0n && balance.bnbRaw === 0n) {
    console.error(JSON.stringify({ error: "No funds to withdraw." }));
    process.exit(1);
  }

  let usdtTxHash = null;
  let bnbTxHash = null;

  // 1. 赎回 USDT（有 USDT 才执行）
  if (balance.usdtRaw > 0n) {
    // USDT 转账需要 BNB 作 gas
    if (balance.bnbRaw === 0n) {
      console.error(JSON.stringify({
        error: "No BNB for gas. Withdraw is a normal on-chain transfer and requires BNB to pay gas.",
        address: sessionAddress,
        hint: "Run 'aicard gas' to top up BNB via WalletConnect, then retry.",
      }));
      process.exit(1);
    }

    let withdrawAmount = balance.usdtRaw;
    if (opts.amount) {
      const requested = parseUnits(opts.amount, 18);
      if (requested > balance.usdtRaw) {
        console.error(JSON.stringify({
          error: `Requested ${opts.amount} USDT but only ${balance.usdt} available.`,
        }));
        process.exit(1);
      }
      withdrawAmount = requested;
    }

    try {
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [mainWallet, withdrawAmount],
      });

      console.error(`\nTransferring ${formatUnits(withdrawAmount, 18)} USDT → ${mainWallet}...`);
      usdtTxHash = await walletClient.sendTransaction({ to: USDT_BSC, data });
      console.error(`USDT tx: ${usdtTxHash}`);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: usdtTxHash,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error("USDT transfer reverted");
      }
      console.error("USDT reclaimed.");
    } catch (error) {
      console.error(JSON.stringify({ error: `USDT withdraw failed: ${error.message}` }));
      process.exit(1);
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
          console.error(`Transferring ${formatUnits(sendable, 18)} BNB → ${mainWallet}...`);
          bnbTxHash = await walletClient.sendTransaction({
            to: mainWallet,
            value: sendable,
            gas: BNB_TRANSFER_GAS,
            gasPrice,
          });
          console.error(`BNB tx: ${bnbTxHash}`);

          const receipt = await publicClient.waitForTransactionReceipt({
            hash: bnbTxHash,
            timeout: 60_000,
          });
          if (receipt.status !== "success") {
            throw new Error("BNB transfer reverted");
          }
          console.error("BNB reclaimed.");
        } else {
          console.error("BNB balance too small to cover transfer gas, skipping.");
        }
      } catch (error) {
        console.error(`Warning: BNB reclaim failed (${error.message}).`);
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

  console.log(JSON.stringify({
    success: true,
    to: mainWallet,
    transactions: {
      usdt: usdtTxHash,
      bnb: bnbTxHash,
    },
    remaining: {
      usdt: finalBalance.usdt,
      bnb: finalBalance.bnb,
    },
  }, null, 2));
  process.exit(0);
}
