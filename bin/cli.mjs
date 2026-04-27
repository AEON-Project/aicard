#!/usr/bin/env node

import { Command } from "commander";
import { checkForUpdates } from "../src/update-check.mjs";
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
  .version(CURRENT_VERSION);

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
  .option("--service-url <url>", "Override service URL")
  .option("--private-key <key>", "Override EVM private key")
  .option("--poll", "Auto-poll status after creation", false)
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

program.parse();
