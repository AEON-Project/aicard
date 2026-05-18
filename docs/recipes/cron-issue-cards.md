# Recipe — Schedule Recurring Card Issuance

Use this when an agent needs to issue cards on a schedule — for example, "create a $5 card every Monday at 09:00 to seed an autonomous shopping flow."

## Prerequisites

1. **Pre-funded session wallet.** WalletConnect requires a browser; cron jobs run headless. Top up the local wallet manually first:
   ```bash
   aicard topup --amount 50    # adds USDT + a tiny amount of BNB for approve gas
   ```
2. **One-time `approve`.** Run `aicard create --amount 0.6 --poll` once interactively so the approve transaction is on-chain. Subsequent creates won't need WalletConnect again until USDT is depleted.

## A Minimal Wrapper Script

`~/bin/issue-card.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

AMOUNT="${1:-5}"
LOG_DIR="${HOME}/.aicard/logs"
mkdir -p "$LOG_DIR"
TS=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
LOG="$LOG_DIR/issue-${TS}.log"

# Capture envelope on stdout; quiet stderr noise
ENVELOPE=$(aicard --quiet create --amount "$AMOUNT" --poll 2>"$LOG")
EXIT=$?

echo "$ENVELOPE" > "${LOG%.log}.json"

if [ "$EXIT" -ne 0 ]; then
  CODE=$(echo "$ENVELOPE" | jq -r '.error.code // "UNKNOWN"')
  echo "[$(date -u)] FAILED code=$CODE exit=$EXIT — see $LOG" >&2
  # Surface failure via your alerting channel (Slack, email, etc.) here
  exit "$EXIT"
fi

ORDER=$(echo "$ENVELOPE" | jq -r '.data.orderNo')
echo "[$(date -u)] OK orderNo=$ORDER amount=$AMOUNT"
```

```bash
chmod +x ~/bin/issue-card.sh
```

## Cron Entry

```cron
# minute hour dom mon dow  command
  0      9    *   *   1   /Users/me/bin/issue-card.sh 5 >> /Users/me/.aicard/logs/cron.log 2>&1
```

> ⚠️ On macOS, `cron` may lack PATH access to `aicard`. Use an absolute path (`/Users/me/.nvm/versions/node/v25/bin/aicard`) or source your shell rc inside the wrapper.

## Failure Modes to Watch

| Code | Likely cause in cron context | Fix |
| ---- | ---------------------------- | --- |
| `INSUFFICIENT_USDT` | Wallet ran dry. | Top up via `aicard topup` on a workstation. |
| `INSUFFICIENT_BNB` | Approve allowance expired or BNB depleted by retries. | Run `aicard gas` to add a small amount. |
| `PAYMENT_TIMEOUT` | WalletConnect was triggered (unexpected — should be fully approved). | Run an interactive `aicard create` once to refresh allowance. |
| `SERVICE_UNAVAILABLE` | Upstream outage. | Cron will retry next tick. Alert if 3+ consecutive failures. |

## See Also

- [integrate-in-agent.md](./integrate-in-agent.md) — Node.js / Python subprocess wrapper.
- [error-recovery.md](./error-recovery.md) — Full code-by-code recovery table.
