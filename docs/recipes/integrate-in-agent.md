# Recipe — Integrate `aicard` Inside Your Agent

This recipe shows how to invoke `aicard` from inside an agent product (Node.js, Python, or anything that can spawn a subprocess) and parse the JSON envelope reliably.

## Prerequisites

- `@aeon-ai-pay/aicard` installed (globally for system-wide use, or as a dependency in your project).
- A working session wallet — run `aicard setup --check` once on the host.

> ⚠️ The CLI uses **WalletConnect for funding**, which opens a browser window with a QR code. If your agent runs headless or in containers without a display, fund the session wallet ahead of time (`aicard topup`) on a workstation, then ship the `~/.aicard/config.json` to the runtime host. Agents should never embed user main-wallet private keys.

## Node.js — Spawn & Parse Envelope

```js
import { spawn } from "node:child_process";

function runAicard(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aicard", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("close", (code) => {
      let envelope;
      try {
        envelope = JSON.parse(stdout.trim().split("\n").pop());
      } catch {
        return reject(new Error(`Could not parse envelope. stderr: ${stderr}`));
      }
      resolve({ exitCode: code, envelope, stderr });
    });
  });
}

// Example: create a $5 card and poll until terminal
const { envelope, exitCode } = await runAicard([
  "--quiet",
  "create",
  "--amount", "5",
  "--app-id", "MY_AGENT_001",
  "--poll",
]);

if (envelope.ok) {
  const { orderNo, data } = envelope.data;
  console.log("Card ready:", data.model?.cardNumber, "order:", orderNo);
} else {
  // See docs/recipes/error-recovery.md for code-by-code guidance
  console.error(`Failed [${envelope.error.code}] (exit ${exitCode}):`, envelope.error.message);
}
```

### Why `--quiet`?

`--quiet` silences progress logs on stderr. The stdout envelope is one line of JSON either way — but suppressing stderr makes child-process orchestration cleaner.

### Why `.split("\n").pop()`?

The envelope is **always the last line on stdout**. Tools that wrap the binary (npx, npm, asdf, fnm) may inject preamble lines; taking the last line is robust.

## Python — Spawn & Parse Envelope

```python
import json, subprocess

def run_aicard(args):
    result = subprocess.run(
        ["aicard", "--quiet", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    envelope = json.loads(result.stdout.strip().splitlines()[-1])
    return result.returncode, envelope

exit_code, env = run_aicard(["create", "--amount", "5", "--poll"])
if env["ok"]:
    print("Card ready:", env["data"]["data"]["model"]["cardNumber"])
else:
    print(f"Failed [{env['error']['code']}] exit={exit_code}: {env['error']['message']}")
```

## Probing Without Cost — `--dry-run`

To validate inputs, balances, and allowance **without** signing or transacting, use `--dry-run` on `create`:

```bash
aicard --quiet create --amount 5 --dry-run | jq '.data.will, .data.decision'
```

This is ideal for integration tests, configuration smoke checks, and "is everything ready?" probes.

## Orchestrating a Full Purchase (`shop` commands)

The `shop` subcommands are designed to be chained programmatically — each envelope's `data` carries exactly what the next step needs:

```js
// 1. Search → pick a product
let { envelope } = await runAicard(["--quiet", "shop", "search",
  "--query", "wireless earbuds under $50", "--country", "US", "--max-price", "50"]);
const product = envelope.data.products[0];

// 2. Cart → total + checkout URL
({ envelope } = await runAicard(["--quiet", "shop", "cart",
  "--shop", product.merchantDomain, "--variant", product.variantId, "--qty", "1",
  "--country", "US", "--region", "CA", "--zip", "94107"]));
const { total, continueUrl, testBackend, acceptsCard } = envelope.data;
if (testBackend || acceptsCard === false) throw new Error(envelope.data.warning);

// 3. Dry-run first: fill everything but do NOT submit (no order, no charge)
({ envelope } = await runAicard(["--quiet", "shop", "pay",
  "--continue-url", continueUrl, "--amount", total, "--fill-only",
  "--email", "user@real-email.com", "--first", "Jane", "--last", "Doe",
  "--address1", "1 Main St", "--city", "San Francisco", "--zip", "94107",
  "--country", "United States", "--phone", "+14155550100"]));
if (envelope.data.outcome !== "filled_no_submit") {
  // merchant-side constraint (card_not_supported / shipping_not_ready / bot_blocked ...)
  throw new Error(envelope.data.suggestion || envelope.data.outcome);
}

// 4. Real payment — same command without --fill-only, after explicit user confirmation
```

Rules that keep this safe:

- **Always dry-run (`--fill-only`) before the first real payment** on a new merchant — it validates address + card fill without charging.
- **`--amount` must equal `data.total` from `shop cart`** — the card is one-time-use; an underfunded card cannot pay.
- **Never auto-retry `shop pay`** — see [error-recovery.md](./error-recovery.md#hard-rule--never-auto-retry-shop-pay).
- **Real submission needs explicit user confirmation first** — it charges real money.

### Live progress for long runs

`shop pay` takes minutes (merchant shipping-rate calculation dominates). Instead of blocking on a black box, stream progress:

```js
// Start pay in the background with a progress file
const payPromise = runAicard(["--quiet", "shop", "pay", "--progress-file", "/tmp/p.jsonl", /* ... */]);

// Poll structured step events (JSONL) while it runs
const timer = setInterval(async () => {
  const { envelope } = await runAicard(["--quiet", "shop", "steps", "--progress-file", "/tmp/p.jsonl"]);
  if (envelope.ok) {
    for (const s of envelope.data.steps) console.log(`${s.status === "done" ? "✓" : "…"} ${s.label}${s.note ? ` — ${s.note}` : ""}`);
    if (envelope.data.terminal) clearInterval(timer);
  } // NO_EVENTS_YET before the run starts writing — just poll again
}, 3000);

const { envelope: payEnvelope } = await payPromise;
```

Card-entry steps come back `masked: true` with no screenshot path — card PII never appears in any envelope, log, or screenshot reference.

## Exit Code Strategy

Treat exit codes as a fast filter, then branch on `error.code` for nuance:

```js
switch (exitCode) {
  case 0: /* success */ break;
  case 1: /* user / config — surface to caller for correction */ break;
  case 2: /* timeout — safe to retry; card may still be provisioning */ break;
  case 3: /* network / service — exponential backoff retry */ break;
  case 4: /* internal — log + fail loud */ break;
}
```

See [exit-codes.md](../exit-codes.md) for the full mapping.
