# Spike: Shopify 收银台自动填卡

用**确定性 Playwright 脚本**(无 LLM)往 Shopify 托管收银台自动填卡,量化整条闭环里最不确定的一环。

## 这个 spike 要回答的三个问题

1. **iframe 注入能不能过** — Shopify 卡字段在跨域 iframe 里,且校验 `isTrusted`。Playwright 能不能稳定填入?(核心风险)
2. **会不会撞 3DS/OTP** — headless 下无法人工介入,3DS 一出现即中断。
3. **会不会撞验证码/机器人拦截**。

## 安装

```bash
cd spike/shopify-fill
npm install          # 会自动 playwright install chromium
```

## Phase 1:现在就能跑(不需要真卡、不需要 UCP 店铺)

拿**任意一个真实 Shopify 店铺**,加购一件便宜商品,一路走到收银台**付款页**(有卡号输入框那一页),复制该页 URL,然后:

```bash
# Shopify Bogus Gateway 测试卡:卡号填 "1"=成功 / "2"=失败 / "3"=异常
node fill-checkout.mjs \
  --url "https://某店.myshopify.com/checkouts/..." \
  --number 1 --expiry "12/34" --cvc 123 --name "Test Buyer" \
  --headful --out ./artifacts
```

- 若店铺用真实网关(Stripe 等),改用该网关测试卡,如 `--number 4242424242424242`。
- `--headful` 打开可视浏览器,方便肉眼观察(调试期建议开)。
- 生产/无人值守用 headless(去掉 `--headful`)。

## 输出

- **stdout**:一行 JSON 报告(envelope),含每个字段 `located/filled`、`outcome`、`signals`(3DS/验证码/表单错误)、截图路径。
- **stderr**:带时间戳的分步日志。
- **artifacts/**:各阶段全屏截图(加载→填好→提交后)。

### outcome 取值

| outcome | 含义 | 退出码 |
|---|---|---|
| `success` | 填卡+提交,抵达感谢/订单页 | 0 |
| `fill_failed` | 核心卡字段没填进去(**iframe 注入被拦,最想量的风险**) | 3 |
| `interrupted_3ds` | 触发 3DS 挑战,headless 无法继续 | 3 |
| `interrupted_captcha` | 撞验证码 | 3 |
| `submit_failed` | 卡被拒/信息错误 | 1 |
| `timeout` | 没等到卡字段 iframe | 2 |

## Phase 2:接真卡 + MCP continue_url

- **卡来源(已解决)**:后端 402 支付完成后直接返回**完整卡面**(不走 CLI 的 `sanitize.mjs` 脱敏路径)。上层拿到后拼成 `--number/--expiry/--cvc` 传入即可。
  > `--from-aicard` 走的是脱敏 CLI,仅用于演示为何不能用那条路;生产走后端完整卡面接口。
- **URL 来源**:先跑通 Shopify Catalog→Cart→Checkout MCP 拿到 `continue_url`(需 UCP 店铺 + Token tier 凭证)。

## 3DS/OTP 降级(允许二次用户输入)

正常无人值守自动跑;一旦检测到 3DS/验证码,用 `--wait-3ds` 保持页面打开、轮询等待用户完成输入:

```bash
node fill-checkout.mjs --url "..." --number ... --expiry ... --cvc ... \
  --headful --wait-3ds 120000     # 遇挑战时最多等用户 120s 完成二次输入
```

- **必须 `--headful`**(或产品侧把挑战页暴露给用户),否则 headless 下用户无从输入。
- 挑战完成后脚本自动继续判定 `outcome`;截图 `05-challenge` / `06-after-challenge` 存档。

## 状态小结

| 约束 | 状态 |
|---|---|
| 完整卡号 | ✅ 后端 402 返回 |
| 3DS/OTP | ✅ 二次用户输入(`--wait-3ds` + headful) |
| iframe 注入能否过 | ⬜ **待 Phase 1 实测** |
