#!/usr/bin/env node

const [major] = process.versions.node.split(".").map(Number);
if (major < 25) {
  console.error(`aicard requires Node.js >= 25. Current: v${process.versions.node}`);
  console.error("Upgrade: https://nodejs.org/");
  process.exit(1);
}

// WalletConnect v2 SDK 已知缺陷：relay 偶发 null WebSocket 帧导致
// isJsonRpcPayload 内部 'id' in null 抛 TypeError，不影响业务流程，静默忽略
process.on("uncaughtException", (err) => {
  if (
    err instanceof TypeError &&
    err.message.includes("Cannot use 'in' operator") &&
    err.stack?.includes("isJsonRpcPayload")
  ) {
    console.error("[WC guard] Caught null-frame TypeError via uncaughtException, ignored.");
    return;
  }
  console.error(err);
  process.exit(1);
});

import { Command } from "commander";
import { checkForUpdates } from "../src/update-check.mjs";
import { setLegacyMode, setVerboseMode, setQuietMode } from "../src/output.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
checkForUpdates(CURRENT_VERSION);

const program = new Command();

program
  .name("aicard")
  .description("Purchase virtual debit cards via x402 protocol")
  .version(CURRENT_VERSION)
  .option("--legacy-output", "Emit legacy JSON shape instead of the new envelope", false)
  .option("--verbose", "Verbose stderr logs", false)
  .option("--quiet", "Suppress non-error stderr logs", false)
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    setLegacyMode(opts.legacyOutput);
    setVerboseMode(opts.verbose);
    setQuietMode(opts.quiet);
  });

program
  .command("setup")
  .description("Pre-check: auto-create local wallet on first run, or show config")
  .option("--service-url <url>", "Override service URL")
  .option("--show", "Show current configuration", false)
  .option("--check", "Check & auto-create wallet if missing (exit 0=ready, 1=not ready)", false)
  .action(async (opts) => {
    const { setup } = await import("../src/commands/setup.mjs");
    return setup(opts);
  });

program
  .command("create")
  .description("Create a virtual card by paying with USDT on BSC")
  .requiredOption("--amount <usd>", "Card amount in USD ($0.6 ~ $800)")
  .option("--app-id <id>", "Merchant app ID", "TEST000001")
  .option("--service-url <url>", "Override service URL")
  .option("--private-key <key>", "Override EVM private key")
  .option("--poll", "Auto-poll status after creation", false)
  .option("--dry-run", "Run all preflight checks but do not sign/transact", false)
  .action(async (opts) => {
    const { create } = await import("../src/commands/create.mjs");
    return create(opts);
  });

program
  .command("status")
  .description("Check virtual card creation status")
  .requiredOption("--order-no <orderNo>", "Order number from create command")
  .option("--service-url <url>", "Override service URL")
  .option("--poll", "Poll until terminal status", false)
  .action(async (opts) => {
    const { status } = await import("../src/commands/status.mjs");
    return status(opts);
  });

program
  .command("wallet")
  .description("Check local wallet USDT balance on BSC")
  .option("--private-key <key>", "Override EVM private key")
  .action(async (opts) => {
    const { wallet } = await import("../src/commands/wallet.mjs");
    return wallet(opts);
  });

program
  .command("topup")
  .description("Top up local wallet via WalletConnect (USDT + BNB for approve gas)")
  .option("--amount <usdt>", "USDT amount to add", "50")
  .option("--skip-gas", "Skip automatic BNB transfer", false)
  .option("--project-id <id>", "WalletConnect Cloud project ID")
  .action(async (opts) => {
    const { topup } = await import("../src/commands/topup.mjs");
    return topup(opts);
  });

program
  .command("gas")
  .description("Send BNB from main wallet to local wallet via WalletConnect (for withdraw gas)")
  .option("--amount <bnb>", "BNB amount to send", "0.001")
  .option("--project-id <id>", "WalletConnect Cloud project ID")
  .action(async (opts) => {
    const { gas } = await import("../src/commands/gas.mjs");
    return gas(opts);
  });

program
  .command("withdraw")
  .description("Withdraw USDT from session key back to main wallet")
  .option("--amount <usdt>", "USDT amount to withdraw (default: all)")
  .option("--to <address>", "Override destination address")
  .action(async (opts) => {
    const { withdraw } = await import("../src/commands/withdraw.mjs");
    return withdraw(opts);
  });

program
  .command("clean")
  .description("Remove skill, uninstall package, and clear npm/npx cache")
  .action(async () => {
    const { clean } = await import("../src/commands/clean.mjs");
    return clean();
  });

// ---------- Shopify 购物闭环：search → cart → pay → track ----------
const shop = program
  .command("shop")
  .description("Shopify shopping: search → cart → pay → track");

shop
  .command("search")
  .description("Semantic product search (Global, or a single store with --shop)")
  .requiredOption("--query <text>", 'Natural-language query, e.g. "wireless earbuds under $50"')
  .option("--shop <domain>", "Limit to a single merchant (Storefront Catalog)")
  .option("--country <iso>", "Ship-to country ISO-2, e.g. US / GB")
  .option("--max-price <usd>", "Max price in USD")
  .option("--sort <by>", "排序：price(最便宜优先) | relevance(默认相关性)", "relevance")
  .option("--limit <n>", "Result count (1-50)", "30")
  .option("--cursor <c>", "Pagination cursor")
  .option("--include-test", "包含疑似测试/开发店（默认排除 *.myshopify.com 与 test/demo 命名）", false)
  .option("--html <path>", "Also render an image product-card HTML page (self-contained) to this path")
  .action(async (opts) => {
    const { search } = await import("../src/commands/shop.mjs");
    return search(opts);
  });

shop
  .command("product")
  .description("Get full product details (specs, colors, sizes) for a search result")
  .requiredOption("--id <gid>", "Product id (productId from search)")
  .option("--shop <domain>", "Merchant domain (Storefront); omit for Global Catalog")
  .action(async (opts) => {
    const { product } = await import("../src/commands/shop.mjs");
    return product(opts);
  });

shop
  .command("cart")
  .description("Build a cart and get totals + checkout URL")
  .requiredOption("--shop <domain>", "Merchant domain (from search result)")
  .requiredOption("--variant <gid>", "ProductVariant gid (from search result)")
  .option("--qty <n>", "Quantity", "1")
  .option("--country <iso>", "Ship-to country ISO-2")
  .option("--region <code>", "Ship-to region/state")
  .option("--zip <code>", "Postal code")
  .action(async (opts) => {
    const { cart } = await import("../src/commands/shop.mjs");
    return cart(opts);
  });

shop
  .command("pay")
  .description("Issue a card and auto-fill the checkout to complete payment")
  .option("--continue-url <url>", "Checkout URL from `shop cart` (required)")
  .option("--amount <usd>", "Card amount = cart total (required)")
  .option("--email <email>", "Buyer's REAL email — 收订单/物流 (required)")
  .option("--first <name>", "First name (required)")
  .option("--last <name>", "Last name (required)")
  .option("--address1 <street>", "Address line 1 (required)")
  .option("--city <city>", "City (required)")
  .option("--zip <code>", "Postal / ZIP code (required)")
  .option("--country <name>", "Country name, e.g. United Kingdom (required)")
  .option("--phone <phone>", "Phone number (required by most checkouts)")
  .option("--address2 <street>", "Address line 2 (optional)")
  .option("--region <name>", "Region/State (optional; 无州国家可省)")
  .option("--app-id <id>", "Merchant app ID for card issuance", "TEST000001")
  .option("--service-url <url>", "Override card service URL")
  .option("--private-key <key>", "Override EVM private key")
  .option("--headful", "Show the browser (needed for manual 3DS/OTP)", false)
  .option("--assist", "兜底：脚本失败时弹可见窗口，填好已知信息后让用户手动完成并提交", false)
  .option("--fill-only", "Fill card but do NOT submit (test only, no charge)", false)
  .option("--allow-test", "允许在测试店后端下单（默认拦截 twinoakstest 等测试店）", false)
  .option("--wait-otp <ms>", "On 3DS/captcha, wait for OTP relay file up to N ms")
  .option("--otp-file <path>", "OTP relay file path (default ./otp.txt)")
  .option("--out <dir>", "Screenshot output dir (default ./artifacts)")
  .action(async (opts) => {
    const { pay } = await import("../src/commands/shop.mjs");
    return pay(opts);
  });

shop
  .command("track")
  .description("Track order status (requires Token-tier credential)")
  .requiredOption("--order <id>", "Order id")
  .option("--bearer <jwt>", "Global API JWT (or env UCP_ORDER_TOKEN)")
  .option("--shop <domain>", "Merchant domain")
  .action(async (opts) => {
    const { track } = await import("../src/commands/shop.mjs");
    return track(opts);
  });

shop
  .command("cards")
  .description("List locally cached virtual cards (masked last-4 only)")
  .action(async () => {
    const { cards } = await import("../src/commands/shop.mjs");
    return cards();
  });

program.parse();
