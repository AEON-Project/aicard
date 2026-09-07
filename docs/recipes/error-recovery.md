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

## Shop (`aicard shop *`) Codes

| `error.code` | Exit | Recommended Recovery |
| ------------ | :--: | -------------------- |
| `TEST_STORE_BLOCKED` | 1 | A confirmation gate (`error.needsConfirm: true`), not a failure. Tell the user the backend is a test store; rerun with `--allow-test` only after they agree. |
| `VARIANT_NOT_FOUND` | 1 | Follow `error.hint`: re-resolve the variant via `shop search --shop <domain>`, then rebuild the cart. Don't reuse Global-catalog variants on a storefront. |
| `MISSING_SHIPPING_FIELDS` | 1 | `error.missing` lists every missing field at once — collect them all, then retry once. |
| `INVALID_EMAIL` / `INVALID_COUNTRY` | 1 | Fix the flagged field (`error.field`) and retry. |
| `NEEDS_APPROVE_GAS` | 1 | Run `aicard gas`, then retry `shop pay`. |
| `ORDER_AUTH_REQUIRED` | 1 | `shop track` needs `--bearer` / `UCP_ORDER_TOKEN`. For browser-path orders, use the confirmation email + `receipt.proofImage` instead. |
| `NO_EVENTS_YET` | 1 | The `shop pay` run hasn't written events yet. Poll `shop steps` again after 2–5 s. |
| `SHOP_SEARCH_FAILED` / `SHOP_CART_FAILED` | 3 | Retryable. Honour `error.retryAfter` (seconds) if present; otherwise exponential backoff. |
| `CARD_ISSUE_FAILED` | 3 | If `error.required` / `error.available` present, it's a balance shortfall — top up the difference and retry. Otherwise treat as service error. |
| `PLAYWRIGHT_MISSING` / `BROWSER_INSTALL_FAILED` | 3 | One-time environment fix: `npm i -g playwright && npx playwright install chromium`, then retry. |
| `SHOP_PAY_FAILED` | 3 | **Never auto-retry.** See the hard rule below. |

### Hard rule — never auto-retry `shop pay`

`shop pay` clicks a real Pay button with a real one-time card. Auto-retrying risks **double-charging**:

1. On any non-success envelope, read `data.outcome` and `data.suggestion` — the CLI already classifies whether funds could have moved.
2. If `data.signals.paySubmitted` is `true` (outcome `pending` / `error`), the charge state is unknown — verify via the confirmation email / `~/.aicard/receipts` proof image / merchant order page **before** anything else.
3. `challenge_3ds` means not-authorized-yet = not charged. Recover with one background rerun using `--wait-otp` and relay the code via the OTP file — not by blind repetition.
4. Outcomes like `card_not_supported`, `shipping_not_ready`, `checkout_unavailable`, `bot_blocked` are merchant-side constraints — retrying the same command cannot fix them; change merchant/inputs instead.

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
