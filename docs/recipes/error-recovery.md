# Recipe — Error Recovery Strategy

Map each `error.code` returned by the envelope to a concrete recovery action. Use this table when wiring `aicard` into an agent prompt or a control-flow layer.

| `error.code` | Exit | Recommended Recovery |
| ------------ | :--: | -------------------- |
| `WALLET_NOT_CONFIGURED` | 1 | Run `aicard setup --check` once (auto-creates a local session wallet). |
| `SERVICE_URL_MISSING` | 1 | Set via `--service-url <url>`, or env `AGENT_PAY_SERVICE_URL`, or `aicard setup --service-url <url>`. |
| `AMOUNT_INVALID` | 1 | Caller bug — input must be a numeric string. |
| `AMOUNT_OUT_OF_RANGE` | 1 | Re-prompt user with `error.min` ~ `error.max`. Do **not** silently clamp. |
| `AMOUNT_EXCEEDS_BALANCE` | 1 | Use the smaller of requested vs. `error.available`. |
| `INSUFFICIENT_USDT` | 1 | Top-up failed or partial. Surface `error.required` / `error.available` to user, ask whether to retry with a new amount. |
| `INSUFFICIENT_BNB` | 1 | Run `aicard gas` to top up a small amount of BNB via WalletConnect, then retry. |
| `NO_FUNDS` | 1 | Nothing to withdraw. Inform the user, possibly suggest `topup`. |
| `NO_MAIN_WALLET` | 1 | Caller must pass `--to <address>`. |
| `PAYMENT_REJECTED` | 1 | User cancelled in their wallet. **Do not auto-retry** — ask user first. |
| `PAYMENT_TIMEOUT` | 2 | WalletConnect approval expired (5 min). Ask user whether to retry. **Do not auto-retry.** |
| `WC_SESSION_EXPIRED` | 2 | Reconnect required. Re-run the original command. |
| `POLL_TIMEOUT` | 2 | Card may still provision. Surface `error.orderNo` and query later with `aicard status --order-no <n>`. |
| `TX_TIMEOUT` | 2 | The on-chain transfer is likely still pending — query the chain or retry the status command. |
| `SERVICE_UNAVAILABLE` | 3 | Exponential backoff: 1 s → 4 s → 16 s, max 3 attempts. |
| `PAYMENT_FETCH_FAILED` | 3 | Same as above. Check network connectivity. |
| `BALANCE_CHECK_FAILED` | 3 | BSC RPC hiccup. Retry once after 2 s. |
| `TX_REVERTED` | 3 | On-chain failure. Capture `error.message` for diagnosis; do not retry blindly. |
| `WITHDRAW_FAILED` | 3 | Withdraw transaction failed. Check `aicard wallet` and retry. |
| `INVALID_PAYMENT_AMOUNT` | 3 | Server-side issue (returned amount = 0). Retry after a short delay. |
| `PAYMENT_FAILED` | 3 | Service rejected the signed request. Surface `error.data` to the user / log. |
| `INTERNAL_ERROR` | 4 | File a bug. Don't retry. |
| `WALLET_ERROR` | 1 | Generic wallet failure. Surface to user, ask whether to retry. |

## Generic Retry Helper (Node.js)

```js
async function withRetry(fn, { codes, attempts = 3, baseDelayMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { exitCode, envelope } = await fn();
    if (envelope.ok) return envelope;
    if (!codes.includes(envelope.error.code)) return envelope; // non-retryable
    if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * 4 ** i));
  }
}

// Only retry transient service/network errors
await withRetry(() => runAicard(["create", "--amount", "5", "--poll"]), {
  codes: ["SERVICE_UNAVAILABLE", "PAYMENT_FETCH_FAILED", "BALANCE_CHECK_FAILED", "INVALID_PAYMENT_AMOUNT"],
});
```

## Anti-patterns

- ❌ Don't retry `PAYMENT_REJECTED` or `PAYMENT_TIMEOUT` automatically — the user actively cancelled or walked away.
- ❌ Don't match on `error.message` text — messages may change between versions. Match on `error.code`.
- ❌ Don't ignore exit code in favour of envelope. Stack-level proxies sometimes mangle stdout; the exit code is a redundant safety net.
