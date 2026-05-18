import { loadConfig, saveConfig, getConfigPath } from "../config.mjs";
import { MIN_AMOUNT, MAX_AMOUNT } from "../constants.mjs";
import { emitOk, emitErr } from "../output.mjs";

export async function setup(opts) {
  const config = loadConfig();
  let changed = false;

  // 设置 service URL
  if (opts.serviceUrl) {
    // 去除尾部斜杠
    config.serviceUrl = opts.serviceUrl.replace(/\/+$/, "");
    changed = true;
  }

  // --check: Agent 用来快速判断是否就绪。
  // 若本地不存在私钥，自动生成一对全新私钥并保存（不走 WalletConnect）。
  if (opts.check) {
    let created = false;

    if (!config.privateKey) {
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      const newKey = generatePrivateKey();
      const account = privateKeyToAccount(newKey);
      config.privateKey = newKey;
      config.address = account.address;
      config.mode = "private-key";
      created = true;
    }

    // 无论是否新建了私钥，只要有变更就保存（如 --service-url 同时传入）
    if (created || changed) {
      saveConfig(config);
    }

    const ready = !!(config.serviceUrl && config.privateKey);
    const data = {
      ready,
      created,
      mode: config.mode || null,
      address: config.address || null,
      mainWallet: config.mainWallet || null,
      serviceUrl: config.serviceUrl || null,
      amountLimits: { min: MIN_AMOUNT, max: MAX_AMOUNT },
    };
    emitOk("setup.check", data, data);
    return;
  }

  if (opts.show) {
    // 显示当前配置（私钥脱敏）
    const display = { ...config };
    if (display.privateKey) {
      display.privateKey = `${display.privateKey.slice(0, 6)}...${display.privateKey.slice(-4)}`;
    }
    display._configPath = getConfigPath();
    emitOk("setup.show", display, display);
    return;
  }

  if (!changed) {
    emitErr("setup", "INVALID_USAGE", {
      message: "Usage: aicard setup --check | --show | --service-url <url>",
      configPath: getConfigPath(),
    });
    return;
  }

  saveConfig(config);
  const data = {
    success: true,
    configPath: getConfigPath(),
    serviceUrl: config.serviceUrl || null,
    address: config.address || null,
  };
  emitOk("setup", data, data);
}
