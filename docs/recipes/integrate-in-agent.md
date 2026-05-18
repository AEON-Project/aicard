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
