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
  .option("--sort <by>", "Sort: price (cheapest first) | relevance (default)", "relevance")
  .option("--limit <n>", "Result count (1-50)", "30")
  .option("--cursor <c>", "Pagination cursor")
  .option("--include-test", "Include suspected test/dev stores (by default excludes *.myshopify.com and test/demo names)", false)
  .option("--html <path>", "Also render an image product-card HTML page (self-contained) to this path")
  .option("--image <path>", "Also render the product-card grid to a PNG (via Playwright) — display it inline for auto-visible image+text with zero clicks (no artifact panel needed)")
  .action(async (opts) => {
    const { search } = await import("../src/commands/shop.mjs");
    return search(opts);
  });

shop
  .command("product")
  .description("Get full product details (specs, colors, sizes) for a search result")
  .requiredOption("--id <gid>", "Product id (productId from search)")
  .option("--shop <domain>", "Merchant domain (Storefront); omit for Global Catalog")
  .option("--html <path>", "Also render a self-contained product-detail HTML page (image + specs) to this path")
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
  .option("--email <email>", "Buyer's REAL email — receives order/shipping updates (required)")
  .option("--first <name>", "First name (required)")
  .option("--last <name>", "Last name (required)")
  .option("--address1 <street>", "Address line 1 (required)")
  .option("--city <city>", "City (required)")
  .option("--zip <code>", "Postal / ZIP code (required)")
  .option("--country <name>", "Country name, e.g. United Kingdom (required)")
  .option("--phone <phone>", "Phone number (required by most checkouts)")
  .option("--address2 <street>", "Address line 2 (optional)")
  .option("--region <name>", "Region/State (optional; may be omitted for countries without states)")
  .option("--app-id <id>", "Merchant app ID for card issuance", "TEST000001")
  .option("--service-url <url>", "Override card service URL")
  .option("--private-key <key>", "Override EVM private key")
  .option("--headful", "Show the browser (needed for manual 3DS/OTP)", false)
  .option("--assist", "Fallback: on script failure, open a visible window pre-filled with known info so the user can complete and submit manually", false)
  .option("--fill-only", "Fill card but do NOT submit (test only, no charge)", false)
  .option("--allow-test", "Allow placing orders on test-store backends (by default blocks test stores such as twinoakstest)", false)
  .option("--wait-otp <ms>", "On 3DS/captcha, wait for OTP relay file up to N ms")
  .option("--otp-file <path>", "OTP relay file path (default /tmp/aicard-otp.txt)")
  .option("--out <dir>", "Screenshot output dir (default ./artifacts)")
  .option("--html <path>", "Also render a self-contained order-flow timeline HTML page to this path (card-entry step masked, never embeds card PII)")
  .option("--progress-file <path>", "Stream structured per-step events (JSONL) to this file as each step completes — tail it to show live progress (card step is masked, no card PII)")
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

shop
  .command("steps")
  .description("Render the live per-step progress (from `shop pay --progress-file`) as an image+text view; call repeatedly to refresh the Artifact")
  .requiredOption("--progress-file <path>", "The JSONL event file written by `shop pay --progress-file`")
  .option("--html <path>", "Render the image+text step view to this path (republish as an Artifact)")
  .option("--title <text>", "Title for the view")
  .action(async (opts) => {
    const { steps } = await import("../src/commands/shop.mjs");
    return steps(opts);
  });

// 用 parseAsync 拿到 action 的 promise，命令跑完后强制退出。
// 背景：WalletConnect 会开着 relay WebSocket + heartbeat 定时器等后台 handle，
// 事件循环无法自然清空，成功路径若只靠 emitOk 自然返回，进程会挂到超时才被杀。
// emitErr 自身已 process.exit（保留各命令退出码），故这里只兜成功路径（exit 0）。
// 结果已在 action 内经 console.log 同步写出，此时退出不会截断 stdout。
program.parseAsync().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
