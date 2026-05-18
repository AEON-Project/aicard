import { resolve, loadConfig } from "../config.mjs";
import { getWalletBalance, getBalanceByAddress } from "../balance.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function wallet(opts) {
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");

  if (!privateKey) {
    emitErr("wallet", "WALLET_NOT_CONFIGURED");
    return;
  }

  try {
    const config = loadConfig();
    const { address, usdt, usdtRaw } = await getWalletBalance(privateKey);

    const result = {
      mode: config.mode || "private-key",
      address,
      usdt,
      network: "BSC Mainnet (Chain ID: 56)",
    };

    // 若曾经 topup 过，附带主钱包余额
    if (config.mainWallet) {
      try {
        const mainBal = await getBalanceByAddress(config.mainWallet);
        result.mainWallet = {
          address: config.mainWallet,
          usdt: mainBal.usdt,
        };
      } catch {
        result.mainWallet = { address: config.mainWallet, error: "Failed to query balance" };
      }
    }

    emitOk("wallet", result, result);

    if (usdtRaw === 0n) {
      logInfo("Warning: No USDT balance. Run 'aicard topup --amount <usdt>' to add funds.");
    }
  } catch (error) {
    emitErr("wallet", "BALANCE_CHECK_FAILED", { message: error.message });
  }
}
