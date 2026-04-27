# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@aeon-ai-pay/aicard` — CLI & agent skill for purchasing one-time-use virtual debit cards (Visa/Mastercard) via the x402 HTTP payment protocol, paying with USDT (BEP-20) on BSC.

Published as both a global npm CLI (`aicard`) and an agent skill compatible with Claude Code, Cursor, Codex, and 39+ platforms.

## Commands

```bash
# Run CLI commands directly
node bin/cli.mjs setup          # Generate local wallet, show config
node bin/cli.mjs create         # Create virtual card via x402 payment
node bin/cli.mjs status         # Poll card creation status
node bin/cli.mjs wallet         # Check USDT/BNB balance
node bin/cli.mjs topup          # Transfer USDT via WalletConnect
node bin/cli.mjs gas            # Transfer BNB for tx fees
node bin/cli.mjs withdraw       # Reclaim funds from session key
node bin/cli.mjs clean          # Uninstall skill & clear cache

# Or via npm scripts
npm run create
npm run status
npm run wallet

# Release
node scripts/release.mjs
```

No build step — all source is native ES Modules (`.mjs`), executed directly by Node.js >=18. No test suite exists.

## Architecture

### Entry Points
- `bin/cli.mjs` — Commander.js CLI definition, lazy-loads command modules
- `skills/aicard/SKILL.md` — Agent skill specification (triggers, opening protocol, workflow)
- `scripts/postinstall.mjs` — Auto-installs skill into detected AI coding agents on `npm install`

### Core Modules (`src/`)
- `x402.mjs` — x402 protocol client: wraps axios with EIP-712 signing, captures `orderNo` from 402 responses
- `walletconnect.mjs` — WalletConnect v2 integration: QR code UI (custom HTML page), local status server, ERC20 transfers (USDT + BNB)
- `balance.mjs` — EVM balance/allowance queries via Viem public client on BSC
- `config.mjs` — Config persistence at `~/.aicard/config.json` (mode 0o600). Priority: CLI args > env vars > config file
- `sanitize.mjs` — Hides card PII (full number, CVV, expiry) from agent output
- `constants.mjs` — BSC addresses, RPC URL, amount limits, polling config
- `update-check.mjs` — Background auto-update detection via `npm view`

### Command Modules (`src/commands/`)
Each command module exports a single async function. Pattern: parse options → load/validate config → call shared utilities → output JSON or error.

### Key Architectural Concepts

**Session Key Model**: A randomly generated private key stored locally acts as a "session key." The user's main wallet (MetaMask, etc.) funds this key via WalletConnect. The session key then signs x402 payments (gasless EIP-712) for card creation.

**x402 Payment Flow**: `GET /create → HTTP 402 + requirements → client EIP-712 sign → server submits on-chain USDT transfer (server pays gas) → poll /status for card`

**Gas Model**: One-time `approve` tx requires BNB (~0.0003). Card creation itself is gasless (server-paid). Withdrawal requires BNB for direct on-chain transfer.

## Key Dependencies
- `viem` — EVM client (balance queries, contract reads)
- `@walletconnect/sign-client` — Wallet connection protocol
- `@aeon-ai-pay/axios` / `@aeon-ai-pay/evm` — Custom x402 protocol wrappers
- `commander` — CLI framework
