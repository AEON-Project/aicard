# Create Virtual Card

## Prerequisites

Before creating a card, confirm the following:

1. Wallet is configured — run `setup --check`. If not ready, the CLI will auto-create one.
2. Service URL is configured (built-in default is available; no action needed unless user wants to override)
3. The `create` command automatically checks allowance and wallet balance before payment. If insufficient, it auto-initiates WalletConnect funding — no need to run `wallet` or `topup` separately.

## Workflow

### Step 1: Confirm Amount

Ask the user how much to load onto the virtual card.

- Amount limits are enforced by the CLI (`amountLimits.min` ~ `amountLimits.max`, from `setup --check`).
- Currency: USD (server handles crypto conversion)

**If user does not specify an amount**, show the valid range and ask for confirmation (**copy must be verbatim**, variable substitution only):
> "You can create a card of up to ${min}~${max}. How much would you like to load onto the card？"

Once the user specifies an amount, **execute immediately** — no second confirmation needed.

### Step 2: Execute

```bash
# Create card and auto-poll status
npx @aeon-ai-pay/x402-card create --amount <amount> --poll
```

CLI automatically handles the full flow:
1. Send `GET /open/ai/x402/card/create?amount=X` → receive HTTP 402 + payment requirements (exact USDT amount)
2. Check allowance → if insufficient and no BNB, mark BNB needed
3. Check USDT balance → if insufficient, mark top-up needed
4. If top-up or BNB needed → auto-initiate WalletConnect funding (opens QR page, waits for user to confirm in wallet app)
5. After funding completes, auto-continue
6. Approve authorization (only on first use or when allowance insufficient, costs small amount of BNB)
7. Sign with the exact amount from the first 402 response using EIP-712
8. Retry request with `PAYMENT-SIGNATURE` header → receive HTTP 200
9. With `--poll`, polls up to 42 times (first 5 at 2-second intervals, then every 5 seconds) until card is ready

### Step 3: Parse Result

**stdout** outputs JSON (parseable), **stderr** outputs progress logs.

Successful output:
```json
{
  "success": true,
  "data": {
    "code": "0",
    "msg": "success",
    "model": { "orderNo": "300217748668047431791" }
  },
  "paymentResponse": {
    "txHash": "0x...",
    "networkId": "eip155:56"
  }
}
```

With `--poll`, additional output after card is ready:
```json
{
  "pollResult": {
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

### Step 4: Present to User

Fetching card details may take about 30 seconds. Output a waiting prompt first (**copy must be verbatim**):
```
> Fetching card details, please wait...
```

Once details are returned, on success (**copy must be verbatim**, variable substitution only):
```
Order No: {orderNo}
Card: {cardScheme} •••• {last4}
State: Active
Remaining balance: ${amount} USD
Usage: 0 / 1 (single-use)
```

Save the `orderNo` for subsequent status queries.

## Error Handling

| Scenario | CLI Output | Action |
|------|---------|---------|
| Amount out of range | Error JSON with allowed range | Relay to user |
| Wallet not configured | `Wallet not configured` | Run `setup --check` |
| Funding signature timeout (5 min) | `Payment approval timed out. Please try again.` | Relay to user, ask if they want to retry |
| User rejected signature | `Payment approval was rejected. Please try again if you'd like to proceed.` | Relay to user, do not auto-retry |
| Insufficient balance after funding | `Still insufficient USDT after funding` | Relay to user |
| Network error | Server error JSON | Retry once, then report to user |
| Transaction reverted | txHash | Suggest user check on BSCScan |
