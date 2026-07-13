# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@aeon-ai-pay/aicard` — CLI & agent skill for purchasing one-time-use virtual debit cards (Visa/Mastercard) via the x402 HTTP payment protocol, paying with USDT (BEP-20) on BSC.

Published as both a global npm CLI (`aicard`) and an agent skill compatible with Claude Code, Cursor, Codex, and 39+ platforms.

## Commands

```bash
# Run CLI commands directly
node bin/cli.mjs setup          # Generate local wallet, show config
node bin/cli.mjs create         # Create virtual card via x402 payment
node bin/cli.mjs status         # Poll card creation status
node bin/cli.mjs wallet         # Check USDT/BNB balance
node bin/cli.mjs topup          # Transfer USDT via WalletConnect
node bin/cli.mjs gas            # Transfer BNB for tx fees
node bin/cli.mjs withdraw       # Reclaim funds from session key
node bin/cli.mjs clean          # Uninstall skill & clear cache

# Or via npm scripts
npm run create
npm run status
npm run wallet

# Release
node scripts/release.mjs
```

No build step — all source is native ES Modules (`.mjs`), executed directly by Node.js >=18.

## Testing

```bash
# 单元测试（纯逻辑，无网络）
node --test test/create-logic.test.mjs

# 守卫：SKILL.md 必须纯英文（无中日韩/全角字符；emoji 不受影响）——防中文引导回流
node --test test/skill-no-cjk.test.mjs

# 端到端购物演示（真实检索→填卡，fill-only 不提交、不扣款）
node test/demo-flow.mjs                       # 可选 Q="mini refrigerator" 换品类

# 收银台填单 兼容性+效率 回归 harness（多商户跨品类，fill-only，采集分阶段耗时 + shippingVia）
node test/checkout-fill.mjs                    # 默认品类各 1 家冒烟
AICARD_TEST_PER_CAT=3 node test/checkout-fill.mjs   # 每品类 3 家，更广覆盖
AICARD_TEST_SHOPS="shop.com|gid://shopify/ProductVariant/123" node test/checkout-fill.mjs  # 只测指定 shop|variant（逗号分隔多个）
```

**`test/checkout-fill.mjs`** 是收银台改动的主回归工具，验证「填单到点击支付前」的成功率与耗时：
- **判据**：`outcome=filled_no_submit` 且 `shippingReady/billingSameAsShipping/卡四字段` 全 true = 成功；其余（`shipping_not_ready`/`card_not_supported`/`checkout_unavailable`/`bot_blocked`…）多为真实商户约束，逐条列出。
- **前置**：本地有可用缓存卡（`aicard shop cards` 至少 1 张 usable）；需联网。
- **安全**：全程 `--fill-only` 只填不提交——不真实下单、不扣款、不消费卡。
- **产出**：填单成功率、按品类、用时分解（**我方固定开销 vs 商户算运费等待**——长尾变量在后者，非脚本）、`shippingVia` 结构分布（radio 多选项 / methodRow 单选项 / priced 经典多步摘要）。
- **可配 env**：`AICARD_TEST_PER_CAT`、`AICARD_TEST_SHOPS`、`AICARD_TEST_EMAIL`、`AICARD_TEST_{COUNTRY,REGION,CITY,ZIP}`、`AICARD_TEST_RESULTS`。结果落盘 `os.tmpdir()/aicard-fill-results.jsonl`，断了重跑自动续，删除即全量重测。

**反爬 / 慢商户排查**：设 `AICARD_PERF=1` 跑 `shop pay` 会打印分阶段耗时（`country-done`/`fields-filled`/`shipping-ready`/`card-filled`）到 stderr；总时长长尾几乎全来自商户实时算运费（不可控）。被 Cloudflare/反爬拦截会返回 `outcome=bot_blocked`——可设 `AICARD_PROXY`/`HTTPS_PROXY` 走住宅代理换出口 IP 降低触发（不破解验证码）。真遇验证码用 `--assist` 有头模式人工解。

## Architecture

### Entry Points
- `bin/cli.mjs` — Commander.js CLI definition, lazy-loads command modules
- `skills/aicard/SKILL.md` — Agent skill specification (triggers, opening protocol, workflow)
- `scripts/postinstall.mjs` — Auto-installs skill into detected AI coding agents on `npm install`

### Core Modules (`src/`)
- `x402.mjs` — x402 protocol client: wraps axios with EIP-712 signing, captures `orderNo` from 402 responses
- `walletconnect.mjs` — WalletConnect v2 integration: QR code UI (custom HTML page), local status server, ERC20 transfers (USDT + BNB)
- `balance.mjs` — EVM balance/allowance queries via Viem public client on BSC
- `config.mjs` — Config persistence at `~/.aicard/config.json` (mode 0o600). Priority: CLI args > env vars > config file
- `sanitize.mjs` — Hides card PII (full number, CVV, expiry) from agent output
- `constants.mjs` — BSC addresses, RPC URL, amount limits, polling config
- `update-check.mjs` — Background auto-update detection via `npm view`

### Command Modules (`src/commands/`)
Each command module exports a single async function. Pattern: parse options → load/validate config → call shared utilities → output JSON or error.

### Key Architectural Concepts

**Session Key Model**: A randomly generated private key stored locally acts as a "session key." The user's main wallet (MetaMask, etc.) funds this key via WalletConnect. The session key then signs x402 payments (gasless EIP-712) for card creation.

**x402 Payment Flow**: `GET /create → HTTP 402 + requirements → client EIP-712 sign → server submits on-chain USDT transfer (server pays gas) → poll /status for card`

**Gas Model**: One-time `approve` tx requires BNB (~0.0003). Card creation itself is gasless (server-paid). Withdrawal requires BNB for direct on-chain transfer.

## 开发规范 (Development Conventions)

> 这些是从实际返工中沉淀的硬规则，改代码前先读，避免重复踩坑。

### 1. 富展示 / 步骤呈现：AI 动态驱动，不写死
购物流程的可视化（选品→详情→下单→开卡→打开收银台→填地址→填卡→提交→收据）**分工必须是**：
- **代码只提供"可感知的素材"**：可靠且结构化的数据（截图、`outcome`、结构化 step 事件、收据字段），以及**可选**的渲染助手（`src/shop/render.mjs`）。
- **AI（agent）动态编排呈现**：拿实时事件/数据，自行决定如何让用户感知每一步（文字清单 / 逐步更新的 Artifact），并随实际结果（失败在哪步、要不要 3DS、是否缓存卡）灵活调整。
- **禁止**在代码里把"步骤序列 / 呈现模板"钉死成固定流水线。步骤是**灵活涌现**的，不是常量数组。渲染助手可作兜底，但不得成为唯一/强制路径。
- **实时感知机制**：长流程（如 `shop pay`）以**事件流**（结构化 JSONL 写 progress 文件）实时吐每步进展，agent 后台跑 + tail 逐步呈现；不要做成"一次同步黑盒、跑完才一次性返回"。

### 2. 卡面 PII 安全红线（不可妥协）
- 完整卡号 / CVV / 有效期**绝不**出现在 stdout、日志、envelope、或任何可分享产物（Artifact / 截图嵌入）中；仅允许显示**末 4 位**。
- 收银台填卡截图（`co-05-card-filled*`）含**明文卡号/CVC**，**绝不内嵌**任何 HTML/Artifact；填卡步骤一律"masked"占位。渲染器已强制排除，勿绕过。

### 3. 链上交易的 gasPrice
- 本项目 RPC 是**私有交易节点**，拒收 EIP-1559 零费率交易（`require GasPrice=50000000`）。凡**本地签名、直接上链**的交易（approve / withdraw）**必须显式设 legacy `gasPrice`**。
- 取值方式：**动态** `getGasPrice()` × 共享常量 `GAS_PRICE_BUFFER`(=120n)/100n（+20% buffer）。**不写死绝对下限**——gasPrice 随行就市，靠 buffer 覆盖波动。
- 发卡本身是 gasless（服务端上链），不受此约束。

### 4. 不写死环境假设 / 用动态值
- 不写死时区（用系统真实时区，指纹最自洽）；`locale:"en-US"` 是**功能性归一**（强制收银台英文以匹配选择器），属例外并已注释说明。
- 金额取**服务端权威值**（如开卡 `req.amountUsdt` 已含 10% 费），据此算精确差额自动补足，**不让用户凭面额猜、二次充值**（见 `wc-topup.mjs` + `card-issuer.mjs` autoFund）。

### 5. 命令必须能自然退出
WalletConnect 会开着 relay WebSocket + heartbeat 占住事件循环。WC 相关命令跑完后进程要能退出（`bin/cli.mjs` 用 `parseAsync().then(exit)` 兜成功路径，`emitErr` 各自 exit）；新增长驻资源时注意收尾关闭。

### 6. 改动生效 ≠ git push：本地验证与发布的同步
**改完代码 push 到 git 并不会让任何人（包括你自己的桌面端）用上。** 真正运行的是两个独立的"消费端"，改动必须同步到它们才生效：
- **全局 `aicard` CLI**（agent 通过 shell 调用）：`npm` 全局安装的版本。git 里的 `bin/cli.mjs` 新增的命令/选项，只有在这个全局命令被更新后才可用。
- **已装 skill**（agent 读的 `~/.claude/skills/aicard/SKILL.md` + `references/`）：与仓库里的 `skills/aicard/` 是两份拷贝。改了仓库的 SKILL.md，已装的那份不会自动变。

**本地验证**（把这台机器接到本仓库最新，改动可逆）：
```bash
npm link                                            # 全局 aicard → 本仓库 bin/cli.mjs
cp skills/aicard/SKILL.md ~/.claude/skills/aicard/  # 刷新已装 skill（连同 references/）
cp -R skills/aicard/references ~/.claude/skills/aicard/
```
之后必须**新开一个会话**——skill 在会话触发时加载，旧会话仍用旧 skill。还原：`npm unlink -g @aeon-ai-pay/aicard && npm i -g @aeon-ai-pay/aicard@latest`，SKILL.md 用 `.bak` 覆盖回。

**正式发布**（让所有用户/其它设备拿到）：
```bash
node scripts/release.mjs   # bump 版本 + npm publish
```
用户侧再 `npm update -g @aeon-ai-pay/aicard` 更新 CLI、`npx skills add AEON-Project/aicard -g -y` 从 GitHub main 拉最新 SKILL.md。

**排查"改了没生效"时先自检激活版本**，不要只看仓库：
```bash
which aicard; aicard --version
aicard shop --help | grep -i steps      # 新命令在不在 = 全局是不是新版
grep -c "Live step-by-step" ~/.claude/skills/aicard/SKILL.md   # 已装 skill 是不是新版
```

## Key Dependencies
- `viem` — EVM client (balance queries, contract reads)
- `@walletconnect/sign-client` — Wallet connection protocol
- `@aeon-ai-pay/axios` / `@aeon-ai-pay/evm` — Custom x402 protocol wrappers
- `commander` — CLI framework
