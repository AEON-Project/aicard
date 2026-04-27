import { loadConfig, saveConfig, getConfigPath } from "../config.mjs";
import { MIN_AMOUNT, MAX_AMOUNT } from "../constants.mjs";

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
    const result = {
      ready,
      created,
      mode: config.mode || null,
      address: config.address || null,
      mainWallet: config.mainWallet || null,
      serviceUrl: config.serviceUrl || null,
      amountLimits: { min: MIN_AMOUNT, max: MAX_AMOUNT },
    };
    console.log(JSON.stringify(result));
    process.exit(ready ? 0 : 1);
  }

  if (opts.show) {
    // 显示当前配置（私钥脱敏）
    const display = { ...config };
    if (display.privateKey) {
      display.privateKey = `${display.privateKey.slice(0, 6)}...${display.privateKey.slice(-4)}`;
    }
    display._configPath = getConfigPath();
    console.log(JSON.stringify(display, null, 2));
    return;
  }

  if (!changed) {
    console.error("Usage:");
    console.error("  aicard setup --check                  (auto-create local wallet if missing)");
    console.error("  aicard setup --show                   (show current config)");
    console.error("  aicard setup --service-url <url>      (override service URL)");
    console.error(`\nConfig file: ${getConfigPath()}`);
    process.exit(1);
  }

  saveConfig(config);
  console.log(JSON.stringify({
    success: true,
    configPath: getConfigPath(),
    serviceUrl: config.serviceUrl || null,
    address: config.address || null,
  }, null, 2));
}
