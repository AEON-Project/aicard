/**
 * 错误码常量表 —— CLI 与文档的单一事实源
 *
 * 退出码语义：
 *   0 成功
 *   1 用户错误（参数、余额、配置、用户拒绝）
 *   2 超时（轮询、WalletConnect、签名、链上）
 *   3 服务端 / 网络
 *   4 内部错误
 */

export const ERROR_CODES = {
  // ===== 用户错误（exit 1）=====
  WALLET_NOT_CONFIGURED:  { exit: 1, message: "Wallet not configured. Run: aicard setup --check" },
  SERVICE_URL_MISSING:    { exit: 1, message: "Service URL not configured." },
  AMOUNT_INVALID:         { exit: 1, message: "Invalid amount." },
  AMOUNT_OUT_OF_RANGE:    { exit: 1, message: "Amount is outside the allowed range." },
  AMOUNT_EXCEEDS_BALANCE: { exit: 1, message: "Requested amount exceeds available balance." },
  INSUFFICIENT_USDT:      { exit: 1, message: "Insufficient USDT balance." },
  INSUFFICIENT_BNB:       { exit: 1, message: "Insufficient BNB for gas." },
  NO_FUNDS:               { exit: 1, message: "No funds available." },
  NO_MAIN_WALLET:         { exit: 1, message: "No main wallet address configured. Use --to <address>." },
  INVALID_USAGE:          { exit: 1, message: "Invalid CLI usage." },
  PAYMENT_REJECTED:       { exit: 1, message: "Payment approval was rejected. Please try again if you'd like to proceed." },

  // ===== 超时（exit 2）=====
  PAYMENT_TIMEOUT:        { exit: 2, message: "Payment approval timed out. Please try again." },
  WC_SESSION_EXPIRED:     { exit: 2, message: "WalletConnect session expired." },
  POLL_TIMEOUT:           { exit: 2, message: "Polling timed out. Card may still be provisioning." },
  TX_TIMEOUT:             { exit: 2, message: "On-chain transaction timed out." },

  // ===== 服务/网络（exit 3）=====
  SERVICE_UNAVAILABLE:    { exit: 3, message: "Service unavailable or network error." },
  PAYMENT_FETCH_FAILED:   { exit: 3, message: "Failed to fetch payment requirements." },
  BALANCE_CHECK_FAILED:   { exit: 3, message: "Failed to check balance." },
  TX_REVERTED:            { exit: 3, message: "On-chain transaction reverted." },
  WITHDRAW_FAILED:        { exit: 3, message: "Withdraw transaction failed." },
  INVALID_PAYMENT_AMOUNT: { exit: 3, message: "Server returned invalid payment amount." },
  PAYMENT_FAILED:         { exit: 3, message: "Payment request failed." },

  // ===== Shop 参数/校验（exit 1）=====
  NO_URL:                  { exit: 1, message: "Missing --continue-url." },
  NO_AMOUNT:              { exit: 1, message: "Missing or invalid --amount." },
  TEST_STORE_BLOCKED:     { exit: 1, message: "Checkout backend is a test store; blocked. Use --allow-test to override." },
  MISSING_ID:             { exit: 1, message: "Missing product id (--id)." },
  MISSING_SHOP:           { exit: 1, message: "Missing merchant domain (--shop)." },
  MISSING_VARIANT:        { exit: 1, message: "Missing ProductVariant id (--variant)." },
  VARIANT_NOT_FOUND:      { exit: 1, message: "ProductVariant does not exist at this merchant. Re-resolve via `shop search --shop <domain>`." },
  MISSING_SHIPPING_FIELDS:{ exit: 1, message: "Missing required shipping fields." },
  INVALID_EMAIL:          { exit: 1, message: "Invalid email." },
  INVALID_COUNTRY:        { exit: 1, message: "Unknown country name or ISO code." },
  NEEDS_APPROVE_GAS:      { exit: 1, message: "Approve needed but no BNB for gas. Run: aicard gas." },
  ORDER_AUTH_REQUIRED:    { exit: 1, message: "Order tracking requires a Token-tier credential." },
  ORDER_NO_SHOP:          { exit: 1, message: "get_order requires the merchant domain (--shop)." },
  TOKENIZER_ENDPOINT_UNKNOWN: { exit: 1, message: "Card tokenizer endpoint unknown (pending Shopify)." },
  NO_CHECKOUT_ID:         { exit: 1, message: "Missing checkout_id for tokenization." },

  // ===== Shop 服务/网络（exit 3）=====
  SHOP_SEARCH_FAILED:     { exit: 3, message: "Catalog search failed." },
  SHOP_PRODUCT_FAILED:    { exit: 3, message: "Get product failed." },
  SHOP_CART_FAILED:       { exit: 3, message: "Create cart failed." },
  SHOP_PAY_FAILED:        { exit: 3, message: "Checkout payment failed." },
  SHOP_TRACK_FAILED:      { exit: 3, message: "Order tracking failed." },
  SHOP_CARDS_FAILED:      { exit: 3, message: "Listing cached cards failed." },
  CARD_ISSUE_FAILED:      { exit: 3, message: "Card issuance failed." },
  CARD_NOT_READY:         { exit: 3, message: "Card issued but full details not ready." },
  PLAYWRIGHT_MISSING:     { exit: 3, message: "Playwright not installed. Run: npm i -g playwright && npx playwright install chromium" },
  BROWSER_INSTALL_FAILED: { exit: 3, message: "Browser engine download failed. Run: npx playwright install chromium" },
  UCP_NETWORK:            { exit: 3, message: "UCP request failed (network)." },
  UCP_RATE_LIMITED:       { exit: 3, message: "Rate limited by UCP endpoint." },
  UCP_RPC_ERROR:          { exit: 3, message: "UCP RPC error." },
  UCP_TOOL_ERROR:         { exit: 3, message: "UCP tool error." },
  UCP_BAD_RESPONSE:       { exit: 3, message: "UCP returned an invalid response." },
  TOKENIZE_FAILED:        { exit: 3, message: "Card tokenization failed." },
  TOKENIZE_NETWORK:       { exit: 3, message: "Tokenizer request failed (network)." },
  TOKENIZE_NO_TOKEN:      { exit: 3, message: "Tokenizer returned no token." },

  // ===== 内部（exit 4）=====
  INTERNAL_ERROR:         { exit: 4, message: "Internal error." },
  WALLET_ERROR:           { exit: 1, message: "Wallet operation failed." },
};
