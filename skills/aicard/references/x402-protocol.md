# x402 Protocol (v2)

A native HTTP payment protocol that monetizes APIs via blockchain. aicard only supports **x402 v2**.

## How It Works

The x402 protocol extends HTTP with a two-phase payment flow using HTTP status code `402 Payment Required`:

```
Phase 1: Discovery
  Client  ──GET /resource──>  Server
  Client  <──HTTP 402──       Server (returns payment requirements)

Phase 2: Payment
  Client  ──GET /resource──>  Server
           + PAYMENT-SIGNATURE header (Base64-encoded signed PaymentPayload)
  Client  <──HTTP 200──       Server (returns resource + PAYMENT-RESPONSE header)
```

## Payment Requirements (402 Response)

When the server returns 402, the response body follows the v2 `PaymentRequired` shape:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/resource",
    "description": "x402pay",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:56",
      "networkId": "56",
      "amount": "5000000000000001",
      "asset": "0x55d398326f99059fF775485246999027B3197955",
      "payTo": "0xRecipient...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDT",
        "version": "2",
        "network": "BSC"
      },
      "tokenSymbol": "USDT",
      "tokenDecimals": 18
    }
  ]
}
```

### Top-level fields

| Field | Type | Notes |
|-------|------|-------|
| `x402Version` | int | Always `2` |
| `resource` | object | `ResourceInfo`: `{ url, description, mimeType }` |
| `accepts` | array | List of `PaymentRequirements` the server will accept |
| `error` | string | Prompt text — `"PAYMENT-SIGNATURE header is required"` on first request |

### `accepts[]` element (`PaymentRequirements`)

| Field | Type | Notes |
|-------|------|-------|
| `scheme` | string | `"exact"` |
| `network` | string | CAIP-2 — `"eip155:56"` for BSC |
| `networkId` | string | Chain ID as string — `"56"` |
| `amount` | string | Exact atomic-unit amount **(with order-matching suffix — do not round)** |
| `asset` | string | Token contract address |
| `payTo` | string | Recipient address |
| `maxTimeoutSeconds` | int | Payment validity window in seconds |
| `extra` | object | EIP-712 domain params — `name` + `version` (token EIP-712 domain) |
| `tokenSymbol` | string | Informational, e.g. `"USDT"` |
| `tokenDecimals` | int | Informational, e.g. `18` |

## PAYMENT-SIGNATURE Header

The client signs an EIP-712 typed data structure and sends it as a Base64-encoded request header named **`PAYMENT-SIGNATURE`** (the legacy v1 `X-PAYMENT` header is no longer supported).

Decoded payload follows the v2 `PaymentPayload` shape:

```json
{
  "x402Version": 2,
  "resource": { "url": "...", "description": "x402pay", "mimeType": "application/json" },
  "accepted": { /* the chosen PaymentRequirements */ },
  "payload": {
    "authorization": {
      "from": "0xPayer...",
      "to":   "0xPayee...",
      "value": "5000000000000001",
      "validAfter":  "1700000000",
      "validBefore": "1700000900",
      "nonce": "0x..."
    },
    "signature": "0x..."
  },
  "extensions": {}
}
```

Notes:
- `authorization.value` **must equal** `accepts[i].amount` (the unique order-matching amount).
- Signature is EIP-712 over the token's `TransferWithAuthorization` domain — or a Facilitator-mediated domain when the token contract does not support ERC-3009 (e.g. BSC USDT).

## PAYMENT-RESPONSE Header

On success, the server returns a `PAYMENT-RESPONSE` response header (Base64-encoded JSON). Decoded content:

```json
{
  "success": true,
  "transaction": "0xabc...def",
  "network": "bsc",
  "payer": "0xPayer..."
}
```

## Core Concepts

### Unique Amount Matching

The server generates a slightly adjusted unique amount for each order (e.g. `5.000001 USDT` instead of `5.00`). This allows the server to match a specific order via cache lookup using the on-chain transfer amount alone — no order ID is needed inside the signed payload.

### Facilitator

An intermediary service responsible for:
1. Verifying the signed payment payload (`POST /verify`)
2. Submitting the transaction on-chain (`POST /settle`)
3. Returning the settlement transaction hash

### Supported Networks

| Network | CAIP-2 | Chain ID | Token |
|---------|--------|----------|-------|
| BSC Mainnet | `eip155:56` | `56` | USDT (BEP-20) |

## Client Libraries (aicard uses)

- `@aeon-ai-pay/axios` — Axios interceptor that automatically handles 402 responses
- `@aeon-ai-pay/evm` — EVM signing utilities (EIP-712, ERC-3009, Facilitator scheme)
