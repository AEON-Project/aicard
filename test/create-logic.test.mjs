/**
 * create 命令核心决策逻辑的单元测试
 * 运行: node --test test/create-logic.test.mjs
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ====== 从 create.mjs 提取的纯逻辑函数，便于单元测试 ======

/**
 * 前置检查：判断是否需要 topup / gas
 * 与 create.mjs 第 66-98 行逻辑一一对应
 */
function checkWalletNeeds({ allowance, amountWei, bnbRaw, usdtNum, requiredUsdt }) {
  let needTopup = false;
  let needGas = false;
  let topupAmount = null;

  // 1. 检查预授权额度
  if (allowance >= BigInt(amountWei)) {
    // allowance 足够
  } else {
    // 预授权不足，需要 approve（消耗 BNB gas）
    if (bnbRaw === 0n) {
      needGas = true;
    }
  }

  // 2. 检查 USDT 余额
  if (usdtNum < requiredUsdt) {
    needTopup = true;
    const shortfall = requiredUsdt - usdtNum;
    topupAmount = shortfall.toFixed(6);
  }

  return { needTopup, needGas, topupAmount };
}

/**
 * inlineWalletConnectTopup 的页面参数计算
 * 与 create.mjs 第 213-214 行逻辑一一对应
 */
function calcPageDisplay(amount, needGas) {
  const AUTO_GAS_BNB = "0.0003";
  const pageAmount = amount || (needGas ? AUTO_GAS_BNB : null);
  const pageToken = amount ? "USDT" : "BNB";
  return { pageAmount, pageToken };
}

/**
 * inlineWalletConnectTopup 回调内的执行分支
 * 与 create.mjs 第 224-276 行逻辑对应
 */
function getTransferSteps(amount, needGas) {
  const steps = [];
  if (amount) steps.push("USDT");
  if (needGas) steps.push("BNB");
  return steps;
}

// ====== 测试用例 ======

describe("checkWalletNeeds — 前置检查决策", () => {
  it("新钱包：allowance=0, BNB=0, USDT=0 → 需要 topup + gas", () => {
    const result = checkWalletNeeds({
      allowance: 0n,
      amountWei: "660000000000000000",
      bnbRaw: 0n,
      usdtNum: 0,
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, true, "应该需要 topup");
    assert.equal(result.needGas, true, "应该需要 gas");
    assert.equal(result.topupAmount, "0.660000", "topup 金额应为 0.660000");
  });

  it("有足够 allowance + 足够 USDT → 不需要任何充值", () => {
    const result = checkWalletNeeds({
      allowance: 1000000000000000000n, // 1 USDT
      amountWei: "660000000000000000",  // 0.66 USDT
      bnbRaw: 300000000000000n,         // 0.0003 BNB
      usdtNum: 1.0,
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, false);
    assert.equal(result.needGas, false);
    assert.equal(result.topupAmount, null);
  });

  it("allowance 不足但有 BNB → 需要 approve 但不需要 gas 转账", () => {
    const result = checkWalletNeeds({
      allowance: 0n,
      amountWei: "660000000000000000",
      bnbRaw: 300000000000000n, // 0.0003 BNB
      usdtNum: 1.0,
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, false);
    assert.equal(result.needGas, false, "有 BNB 时不需要 gas 转账");
  });

  it("allowance 不足且无 BNB，但 USDT 足够 → 只需要 gas", () => {
    const result = checkWalletNeeds({
      allowance: 0n,
      amountWei: "660000000000000000",
      bnbRaw: 0n,
      usdtNum: 1.0,
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, false);
    assert.equal(result.needGas, true, "无 BNB 应需要 gas");
  });

  it("allowance 足够但 USDT 不足 → 只需要 topup", () => {
    const result = checkWalletNeeds({
      allowance: 1000000000000000000000n, // 大额 allowance
      amountWei: "660000000000000000",
      bnbRaw: 0n,
      usdtNum: 0.1,
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, true);
    assert.equal(result.needGas, false, "allowance 足够时不需要 gas");
    assert.equal(result.topupAmount, "0.560000");
  });

  // Bug 验证：amountWei 为 "0" 时 allowance 检查被跳过
  it("⚠️ Bug 验证：amountWei='0' 导致 allowance 检查被跳过", () => {
    const result = checkWalletNeeds({
      allowance: 0n,
      amountWei: "0", // 服务端异常返回 0
      bnbRaw: 0n,
      usdtNum: 0,
      requiredUsdt: 0.66,
    });
    // amountWei=0 时，0n >= 0n 为 true，allowance 检查被跳过
    assert.equal(result.needGas, false, "amountWei=0 会导致 needGas 误判为 false！这是一个 bug");
  });

  // 浮点精度测试
  it("浮点精度：topupAmount 不应为负数", () => {
    const result = checkWalletNeeds({
      allowance: 0n,
      amountWei: "660000000000000000",
      bnbRaw: 0n,
      usdtNum: 0.6599999999999999, // 极接近但略小
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, true);
    const amt = parseFloat(result.topupAmount);
    assert.ok(amt >= 0, `topupAmount 不应为负数，实际: ${result.topupAmount}`);
  });

  it("浮点精度：余额与所需完全相等时不应触发 topup", () => {
    const result = checkWalletNeeds({
      allowance: 1000000000000000000000n,
      amountWei: "660000000000000000",
      bnbRaw: 0n,
      usdtNum: 0.66,
      requiredUsdt: 0.66,
    });
    assert.equal(result.needTopup, false, "余额等于所需时不应触发 topup");
  });
});

describe("calcPageDisplay — QR 页面参数", () => {
  it("同时需要 USDT + BNB 时，页面只显示 USDT（⚠️ 设计问题）", () => {
    const { pageAmount, pageToken } = calcPageDisplay("1.100000", true);
    assert.equal(pageToken, "USDT", "token 显示为 USDT");
    assert.equal(pageAmount, "1.100000", "金额显示为 USDT 金额");
    // 注意：BNB 转账不会在页面上体现，用户不知道还需要第二笔确认
  });

  it("只需要 BNB 时，页面显示 BNB", () => {
    const { pageAmount, pageToken } = calcPageDisplay(null, true);
    assert.equal(pageToken, "BNB");
    assert.equal(pageAmount, "0.0003");
  });

  it("只需要 USDT 时，页面显示 USDT", () => {
    const { pageAmount, pageToken } = calcPageDisplay("5.000000", false);
    assert.equal(pageToken, "USDT");
    assert.equal(pageAmount, "5.000000");
  });
});

describe("getTransferSteps — 转账执行顺序", () => {
  it("同时需要 USDT + BNB → 两步转账", () => {
    const steps = getTransferSteps("1.100000", true);
    assert.deepEqual(steps, ["USDT", "BNB"]);
  });

  it("只需要 USDT → 一步", () => {
    const steps = getTransferSteps("1.100000", false);
    assert.deepEqual(steps, ["USDT"]);
  });

  it("只需要 BNB → 一步", () => {
    const steps = getTransferSteps(null, true);
    assert.deepEqual(steps, ["BNB"]);
  });

  it("都不需要 → 零步（不应发生）", () => {
    const steps = getTransferSteps(null, false);
    assert.deepEqual(steps, []);
  });
});

describe("BNB 转账错误处理", () => {
  it("⚠️ BNB 转账异常被 try-catch 吞掉，不会中断流程", () => {
    // 模拟 inlineWalletConnectTopup 中 BNB 转账失败
    let bnbTransferCalled = false;
    let errorCaught = false;

    // 模拟 create.mjs 第 251-273 行的 BNB 转账逻辑
    const needGas = true;
    if (needGas) {
      try {
        // 模拟 requestNativeTransfer 抛出异常（如 WC session 断开）
        bnbTransferCalled = true;
        throw new Error("session disconnected");
      } catch (bnbErr) {
        errorCaught = true;
        // 原代码只打了 warning，不会抛出
      }
    }

    assert.equal(bnbTransferCalled, true, "BNB 转账被调用了");
    assert.equal(errorCaught, true, "异常被 catch 吞掉了");
    // 关键：此时 withWallet 会正常返回，create 继续执行
    // 但 re-check 时发现 BNB=0，会报错退出
    // 问题：WalletConnect 已关闭，用户无法自动重试 gas 转账
  });
});

describe("WC null 帧防护", () => {
  it("connection.emit 过滤 null payload", () => {
    // 模拟 walletconnect.mjs 中的 emit 拦截
    let originalCalled = false;
    const fakeConn = {
      emit: (event, ...args) => { originalCalled = true; },
    };

    const _origEmit = fakeConn.emit.bind(fakeConn);
    fakeConn.emit = function (event, ...args) {
      if (event === "payload" && args[0] == null) return false;
      return _origEmit(event, ...args);
    };

    // null payload 应被过滤
    originalCalled = false;
    fakeConn.emit("payload", null);
    assert.equal(originalCalled, false, "null payload 不应传递给原始 emit");

    // undefined payload 也应被过滤
    originalCalled = false;
    fakeConn.emit("payload", undefined);
    assert.equal(originalCalled, false, "undefined payload 不应传递给原始 emit");

    // 正常 payload 应通过
    originalCalled = false;
    fakeConn.emit("payload", { id: 1, jsonrpc: "2.0" });
    assert.equal(originalCalled, true, "正常 payload 应传递");

    // 非 payload 事件不受影响
    originalCalled = false;
    fakeConn.emit("message", null);
    assert.equal(originalCalled, true, "非 payload 事件应正常传递");
  });
});
