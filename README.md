# aicard

An Agent skill for purchasing virtual debit cards via the [x402 protocol](https://www.x402.org/).

Pay with cryptocurrency (USDT on BSC) to get instant-use virtual Visa/Mastercard.

## Install Skill

```bash
# Install to all detected agents (Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, etc.)
npx skills add AEON-Project/aicard -g -y

# Install to specific agents
npx skills add AEON-Project/aicard -a claude-code -a cursor -a codex -g -y
```

Supported agents: Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, GitHub Copilot, Windsurf, Roo Code, and [39+ more](https://agentskills.io).

## CLI Commands

| Command | Description | Key Options |
|---------|-------------|-------------|
| `setup` | Pre-check: auto-create local wallet on first run, or show config | `--service-url`, `--show`, `--check` |
| `create` | Create a virtual card by paying with USDT on BSC | `--amount` (required, $0.6 ~ $800), `--app-id` (default `TEST000001`), `--service-url`, `--private-key`, `--poll` |
| `status` | Check virtual card creation status | `--order-no` (required), `--service-url`, `--poll` |
| `wallet` | Check local wallet USDT balance on BSC | `--private-key` |
| `topup` | Top up local wallet via WalletConnect (USDT + BNB for approve gas) | `--amount` (default `50`), `--skip-gas`, `--project-id` |
| `gas` | Send BNB from main wallet to local wallet via WalletConnect (for withdraw gas) | `--amount` (default `0.001`), `--project-id` |
| `withdraw` | Withdraw USDT from session key back to main wallet | `--amount` (default: all), `--to` |
| `clean` | Remove skill, uninstall package, and clear npm/npx cache | — |

### Examples

```bash
# First run: auto-create local wallet (private key generated locally, never uploaded)
npx @aeon-ai-pay/aicard setup --check

# Create a virtual card ($5 USD, auto-poll status)
# Auto-funds via WalletConnect when balance is insufficient
npx @aeon-ai-pay/aicard create --amount 5 --poll

# Check card status
npx @aeon-ai-pay/aicard status --order-no <orderNo>

# Check wallet balance (BNB + USDT)
npx @aeon-ai-pay/aicard wallet

# Manually top up USDT to local wallet
npx @aeon-ai-pay/aicard topup --amount 50

# Top up BNB gas for local wallet
npx @aeon-ai-pay/aicard gas --amount 0.001

# Withdraw remaining funds (USDT + BNB) back to main wallet
npx @aeon-ai-pay/aicard withdraw

# Show current configuration
npx @aeon-ai-pay/aicard setup --show

# Uninstall skill and clear cache
npx @aeon-ai-pay/aicard clean
```

## Prerequisites

- Node.js >= 18
- A mobile wallet app with WalletConnect support (MetaMask, OKX Wallet, Trust Wallet, etc.)
- USDT (BEP-20) on BSC for card purchases
- A small amount of BNB for approve gas (~$0.002/tx, only needed on first authorization)

## How It Works

```
1. CLI auto-generates a session key (disposable wallet) locally
2. When creating a card, if balance is insufficient, auto-funds via WalletConnect QR scan (USDT + BNB gas)
3. First use requires a one-time approve authorization (unlimited allowance, no repeat needed)
4. Session key auto-signs x402 payments — no manual confirmation required

Agent flow:
  User intent -> Agent activates skill -> x402 two-phase protocol:
    1. GET /create?amount=X         -> HTTP 402 + payment requirements
    2. Session key EIP-712 signature -> Server submits on-chain transfer
    3. Poll /status?orderNo=X       -> Card details ready
```

## Configuration

Config is stored in `~/.aicard/config.json` (file permissions 600).

Run `setup --check` to auto-generate a local wallet. The main wallet private key is **never** stored locally — only the session key (a locally generated disposable wallet) is saved. Funding is done via WalletConnect QR scan.

Override the default service URL (optional):
```bash
npx @aeon-ai-pay/aicard setup --service-url https://custom-api.example.com
```

## Developer Integration

Building an agent product on top of `aicard`? Two integration paths:

### Path A — Let the agent invoke the CLI directly

For IDE-hosted agents (Claude Code, Cursor, Codex, Windsurf, …), install the skill (see [Install Skill](#install-skill)). The agent will invoke `aicard` via the shell when the user intent matches.

### Path B — Spawn `aicard` from your own code

For Node.js / Python / Go agent products that orchestrate the CLI as a subprocess:

```js
import { spawn } from "node:child_process";

const child = spawn("aicard", ["--quiet", "create", "--amount", "5", "--poll"]);
let stdout = "";
child.stdout.on("data", (b) => { stdout += b; });
child.on("close", (code) => {
  const envelope = JSON.parse(stdout.trim().split("\n").pop());
  if (envelope.ok) {
    console.log("Card:", envelope.data);
  } else {
    console.error(`[${envelope.error.code}] ${envelope.error.message}`);
  }
});
```

- **Stdout** is always one line of JSON — the *envelope* (`{ ok, command, version, data }` or `{ ok, command, version, error }`).
- **Stderr** is human-readable progress; pass `--quiet` to suppress.
- **Exit code** is stable: `0` success, `1` user error, `2` timeout, `3` service/network, `4` internal.
- **`--dry-run`** on `create` performs all preflight checks (402 fetch, balance, allowance) but skips signing/transacting — perfect for integration tests and smoke checks.
- **`--legacy-output`** restores the pre-envelope JSON shape for legacy scripts during migration.

Detailed references:

- [docs/output-schema.md](docs/output-schema.md) — full envelope schema per command
- [docs/exit-codes.md](docs/exit-codes.md) — exit code categories + `error.code` reference
- [docs/recipes/integrate-in-agent.md](docs/recipes/integrate-in-agent.md) — Node.js & Python wrappers
- [docs/recipes/error-recovery.md](docs/recipes/error-recovery.md) — code-by-code recovery strategy
- [docs/recipes/cron-issue-cards.md](docs/recipes/cron-issue-cards.md) — scheduled card issuance

## License

MIT
