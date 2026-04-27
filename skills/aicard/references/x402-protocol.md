# x402 Protocol

A native HTTP payment protocol that monetizes APIs via blockchain.

## How It Works

The x402 protocol extends HTTP with a two-phase payment flow using HTTP status code `402 Payment Required`:

```
Phase 1: Discovery
  Client  ──GET /resource──>  Server
  Client  <──HTTP 402──      Server (returns payment requirements)

Phase 2: Payment
  Client  ──GET /resource──>  Server
           + PAYMENT-SIGNATURE header (signed payment payload)
  Client  <──HTTP 200──      Server (returns resource + PAYMENT-RESPONSE header)
```

## Payment Requirements (402 Response)

When the server returns 402, the response body contains an `accepts` array:

```json
{
  "accepts": [
    {
      "scheme": "exact",
      "namespace": "evm",
      "networkId": "eip155:56",
      "asset": "USDT",
      "tokenAddress": "0x55d398326f99059fF775485246999027B3197955",
      "tokenDecimals": 18,
      "amountRequired": "5000000000000000000",
      "payToAddress": "0xRecipient...",
      "resource": "https://api.example.com/callback"
    }
  ],
  "x402Version": 2
}
```

## Payment Signature Header

The client signs an EIP-712 typed data structure and sends it as a Base64-encoded header:

| Protocol Version | Header Name |
|---------|--------|
| v2 (current) | `PAYMENT-SIGNATURE` |
| v1 (legacy) | `X-PAYMENT` |

The signature payload contains:
- `from`: payer wallet address
- `to`: payee address
- `value`: exact payment amount (unique per order, used for matching)
- `validAfter` / `validBefore`: payment validity time window
- `nonce`: random value to prevent replay attacks

## Payment Response Header

On success, the server returns a `PAYMENT-RESPONSE` header (Base64-encoded):

```json
{
  "txHash": "0xabc...def",
  "networkId": "eip155:56"
}
```

## Core Concepts

### Unique Amount Matching
The server generates a slightly adjusted unique amount for each order (e.g., $5.000001 instead of $5.00). This allows the server to match a specific order via Redis cache lookup using only the on-chain payment amount, without needing an order ID in the payment header.

### Facilitator
An intermediary service responsible for:
1. Validating the signed payment
2. Submitting the transaction on-chain
3. Confirming settlement
4. Returning the transaction hash

### Supported Networks

| Network | Chain ID | Token |
|------|----------|------|
| BSC Mainnet | eip155:56 | USDT (BEP-20) |

## Client Libraries

- `@x402/axios` — Axios interceptor that automatically handles 402 responses
- `@x402/fetch` — Fetch API wrapper
- `@x402/evm` — EVM signing utilities (EIP-712)
