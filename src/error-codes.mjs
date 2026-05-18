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

  // ===== 内部（exit 4）=====
  INTERNAL_ERROR:         { exit: 4, message: "Internal error." },
  WALLET_ERROR:           { exit: 1, message: "Wallet operation failed." },
};
