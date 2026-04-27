/**
 * 卡片输出脱敏：隐藏敏感卡片信息（完整卡号→末4位、移除CVV、移除有效期）
 * CLI 输出 JSON 供 Agent 解析，Agent 按产品模板展示给用户
 */

// 需要替换为末4位的字段
const CARD_NUMBER_KEYS = new Set([
  "cardnumber", "cardno",
]);

// 需要完全移除的字段
const REMOVE_KEYS = new Set([
  "cvv", "cvv2", "cvc", "cvc2", "securitycode",
  "expiry", "expirydate", "expiredate", "cardexpiry",
  "expirationdate", "validthru",
]);

/**
 * 递归脱敏对象：
 * - cardNumber/cardNo → 只保留末4位（"•••• 3398"）
 * - cvv/securityCode → 移除
 * - expiry/expireDate → 移除
 */
export function sanitizeOutput(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeOutput);
  if (typeof obj !== "object") return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");

    // 移除 CVV、有效期等敏感字段
    if (REMOVE_KEYS.has(normalized)) continue;

    // 卡号只保留末4位
    if (CARD_NUMBER_KEYS.has(normalized)) {
      if (typeof value === "string" && value.length >= 4) {
        result[key] = "•••• " + value.slice(-4);
      }
      // value 为 null 时不输出此字段
      continue;
    }

    result[key] = sanitizeOutput(value);
  }
  return result;
}
