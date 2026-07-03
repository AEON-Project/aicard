# aicard × Shopify 自动购物支付 —— 端到端方案设计

> 目标：用户说"买某商品" → 自动完成 Shopify 商户发现、拼单、发卡、填卡付款的完整闭环。
> 载体：扩展现有 `@aeon-ai-pay/aicard`（新增 `aicard shop` 命令族）。

---

## 1. 已验证的事实（实测，非推断）

| 结论 | 证据 |
|---|---|
| Playwright 能穿透 Shopify **跨域卡字段 iframe**、过 isTrusted 校验 | 对 deathwishcoffee.com 真实收银台，卡号/有效期/CVC/持卡人全部 `located+filled`，`outcome: iframe_injection_OK`（`spike/shopify-fill/e2e-probe.mjs`） |
| Cart permalink 可跨会话恢复购物车状态 | permalink `/cart/{variant}:1` 自动重定向到 `/checkouts/cn/{token}`，商品已在 |
| Shopify 所有 Agent **API 路径都不收裸卡号** | ECP/complete_checkout/Shop Pay 均要求预注册/tokenized instrument；裸 PAN 只能在网页收银台卡字段输入 |
| 收货地址字段用 `autocomplete` 属性可稳定定位 | email/given-name/family-name/address-line1/tel 实测命中；city/zip 需补 name+placeholder 兜底 |

---

## 2. 关键架构决策

**全程匿名，走 `continue_url` + Playwright 填卡。** 因此：

- ❌ 不需要 Token tier / 不需要成为"可信 Agent"
- ❌ 不需要 `complete_checkout`（API 也不收我们的裸卡号）
- ❌ 甚至可不用 Checkout MCP —— **Cart MCP 的 `continue_url` 就是收银台入口**
- ✅ 只需一个 UCP Profile（标识 Agent），Cart 调用匿名即可

这把认证复杂度砍到最低。Checkout MCP 仅在需要"服务端预填地址/精确税费"时可选引入。

---

## 3. 端到端数据流

```
用户意图（"买 X"）
   │
① Global Catalog search ─────────────▶ [{ merchantDomain, variantGid, title, price }]
   │                                      端点: Global Catalog MCP | 认证: Profile
   │
② 用户选择商户 + 商品  ◀── 满足"让用户选择商户"的需求
   │
③ Cart MCP create_cart ──────────────▶ { cartId, totals, continue_url }
   │   POST https://{merchantDomain}/api/ucp/mcp   | 认证: 匿名 | 带 buyer context(收货地址)
   │
④ 展示 totals（含税/运费）给用户确认
   │
⑤ aicard 发卡 ───────────────────────▶ { number, expiry, cvc, scheme }   ← 【后端完整卡面接口】
   │   金额 = totals.total | x402 支付
   │
⑥ Playwright 打开 continue_url
   │   → 填收货地址 → 填卡 iframe → 点付款(真实扣款)
   │
⑦ 结果判定
   ├─ success → 订单完成（可选 Order MCP get_order 跟踪）
   ├─ 3DS/验证码 → 降级：交回用户输入 OTP（见 §8）
   └─ declined/fill_failed → 报错 + 截图
```

---

## 4. 组件与职责

| 模块 | 文件 | 职责 |
|---|---|---|
| Orchestrator | `src/shop/index.mjs` | 串联全流程，输出 envelope |
| ProfileManager | `src/shop/profile.mjs` | 加载/引用 UCP Agent Profile |
| CatalogClient | `src/shop/catalog.mjs` | Global Catalog 搜索，返回商户+variant |
| CartClient | `src/shop/cart.mjs` | UCP JSON-RPC：`create_cart`/`get_cart` |
| CardIssuer | `src/shop/card-issuer.mjs` | 调 aicard 发卡 + 拉后端完整卡面 |
| CheckoutFiller | `src/shop/checkout-filler.mjs` | Playwright 填地址+卡+提交+3DS（由 `spike/checkout-live.mjs` 演进） |
| CLI | `src/commands/shop.mjs` | `aicard shop buy/search/quote` |

---

## 5. 接口契约

### 5.1 UCP Cart（匿名）
```jsonc
// POST https://{merchantDomain}/api/ucp/mcp
{ "jsonrpc":"2.0","method":"tools/call","id":1,
  "params":{ "name":"create_cart","arguments":{
    "meta":{ "ucp-agent":{ "profile":"https://<你的域名>/ucp/agent.json" } },
    "cart":{ "line_items":[{ "quantity":1,"item":{ "id":"gid://shopify/ProductVariant/..." } }],
             "context":{ "address_country":"GB","postal_code":"SW1A 2AA" } } } } }
// → 响应: { id, currency, line_items[], totals, continue_url, expires_at }
```

### 5.2 后端完整卡面接口【需你方新增】
现有 CLI 输出被 `src/sanitize.mjs` 脱敏，自动填卡拿不到完整卡面。需一个**鉴权后**的接口：
```jsonc
// GET {serviceUrl}/open/ai/x402/card/full-detail?orderNo=xxx
// Header: Authorization / 签名（防止裸卡面泄露）
// → { cardNumber:"4937...", expiryMonth:"03", expiryYear:"31", cvv:"889", scheme:"VISA" }
```
> 约束：此接口只在服务端→受信编排层之间调用，卡面**不进 CLI stdout、不落日志、不入 git**。

### 5.3 CheckoutFiller 入参
```jsonc
{ "continueUrl":"https://.../checkouts/cn/...",
  "address":{ "email","country","first","last","address1","city","zip","phone" },
  "card":{ "number","expiry","cvc","name" },
  "onChallenge": "otp-file | callback" }   // 3DS 回填方式
```

---

## 6. 依赖增量

```jsonc
// package.json
"dependencies": {
  "playwright": "^1.49.0"        // 填卡（也可设为 optionalDependencies，按需安装浏览器）
}
"devDependencies": {
  "@shopify/ucp-cli": "*"        // 仅用于生成/托管 UCP Profile：ucp profile init
}
```
- **UCP 调用不需要重 SDK** —— 端点就是 JSON-RPC，用 Node 内置 `fetch` 直连。
- Global Catalog 若要求特定鉴权，再评估是否引入官方 client。

---

## 7. 认证矩阵

| 环节 | 端点 | 认证 |
|---|---|---|
| Global Catalog 搜索 | Global Catalog MCP | Profile（可能匿名/Token，**待确认**） |
| Cart create/get | `{shop}/api/ucp/mcp` | **匿名** + Profile 引用 |
| 收银台填卡 | `continue_url`（网页） | 无（Playwright 模拟买家） |
| （可选）Checkout | `{shop}/api/ucp/mcp` | 匿名可到 `requires_escalation` |

---

## 8. 降级与边界

- **3DS / 验证码**：`CheckoutFiller` 检测到挑战 → 截图 + 暂停 → 通过 `otp.txt`（或回调）接收用户验证码 → 自动填入挑战框继续。已在 `checkout-live.mjs` 实现雏形。headless 无法自动过 3DS，必须有此人工回填通道。
- **会话隔离**：始终在**同一个 Playwright 会话内**从 `continue_url` 开始，不跨浏览器传递 session（cart 状态在服务端，可恢复）。
- **卡额度/发卡失败**：发卡前用 totals 校验金额在 `$0.6~$800` 区间；失败中止并回收。
- **选择器漂移**：Shopify 收银台改版可能使选择器失效 → 保留截图取证 + 多重选择器兜底 + 定期回归。
- **合规**：真实提交=真实扣款，仅在用户显式确认后执行；卡面数据只在内存流转。

---

## 9. 待你方确认 / 提供的输入

1. **后端完整卡面接口**：路径 / 鉴权方式 / 字段格式（§5.2）
2. **Global Catalog 接入**：凭证与端点；或先限定单一商户走 Storefront Catalog
3. **UCP Profile 托管**：一个 https well-known URL 放 `agent.json`
4. **aicard 卡的 3DS 策略**：是否触发、渠道（短信/邮箱），决定 §8 回填形态
5. **收货地址来源**：用户每单输入 / 保存的默认地址

---

## 10. 里程碑

- **M0** ✅ iframe 注入实测通过（已完成）
- **M1** Cart→continue_url→Playwright 填地址+卡，在**自建开发店 + Bogus Gateway** 用测试卡真实跑通提交（零风险）
- **M2** 接 §5.2 后端完整卡面 + 真卡真实小额验证
- **M3** 接 Global Catalog 商品发现 + 用户选商户
- **M4** 3DS 降级打磨、错误恢复、选择器回归
- **M5** Order Webhook 接收端（验签/幂等/去重，随纯 API 路径上线）

---

## 11. 纯 API 支付路径（研究结论，M2/M3 备选）

**能否纯 API 提交卡：架构可行，但当前被端点缺失卡住。**

- UCP tokenization 接受裸卡面换 token（`POST {tokenizer}/tokenize`，`credential.card_number_type="fpan"` + `binding.checkout_id`），**纯 server-to-server、无需浏览器**；token 包成 instrument 提交 `complete_checkout`。
- 联调时确认商户已声明 `dev.shopify.card` handler（visa/master/amex/discover/diners）。
- 已按 UCP 契约实现骨架：`src/shop/tokenize.mjs`（tokenize）+ `src/shop/checkout.mjs`（create_checkout / complete_checkout）。

**落地门槛（缺一不可）：**
1. **Shopify card tokenizer 端点未公开** —— `card-payment-handler` spec.md 404，config 只声明品牌不含端点。🔴 阻断，需 Shopify 提供或申请。
2. **PCI DSS** —— 发送裸 FPAN 的一方需合规；应由 aicard 后端发起 tokenize，不在客户端。
3. **Token tier** —— `complete_checkout` 需 client_id/secret 换 Bearer + 完成购买权限。
4. **3DS** —— 纯 API 下仍可能 `requires_escalation`，需保留用户交互降级。

**决策**：浏览器填卡（已实测通过）为主路径；纯 API 待端点/凭证到位后切换，代码骨架已就绪。

**Sources**: [UCP tokenization guide](https://ucp.dev/2026-01-23/specification/tokenization-guide/) · [UCP payment-handler-guide](https://ucp.dev/specification/payment-handler-guide) · [Platform Tokenizer 示例](https://ucp.dev/specification/examples/platform-tokenizer-payment-handler/)

---

## 12. 订单跟踪边界（研究结论）

- **端点**：`POST https://{shop}/api/ucp/mcp`，工具 `get_order`，`id = gid://shopify/Order/{数字}`（来自 `complete_checkout` 响应）。
- **认证**：Token tier（`read_global_api_orders` scope）。
- **响应**：`status` / `fulfillment_status` / `fulfillment.events[]`（`tracking_number`、carrier、shipped/delivered）/ `line_items[]` / `totals[]`。
- **主渠道用 Order webhooks**（HMAC 用 `client_secret` 验签），**不要轮询** `get_order`；后者仅用于买家主动查、补漏 webhook。

**⚠️ 可见性边界（关键）**：`get_order` 与 webhook 只能看到【你的 agent 通过 `complete_checkout` 完成的订单】。**通过浏览器填卡（`continue_url`）完成的订单会被 Shopify 平台过滤，查不到。**

| 支付路径 | 订单跟踪方式 |
|---|---|
| 纯 API（`complete_checkout`，M2） | `get_order` + Order webhooks ✅ |
| 浏览器填卡（当前主路径） | 收银台成功页 `order.number` / `order.url`（`checkout-filler.extractOrder`）+ 用户邮箱 ❌ 无 Order MCP |

**Sources**: [Order MCP server](https://shopify.dev/docs/agents/orders/order-mcp) · [Order webhooks](https://shopify.dev/docs/agents/orders/order-webhooks)

---

## 13. Order Webhook 接收端（M2/M5 规划）

纯 API 路径落地后，用 webhook 作为履约/退款/退货变更的**主通道**（不轮询 get_order）。

- **注册**：⚠️ 无自助订阅 API，需联系 Shopify partner manager 服务端登记 delivery URL + topic（`orders/create` / `orders/updated` / `orders/delete`）。
- **验签**：header `X-Shopify-Hmac-SHA256` = base64(HMAC-SHA256(raw_body, `client_secret`))，用原始未解析 body、常量时间比较。
- **幂等**：header `X-Shopify-Webhook-Id` 去重；以最新一条为准。
- **重试**：失败最多 8 次 / 4 小时，指数退避。
- **payload**：完整订单状态（结构同 `get_order`）。
- **已就绪代码**：`src/shop/webhook.mjs`（`verifyOrderWebhook` / `parseOrderWebhook` / `handleOrderWebhook`）。aicard 是 CLI 不常驻——把这几个纯函数接进你后端的 HTTP 路由即可。

示例（后端路由）：
```js
import { handleOrderWebhook } from "aicard/src/shop/webhook.mjs";
// 注意：用原始 body（express 用 express.raw()），不要用已 JSON 解析的对象
const { verified, webhookId, topic, order } = handleOrderWebhook({
  rawBody, headers: req.headers, clientSecret: process.env.CLIENT_SECRET,
});
if (!verified) return res.sendStatus(401);
if (seen.has(webhookId)) return res.sendStatus(200); // 幂等去重
// 处理 order（以最新一条为准）...
```

**Sources**: [Order webhooks](https://shopify.dev/docs/agents/orders/order-webhooks)
