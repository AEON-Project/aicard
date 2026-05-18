# aicard — Virtual Card Agent Rules

When a user asks to **create, query, or manage** a one-time virtual debit card funded with USDT on BSC, use the `aicard` CLI as the source of truth.

## Setup (run once per environment)

```bash
aicard setup --check
```

Returns an envelope on stdout; `envelope.data.ready === true` means ready.

## Command Surface

```bash
aicard create --amount <USD> [--app-id <merchantId>] --poll  # Create card
aicard status --order-no <orderNo> [--poll]                  # Query status
aicard wallet                                                # Local balance
aicard topup --amount <USDT>                                 # USDT top-up via WalletConnect
aicard gas --amount <BNB>                                    # BNB top-up via WalletConnect
aicard withdraw [--to 0x...] [--amount <USDT>]               # Reclaim funds
```

`--app-id` defaults to `TEST000001`. `--quiet` suppresses stderr noise. `--legacy-output` swaps the envelope for the old pre-envelope JSON shape.

## Output Contract

Every command emits **one line of JSON** to stdout (the envelope):

- `{ "ok": true, "command": "...", "data": { ... } }`
- `{ "ok": false, "command": "...", "error": { "code": "...", "message": "...", ... } }`

Stderr is human-readable progress. Match on `error.code` (stable), not on `error.message`.

Exit codes: `0` success · `1` user · `2` timeout · `3` service/network · `4` internal.

## Hard Rules

- **Never** prompt for private keys. The CLI auto-generates a local session wallet.
- **Never** display full card numbers, CVV, or expiry. The CLI already redacts these to `•••• 1234`.
- **Never** run `create` (when balance is low) / `topup` / `gas` in the background — they open a WalletConnect QR window.
- **Never** auto-retry `PAYMENT_REJECTED` or `PAYMENT_TIMEOUT`. Ask the user.

## Error Recovery (high-frequency cases)

| `error.code` | Action |
| ------------ | ------ |
| `AMOUNT_OUT_OF_RANGE` | Show `error.min` / `error.max`; re-prompt user. |
| `INSUFFICIENT_USDT` | Run `aicard topup`, then re-run create. |
| `INSUFFICIENT_BNB` | Run `aicard gas`, then re-run the failing op. |
| `POLL_TIMEOUT` | Card may still be provisioning. Note `error.orderNo`. |
| `PAYMENT_REJECTED` | User cancelled. Ask before retrying. |
| `PAYMENT_TIMEOUT` | 5-minute approval window expired. Ask before retrying. |
| `SERVICE_UNAVAILABLE` | Retry with exponential backoff (1s → 4s → 16s, max 3). |

Full schema and recipes: see `docs/output-schema.md`, `docs/exit-codes.md`, and `docs/recipes/`.
