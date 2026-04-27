# AEON AI Card Store

## When to use

Trigger this reference when the user says:
- "what can I buy"
- "show me what's available"
- "what can I do?"
- "what can I use the card for"

Present options conversationally. Do not dump the full list — highlight what's most relevant.

---

## Virtual Card Use Cases

### AEON Agent Card – Supported & Upcoming Use Cases

**Coming Soon**
- Subscriptions (ChatGPT, Claude, Midjourney)
- Ads (Google, Meta)
- Travel bookings
- SaaS tools

**Tell us what you want**

Submit your request here:
👉 [Google Form link]

---

## x402 API Payments

Pay these services directly using `x402 fetch`. No card needed — payment goes straight from your wallet.

### AI & Data

| Service | What it does | Chain |
|---|---|---|
| AskClaude | Per-question Claude AI access ($0.01–$0.10/query) | Base |
| Arch AI Tools | 53 AI tools: web search, image generation, fact-checking | Base |
| Firecrawl | Web scraping and LLM-ready content extraction | Base |
| Gloria AI | Real-time news data for agents | Base |
| Minifetch | Web metadata and content summaries | Base |

### Blockchain & DeFi

| Service | What it does | Chain |
|---|---|---|
| Messari | Crypto research and on-chain data | Base |
| Nansen | Wallet intelligence and blockchain analytics | Base |
| DiamondClaws | DeFi yield scoring and protocol risk analysis | Base |
| Stakevia | Solana validator intelligence | Solana |

### Infrastructure

| Service | What it does | Chain |
|---|---|---|
| Pinata | IPFS file uploads and retrievals, no account required | Base |
| Run402 | Postgres databases and serverless functions, no signup | Base |
| Alchemy | Pay-per-request RPC / blockchain API access | Base |
| Robtex | DNS and network intelligence APIs | Base |

### Payments & Commerce

| Service | What it does | Chain |
|---|---|---|
| Bitrefill | Buy gift cards and prepaid cards with crypto | Base |
| ClawCredit | Access x402 services on credit, pay later | Base |

Full registry: [x402.org/ecosystem](https://www.x402.org/ecosystem) · [x402list.fun](https://x402list.fun)

---

## How to Present to the User

Example response when user has no specific intent:

> "Here's what you can do with AEON AI Card:
>
> - **Virtual card** — coming soon: subscribe to ChatGPT, Claude, Midjourney, run ads, book travel
> - **Pay AI APIs** — call Claude, Firecrawl, web search per request via x402
> - **Access DeFi data** — Nansen, Messari on-chain analytics via x402
>
> What would you like to do?"

Adapt based on context. For virtual card intent → route to create-card flow. For x402 API intent → route to x402 flow.
