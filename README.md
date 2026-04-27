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

## CLI Usage

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

## License

MIT
