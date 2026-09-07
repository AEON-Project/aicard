# Output Schema

Every `aicard` command emits **exactly one line of JSON** to **stdout** —— the *envelope*. Human-readable progress logs go to **stderr** and can be safely ignored by programmatic consumers.

> Pass `--quiet` to suppress non-error stderr. Pass `--legacy-output` to fall back to the pre-envelope shape (see [Legacy mode](#legacy-mode)).

## Envelope

### Success

```json
{
  "ok": true,
  "command": "create",
  "version": "1.0.0",
  "data": { /* command-specific payload */ }
}
```

### Failure

```json
{
  "ok": false,
  "command": "create",
  "version": "1.0.0",
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

## Shop Command Payloads

All `shop` subcommands use the same envelope; `command` is namespaced (`shop.search`, `shop.cart`, …). Optional render flags (`--html` / `--image`) add `htmlPath` / `imagePath` to the payload when used.

### `shop search`

```json
{
  "scope": "global" | "storefront",
  "count": 30,
  "excludedTest": 2,
  "excludedNoCard": 1,
  "sortedBy": "relevance" | "price",
  "hasNext": true,
  "cursor": "...",
  "products": [
    { "productId": "gid://shopify/Product/...", "title": "...", "price": "...", "merchantDomain": "shop.example.com", "...": "..." }
  ]
}
```

### `shop product`

```json
{
  "title": "...",
  "description": "...",
  "priceMin": "19.99", "priceMax": "29.99", "currency": "USD",
  "merchantDomain": "shop.example.com", "merchantName": "...",
  "detailUrl": "https://...",
  "images": ["https://..."],
  "options": [ { "name": "Color", "values": [ { "value": "Black", "available": true } ] } ],
  "specText": "...",
  "variantCount": 4,
  "variants": [
    { "variantId": "gid://shopify/ProductVariant/...", "options": { "Color": "Black" }, "price": "19.99", "available": true }
  ]
}
```

### `shop cart`

```json
{
  "cartId": "...",
  "currency": "USD",
  "subtotal": "19.99", "tax": "1.80", "shipping": "5.00", "total": "26.79",
  "continueUrl": "https://.../checkouts/cn/...",
  "backendHost": "shop.example.com",
  "testBackend": false,
  "acceptsCard": true,
  "paymentMethods": ["credit_card", "paypal"],
  "lineItems": [ { "...": "..." } ],
  "expiresAt": "..."
}
```

- `continueUrl` + `total` are the two inputs `shop pay` needs.
- `testBackend: true` → the checkout backend is a test store; `shop pay` blocks it unless `--allow-test`. A `warning` field is included.
- `acceptsCard: false` → merchant takes wallets only (e.g. PayPal); the virtual card cannot pay here. A `warning` field is included.

### `shop pay`

Card PII **never** enters the envelope — only `cardLast4` / `cardScheme`.

```json
{
  "cardSource": "cache" | "issued",
  "cardOrderNo": "...",
  "cardLast4": "1234",
  "cardScheme": "VISA",
  "outcome": "success",
  "receipt": {
    "status": "confirmed",
    "merchant": "...", "orderNumber": "X0FCMYJAT",
    "orderUrl": "https://...", "orderUrlDurable": false,
    "purchasedAt": "2026-01-01T00:00:00.000Z",
    "amountCharged": "$26.79", "amountSource": "checkout_total" | "cli_amount_fallback",
    "subtotal": "...", "shippingFee": "...", "tax": "...", "total": "...", "items": [ ... ],
    "shippingMethod": "...",
    "payment": { "scheme": "VISA", "last4": "1234", "source": "cache" | "issued", "note": "..." },
    "shipTo": { "name": "...", "email": "...", "phone": "...", "address": "..." },
    "proofImage": "~/.aicard/receipts/receipt-....png",
    "reopenVia": ["..."]
  },
  "order": { "...": "thank-you page extraction" },
  "artifacts": ["./artifacts/co-01-....png", "..."],
  "signals": { "paySubmitted": true, "...": "..." },
  "suggestion": "present only on non-success — human-readable next step",
  "progressFile": "/tmp/p.jsonl"
}
```

`outcome` values (only `success` means a confirmed order):

| `outcome` | Meaning | Charged? |
| --------- | ------- | -------- |
| `success` | Order confirmed (thank-you page reached) | ✅ Yes |
| `filled_no_submit` | `--fill-only` dry-run completed | No |
| `challenge_3ds` / `challenge_captcha` | Verification challenge pending — incomplete = not authorized | No |
| `declined` | Card declined by merchant | No |
| `pending` / `error` **with** `signals.paySubmitted: true` | Pay was clicked but result unconfirmed — **may be charged; never rerun blindly** | ⚠️ Unknown |
| `card_not_supported` | Merchant takes wallets only, no card fields | No |
| `shipping_not_ready` | Shipping rates never loaded | No |
| `checkout_unavailable` | Checkout link invalid / expired | No |
| `bot_blocked` | Anti-bot (Cloudflare etc.) blocked the session | No |
| `fill_failed` / `no_card_iframe` / `address_incomplete` | Form filling did not complete | No |

> ⚠️ `shop pay` **never auto-retries**. On any non-success outcome, follow the `suggestion` field; if `signals.paySubmitted` is true, verify whether the charge went through before doing anything else.

### `shop cards`

```json
{
  "count": 3,
  "usable": 1,
  "cards": [ { "orderNo": "...", "last4": "1234", "scheme": "VISA", "amount": 26.79, "used": false, "...": "..." } ]
}
```

### `shop steps`

```json
{
  "count": 12,
  "steps": [
    { "id": "open", "label": "Open checkout", "status": "done", "note": null, "shot": "./artifacts/co-01-....png" },
    { "id": "card", "label": "Fill card", "status": "done", "masked": true }
  ],
  "terminal": false
}
```

- `masked: true` steps (card entry) never include a screenshot path — those screenshots contain card PII.
- `terminal: true` once a `receipt` step appears or any step failed — stop polling then.

### `shop confirm`

```json
{
  "fields": { "first": "...", "last": "...", "email": "...", "...": "..." }
}
```

### `shop track`

Requires a Token-tier credential (`--bearer` or env `UCP_ORDER_TOKEN`). Returns the merchant's `get_order` response (`status` / `fulfillment_status` / tracking events). Note: only orders completed via the pure-API path are visible here — browser-path orders (the current `shop pay` default) are tracked via the confirmation email and `receipt.proofImage` instead.

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
