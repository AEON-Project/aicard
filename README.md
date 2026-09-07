# aicard

An agent skill for creating instant, one-time-use virtual Visa/Mastercard cards your agent can **pay with online** — top up with crypto, then spend at real merchants.

**Shop & pay across the Shopify merchant network** — search a product, build a cart, and check out end-to-end, with real orders shipped to your address. The card also works anywhere Visa/Mastercard is accepted online.

## Install Skill

```bash
# Install to all detected agents (Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, etc.)
npx skills add AEON-Project/aicard -g -y

# Install to specific agents
npx skills add AEON-Project/aicard -a claude-code -a cursor -a codex -g -y
```

Supported agents: Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, GitHub Copilot, Windsurf, Roo Code, and [39+ more](https://agentskills.io).

> ℹ️ If you see `Failed to install 1: PromptScript` during install, that's a limitation of the **PromptScript platform not supporting global skill installs** — it's safely skipped and does **not** affect Claude Code / Cursor / Codex and other mainstream tools. To install only specific tools, use the `-a` form shown above.

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
| `shop <subcommand>` | Shopify shopping: search → cart → pay → track (see [Shop & Pay](#shop--pay-on-shopify)) | — |
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

## Shop & Pay on Shopify

`aicard shop` turns the card into an end-to-end shopping agent: search real Shopify merchants, build a cart, then issue a one-time card and auto-fill the checkout with Playwright — a real order, shipped to your address.

| Subcommand | Description | Key Options |
|------------|-------------|-------------|
| `shop search` | Semantic product search (global catalog, or one store with `--shop`) | `--query`, `--country`, `--max-price`, `--sort`, `--limit`, `--shop` |
| `shop product` | Full product details (specs, colors, sizes) | `--id` (productId from search), `--shop` |
| `shop cart` | Build a cart → totals + checkout URL | `--shop`, `--variant`, `--qty`, `--country`, `--region`, `--zip` |
| `shop confirm` | Render a "Confirm Details" card to review shipping info before paying | `--first/--last/--email/--address1/...`, `--image` |
| `shop pay` | Issue a card + auto-fill checkout + submit | `--continue-url`, `--amount`, `--email`, shipping fields, `--fill-only`, `--headful`, `--assist`, `--progress-file` |
| `shop track` | Track order status | `--order`, `--shop`, `--bearer` |
| `shop cards` | List locally cached cards (masked, last-4 only) | — |
| `shop steps` | Render live per-step progress from `shop pay --progress-file` | `--progress-file`, `--html` |

### The 4-step flow

```bash
# 1. Find products (global semantic search, or --shop for a single store)
aicard shop search --query "wireless earbuds under $50" --country US --max-price 50

# 2. Product details (specs / colors / sizes; use productId from search)
aicard shop product --id <productId> --shop <domain>

# 3. Build a cart → get total + checkout URL
aicard shop cart --shop <domain> --variant <variantGid> --qty 1 \
  --country US --region CA --zip 94107

# 4. Issue card + auto-fill checkout + submit
aicard shop pay \
  --continue-url "<checkout URL from step 3>" \
  --amount <cart total from step 3> \
  --email you@real-email.com --first Jane --last Doe \
  --address1 "..." --city ... --zip ... --country "United States" --phone ...
```

Step 4 internally: issue card (USDT charge, auto-funds via WalletConnect if short) → open checkout with Playwright → fill shipping address → wait for merchant shipping rates → fill card → submit → screenshot receipt.

### Practical notes

- **Dry-run first**: add `--fill-only` to fill everything but *not* submit — no order, no charge. Strongly recommended on a first try to confirm the address and card fill cleanly.
- **Live progress**: `--progress-file /tmp/p.jsonl` streams structured per-step events (JSONL) as they happen; tail it (or run `shop steps --progress-file ...`) instead of waiting minutes for a black-box result.
- **3DS / captcha**: `--headful` opens a visible browser so you can pass verification manually; `--assist` is the failure fallback — it opens a pre-filled window for you to finish and submit yourself.
- **Amount must match**: `--amount` must equal the cart total (tax + shipping included). Cards are one-time-use — an underfunded card can't pay.
- **Use a real email**: order confirmation and shipping updates go there.
- **Card PII is never exposed**: output shows last-4 only; checkout screenshots of the card step are masked in any rendered timeline/HTML.

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

The [shop commands](#shop--pay-on-shopify) chain the same way — each envelope's `data` carries exactly what the next step needs:

```js
// search → cart → pay: data.products[i] feeds cart; data.total + data.continueUrl feed pay
const search = await runAicard(["--quiet", "shop", "search", "--query", "wireless earbuds under $50"]);
const p = search.data.products[0];
const cart = await runAicard(["--quiet", "shop", "cart", "--shop", p.merchantDomain,
  "--variant", p.variantId, "--country", "US", "--region", "CA", "--zip", "94107"]);
const pay = await runAicard(["--quiet", "shop", "pay", "--continue-url", cart.data.continueUrl,
  "--amount", cart.data.total, "--fill-only", /* shipping fields... */]);
// --fill-only = dry-run (no charge). Drop it for real payment — after explicit user confirmation.
// Never auto-retry `shop pay`: check data.outcome / data.suggestion instead (double-charge risk).
```

See [docs/recipes/integrate-in-agent.md](docs/recipes/integrate-in-agent.md) for the full orchestration — including live progress streaming via `--progress-file` + `shop steps`, and the outcome/error-recovery tables.

Detailed references:

- [docs/output-schema.md](docs/output-schema.md) — full envelope schema per command, incl. all `shop.*` payloads and `shop pay` outcome semantics
- [docs/exit-codes.md](docs/exit-codes.md) — exit code categories + `error.code` reference (card + shop)
- [docs/recipes/integrate-in-agent.md](docs/recipes/integrate-in-agent.md) — Node.js & Python wrappers + full shopping orchestration
- [docs/recipes/error-recovery.md](docs/recipes/error-recovery.md) — code-by-code recovery strategy
- [docs/recipes/cron-issue-cards.md](docs/recipes/cron-issue-cards.md) — scheduled card issuance

## License

MIT
