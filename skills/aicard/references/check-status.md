# Check Card Status

## Command

```bash
# Single query
npx @aeon-ai-pay/aicard status --order-no <orderNo>

# Poll until terminal status (SUCCESS or FAIL)
npx @aeon-ai-pay/aicard status --order-no <orderNo> --poll
```

## Response Format

```json
{
  "code": "0",
  "msg": "success",
  "model": {
    "orderNo": "300217748668047431791",
    "orderStatus": "SUCCESS",
    "channelStatus": "COMPLETED",
    "orderAmount": 0.6,
    "txHash": "0xabc...def",
    "cardLastFour": "4321",
    "cardBin": "485932",
    "cardScheme": "VISA",
    "cardBalance": 0.6,
    "cardStatus": "ACTIVE"
  }
}
```

## Status Values

### orderStatus (Order Status)

| Status | Meaning | Action |
|------|------|------|
| `INIT` | Order created, not yet paid | Wait |
| `PENDING` | Payment submitted, awaiting on-chain confirmation | Continue polling |
| `SUCCESS` | Card created successfully | Show card details |
| `FAIL` | Failed | Show error, suggest retry |

### channelStatus (Channel Status)

| Status | Meaning |
|------|------|
| `INIT` | Not yet sent to card provider |
| `PROCESSING` | Provider is creating the card |
| `COMPLETED` | Card is ready |
| `FAILED` | Card creation failed |

### cardStatus (Card Status)

| Status | Meaning |
|------|------|
| `PENDING` | Being provisioned |
| `ACTIVE` | Ready to use |
| `FROZEN` | Frozen |
| `CANCELLED` | Cancelled |

## Polling Behavior

With `--poll`:
- Up to **42 attempts** (first 5 at **2-second** intervals, then every **5 seconds**)
- Stops on `SUCCESS`, `FAIL`, or `cardStatus=ACTIVE`
- If timed out, notify user and provide manual query command
