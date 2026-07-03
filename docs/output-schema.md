# Output Schema

Every `aicard` command emits **exactly one line of JSON** to **stdout** —— the *envelope*. Human-readable progress logs go to **stderr** and can be safely ignored by programmatic consumers.

> Pass `--quiet` to suppress non-error stderr. Pass `--legacy-output` to fall back to the pre-envelope shape (see [Legacy mode](#legacy-mode)).

## Envelope

### Success

```json
{
  "ok": true,
  "command": "create",
  "version": "0.9.8",
  "data": { /* command-specific payload */ }
}
```

### Failure

```json
{
  "ok": false,
  "command": "create",
  "version": "0.9.8",
  "error": {
    "code": "AMOUNT_OUT_OF_RANGE",
    "message": "Amount must be at least $0.6. Allowed range: $0.6 ~ $800 USD.",
    "min": 0.6,
    "max": 800
  }
}
```

- `error.code` is a stable identifier from [`src/error-codes.mjs`](../src/error-codes.mjs) — see [exit-codes.md](./exit-codes.md) for the full list.
- `error.message` is human-readable and may change between versions; **do not** match on it for control flow.
- Additional fields under `error` are command-specific context (e.g. `min` / `max` / `address` / `required` / `available`).

## Per-Command `data` Payloads

### `setup --check`

```json
{
  "ready": true,
  "created": false,
  "mode": "private-key",
  "address": "0x...",
  "mainWallet": "0x..." | null,
  "serviceUrl": "https://...",
  "amountLimits": { "min": 0.6, "max": 800 }
}
```

### `create`

```json
{
  "orderNo": "...",
  "data": { /* sanitized server response */ },
  "paymentResponse": { /* decoded PAYMENT-RESPONSE header */ },
  "pollResult": { /* present when --poll succeeds */ }
}
```

**Dry-run (`--dry-run`)** — preflight checks complete but no signing/transaction occurs:

```json
{
  "dryRun": true,
  "url": "...",
  "paymentRequirements": { "amountUsdt": 0.66, "amountWei": "660000000000000000", "asset": "0x...", "payTo": "0x...", "orderNo": "..." },
  "wallet": { "address": "0x..." },
  "decision": { "needTopup": true, "needGas": false, "topupAmount": "0.660000" },
  "will": ["fund_usdt_via_walletconnect", "approve_or_skip", "sign_payment_eip712", "submit_to_facilitator", "poll_status"]
}
```

### `status`

```json
{
  "success": true,
  "model": {
    "orderNo": "...",
    "orderStatus": "SUCCESS" | "FAIL" | "PROCESSING" | "...",
    "channelStatus": "...",
    "cardStatus": "ACTIVE" | "PENDING" | "...",
    "cardScheme": "VISA" | "MASTERCARD",
    "cardNumber": "•••• 1234",
    "...": "(sensitive fields like CVV / expiry are stripped)"
  }
}
```

### `wallet`

```json
{
  "mode": "private-key",
  "address": "0x...",
  "usdt": "12.34",
  "network": "BSC Mainnet (Chain ID: 56)",
  "mainWallet": { "address": "0x...", "usdt": "..." }
}
```

### `topup` / `gas`

```json
{
  "sessionKey": { "address": "0x...", "usdt": "...", "bnb": "..." },
  "transaction": "0x..."
}
```

### `withdraw`

```json
{
  "to": "0x...",
  "transactions": { "usdt": "0x..." | null, "bnb": "0x..." | null },
  "remaining": { "usdt": "0.0", "bnb": "0.0" }
}
```

### `clean`

```json
{
  "removed": ["skills", "npm-global", "npm-cache", "npx-cache"]
}
```

## Logging Flags

| Flag | Effect |
| ---- | ------ |
| `--verbose` | Enable verbose stderr logs. |
| `--quiet` | Suppress non-error stderr logs. The stdout envelope is unaffected. |
| `--legacy-output` | See below. |

## Legacy Mode

For consumers still parsing the pre-envelope JSON shape, pass `--legacy-output` to get the old format on stdout (and errors on **stderr** as before):

```bash
aicard --legacy-output create --amount 5
```

Legacy mode is kept for one or two minor releases as a migration aid. New integrations should use the envelope.
