# Exit Codes

The `aicard` CLI returns a stable exit code that maps to the category of outcome. Combine this with the `error.code` field in the JSON envelope (see [output-schema.md](./output-schema.md)) for precise programmatic handling.

| Exit | Category | Meaning |
| ---: | -------- | ------- |
| `0` | Success | Command completed and produced an `ok: true` envelope. |
| `1` | User error | Validation, configuration, balance, or user-side rejection. Caller should fix input and retry. |
| `2` | Timeout | Polling, WalletConnect, signature, or on-chain wait exceeded its limit. The underlying operation may still complete asynchronously (e.g. card may still be provisioning). |
| `3` | Service / network | Upstream service unavailable, network error, on-chain revert. Generally retryable after backoff. |
| `4` | Internal | Unexpected internal error in the CLI. Please file an issue if reproducible. |

## Error Code Reference

The full set of `error.code` values, grouped by exit code, is defined in [`src/error-codes.mjs`](../src/error-codes.mjs).

### Exit 1 — User Error

| Code | When |
| ---- | ---- |
| `WALLET_NOT_CONFIGURED` | No local wallet. Run `aicard setup --check`. |
| `SERVICE_URL_MISSING` | Service URL not configured. |
| `AMOUNT_INVALID` | Amount could not be parsed. |
| `AMOUNT_OUT_OF_RANGE` | Amount outside `amountLimits.min` ~ `amountLimits.max`. |
| `AMOUNT_EXCEEDS_BALANCE` | `withdraw --amount` exceeds available USDT. |
| `INSUFFICIENT_USDT` | USDT balance still insufficient after funding. |
| `INSUFFICIENT_BNB` | No BNB for approve / withdraw gas. |
| `NO_FUNDS` | Session wallet has zero USDT and zero BNB. |
| `NO_MAIN_WALLET` | `withdraw` invoked without `--to` and no `mainWallet` in config. |
| `INVALID_USAGE` | CLI invoked with no actionable flags. |
| `PAYMENT_REJECTED` | User rejected the transaction in their wallet. |

### Exit 2 — Timeout

| Code | When |
| ---- | ---- |
| `PAYMENT_TIMEOUT` | WalletConnect / signature request timed out (5 minutes). |
| `WC_SESSION_EXPIRED` | WalletConnect session dropped mid-flow. |
| `POLL_TIMEOUT` | `status --poll` exhausted attempts. Card may still be provisioning. |
| `TX_TIMEOUT` | On-chain receipt wait exceeded 60 s. |

### Exit 3 — Service / Network

| Code | When |
| ---- | ---- |
| `SERVICE_UNAVAILABLE` | Generic upstream / network failure. |
| `PAYMENT_FETCH_FAILED` | First 402 request to the service failed. |
| `BALANCE_CHECK_FAILED` | RPC query to BSC failed. |
| `TX_REVERTED` | On-chain transaction reverted. |
| `WITHDRAW_FAILED` | Withdraw transaction failed (revert / RPC). |
| `INVALID_PAYMENT_AMOUNT` | Service returned a 402 with `amount === 0`. |
| `PAYMENT_FAILED` | Service rejected the signed payment request. |

### Exit 4 — Internal

| Code | When |
| ---- | ---- |
| `INTERNAL_ERROR` | Unexpected error inside the CLI. |
| `WALLET_ERROR` | Generic non-classified WalletConnect failure. (Exit 1 — treated as user-resolvable.) |
