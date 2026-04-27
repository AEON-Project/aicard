# aicard

通过 [x402 协议](https://www.x402.org/) 购买虚拟借记卡的 Agent 技能。

使用加密货币（BSC 链上的 USDT）支付，获取即用型虚拟 Visa/Mastercard。

## 安装技能

```bash
# 安装到所有检测到的 Agent（Claude Code、Cursor、Codex、OpenClaw、Gemini CLI 等）
npx skills add AEON-Project/aicard -g -y

# 安装到指定 Agent
npx skills add AEON-Project/aicard -a claude-code -a cursor -a codex -g -y
```

支持的 Agent：Claude Code、Cursor、Codex、OpenClaw、Gemini CLI、GitHub Copilot、Windsurf、Roo Code 及 [39+ 更多](https://agentskills.io)。

## 命令行用法

```bash
# 首次使用：自动创建本地钱包（私钥本地生成，绝不上传）
npx @aeon-ai-pay/aicard setup --check

# 创建虚拟卡（$5 美元，自动轮询状态）
# 余额不足时自动通过 WalletConnect 发起充值
npx @aeon-ai-pay/aicard create --amount 5 --poll

# 查询卡片状态
npx @aeon-ai-pay/aicard status --order-no <orderNo>

# 查看钱包余额（BNB + USDT）
npx @aeon-ai-pay/aicard wallet

# 手动为本地钱包充值 USDT
npx @aeon-ai-pay/aicard topup --amount 50

# 为本地钱包补 BNB gas
npx @aeon-ai-pay/aicard gas --amount 0.001

# 将剩余资金（USDT + BNB）提回主钱包
npx @aeon-ai-pay/aicard withdraw

# 查看当前配置
npx @aeon-ai-pay/aicard setup --show

# 卸载技能、清理缓存
npx @aeon-ai-pay/aicard clean
```

## 前提条件

- Node.js >= 18
- 一个支持 WalletConnect 的手机钱包 App（MetaMask、OKX Wallet、Trust Wallet 等）
- BSC 链上的 USDT (BEP-20) 用于购卡
- 少量 BNB 用于 approve gas（约 $0.002/笔，首次授权后无需再付）

## 工作原理

```
1. CLI 在本地自动生成 session key（一次性钱包）
2. 创建卡时，若余额不足自动通过 WalletConnect 扫码充值（USDT + BNB gas）
3. 首次使用需一次 approve 授权（无限额度，后续无需重复）
4. Session key 自动签名 x402 支付 — 无需手动确认

Agent 流程：
  用户意图 -> Agent 激活技能 -> x402 两阶段协议：
    1. GET /create?amount=X         -> HTTP 402 + 支付要求
    2. Session key EIP-712 签名     -> 服务端提交链上转账
    3. 轮询 /status?orderNo=X      -> 卡片详情就绪
```

## 配置

配置存储在 `~/.aicard/config.json`（文件权限 600）。

运行 `setup --check` 自动生成本地钱包。主钱包私钥**绝不会**存储在本地，仅保存 session key（一个本地生成的临时钱包）。充值通过 WalletConnect 扫码完成。

覆盖默认 service URL（可选）：
```bash
npx @aeon-ai-pay/aicard setup --service-url https://custom-api.example.com
```

## 许可证

MIT
