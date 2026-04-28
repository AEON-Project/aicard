/**
 * WalletConnect v2 封装模块
 * 用于通过 WalletConnect 协议连接用户钱包并发起交易
 */
import { SignClient } from "@walletconnect/sign-client";
import { encodeFunctionData, parseUnits } from "viem";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { createServer } from "http";
import { WC_CONNECT_TIMEOUT_MS, ERC20_TRANSFER_ABI, DEFAULT_WC_PROJECT_ID } from "./constants.mjs";
import { loadConfig, saveConfig } from "./config.mjs";

// ============== 状态同步服务器（供浏览器页面轮询） ==============

let _status = { state: "waiting_scan" };
let _server = null;
let _port = null;

export function startStatusServer() {
  _status = { state: "waiting_scan", ts: Date.now() };
  return new Promise((resolve) => {
    _server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/status") {
        res.end(JSON.stringify(_status));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    _server.listen(0, "127.0.0.1", () => {
      _port = _server.address().port;
      resolve(_port);
    });
  });
}

export function setStatus(state, extra = {}) {
  _status = { state, ...extra, ts: Date.now() };
}

export function stopStatusServer() {
  if (_server) {
    try { _server.close(); } catch {}
    _server = null;
    _port = null;
  }
}

const BSC_CHAIN_ID = "eip155:56";

// QR 页面倒计时（与 WalletConnect 连接超时一致）
const QR_EXPIRE_MS = 5 * 60 * 1000;

/**
 * 生成 QR 码 HTML 页面并在浏览器中打开（按 Figma Ai card v1.2 设计稿）
 * @param {string} uri - WalletConnect URI
 * @param {number} statusPort - 状态服务端口
 * @param {string|null} amount - 用户需要支付的 USDT 数量（如 "0.66"）
 */
function openQRInBrowser(uri, statusPort, amount, token = "USDT", network = "BNB Chain(BEP20) only") {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AEON — Wallet Connect</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
    justify-content: flex-start; padding-top: 40px;
    background: #f7f7f7; color: #191b1f;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .logo { margin-bottom: 24px; }
  .outer {
    width: 375px; min-height: 468px; border-radius: 16px; border: 1px solid #DBDEE3;
    background: #F7F7F7; padding: 16px;
    display: flex; flex-direction: column;
  }
  .card {
    text-align: center; padding: 24px 16px 16px; border-radius: 12px; background: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    flex: 1;
  }
  .title { font-size: 18px; font-weight: 700; color: #191b1f; margin-bottom: 16px; line-height: 1.4; }
  .info-card { width: 100%; border-radius: 8px; background: #f4f5f5; margin-bottom: 16px; overflow: hidden; }
  .info-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; }
  .info-row + .info-row { border-top: 1px solid #e5e7eb; }
  .info-label { font-size: 14px; font-weight: 400; color: #737a86; }
  .info-value { font-size: 14px; font-weight: 600; color: #191b1f; display: flex; align-items: center; gap: 6px; }
  .info-value.green { color: #00b42a; }
  .usdt-icon { width: 18px; height: 18px; flex-shrink: 0; }
  .timer { display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 14px; font-weight: 400; color: #737a86; margin-top: 8px; margin-bottom: 16px; }
  .timer svg { flex-shrink: 0; }
  .qr-wrap { position: relative; padding: 12px; display: inline-block; }
  .qr-border, .qr-border-bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
  .qr-border path { fill: none; stroke: #191b1f; stroke-width: 2;
    stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
  .qr-border-bg path { fill: none; stroke: #e5e5e5; stroke-width: 2; }
  canvas { display: block; border-radius: 8px; }
  .status-row { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-bottom: 24px; }
  .loading-icon { width: 24px; height: 24px; animation: spin 1s steps(8) infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-text { font-size: 14px; font-weight: 400; color: #00b42a; }
  .check-icon { width: 24px; height: 24px; border-radius: 50%; background: #00b42a; display: flex; align-items: center; justify-content: center; }
  .check-icon svg { width: 14px; height: 14px; }
  .hint-bar {
    display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 12px;
    background: #f4f5f5; font-size: 12px; color: #737a86; line-height: 1.5; text-align: left; width: 100%;
  }
  .hint-bar svg { flex-shrink: 0; margin-top: 1px; }
  .result-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 40px 24px; }
  .result-title { font-size: 18px; font-weight: 500; color: #191b1f; }
  .result-sub { font-size: 14px; color: #191b1f; line-height: 1.6; text-align: center; }
  a { color: #1972f6; text-decoration: none; font-size: 12px; word-break: break-all; }
</style>
<script src="https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js"><\/script>
</head><body>

<!-- AEON Logo -->
<div class="logo">
  <svg width="107" height="32" viewBox="0 0 107 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M24.5998 6.40881C23.6571 4.14639 21.5106 2.81204 17.1887 4.61043C18.813 5.03098 20.2924 5.63972 21.6267 6.36533C22.4678 6.13297 23.4251 6.08949 24.5998 6.40881Z" fill="#58F287"/>
    <path d="M5.87611 9.25164C6.2097 8.35211 6.87681 7.25011 8.21109 6.61215C8.61717 6.42327 9.08127 6.27856 9.61794 6.1916H9.90797C9.99501 6.1916 10.082 6.1916 10.169 6.16238C10.5461 6.13317 10.9522 6.13317 11.3873 6.16238C11.5033 6.16238 11.6049 6.16238 11.7208 6.1916C12.0109 6.22013 12.301 6.27856 12.62 6.33631C12.678 6.33631 12.7506 6.36553 12.8086 6.3798C12.8521 6.3798 12.9101 6.37979 12.9536 6.409C13.0987 6.43822 13.2582 6.48171 13.4177 6.52519C13.4757 6.52519 13.5192 6.55373 13.5772 6.56867C13.6353 6.56867 13.6787 6.5972 13.7368 6.61215C13.8383 6.64068 13.9253 6.6699 14.0269 6.69911C14.1139 6.72765 14.1864 6.7426 14.2734 6.77113C14.491 6.84383 14.694 6.91652 14.9261 6.98922C15.013 7.01776 15.1001 7.04697 15.1871 7.09045C15.2741 7.11967 15.3756 7.16315 15.4771 7.19236C18.8854 8.52603 23.5264 12.8627 24.6866 13.9939C24.6866 13.9939 24.6866 13.9647 24.7011 13.9361C24.8751 13.3124 25.0347 12.5291 25.1217 11.688C25.2232 10.7307 25.2522 9.70141 25.1362 8.70065C23.0913 7.07619 20.4372 5.43746 17.1886 4.61062H17.145C17.087 4.61062 17.0145 4.58141 16.9565 4.56714C16.826 4.53792 16.6954 4.50871 16.5649 4.48017C15.5207 4.24782 14.433 4.10311 13.2872 4.05962C7.68904 3.87075 5.93413 7.17741 5.57153 10.4698C5.60054 10.2375 5.68758 9.78837 5.87611 9.26591V9.25164Z" fill="#58F287"/>
    <path d="M6.9059 24.7405C6.13722 24.1603 5.26704 23.1887 5.06396 21.7531C5.00594 21.3176 5.00594 20.8393 5.09297 20.3169C5.09297 20.2883 5.09297 20.2448 5.10751 20.2156C5.10751 20.1721 5.12198 20.1137 5.13652 20.0702V20.0417C5.15099 19.9547 5.16553 19.882 5.19454 19.7951C5.28151 19.4323 5.41209 19.0552 5.58608 18.6639C5.62963 18.562 5.67312 18.4607 5.7166 18.3588C5.83264 18.0979 5.97769 17.837 6.13722 17.5761C6.16623 17.5177 6.19524 17.46 6.23872 17.4165C6.26773 17.373 6.28227 17.3295 6.31121 17.286C6.39825 17.1556 6.47081 17.0251 6.55777 16.894C6.58678 16.8505 6.61579 16.807 6.6448 16.7636C6.67381 16.7201 6.70282 16.6766 6.73183 16.6331C6.78985 16.5462 6.84788 16.4735 6.9059 16.3865C6.94938 16.3145 7.0074 16.256 7.05088 16.1834C7.1814 16.0094 7.32645 15.8355 7.4715 15.6473C7.52952 15.5746 7.58754 15.5019 7.6455 15.4292C7.70352 15.3572 7.77608 15.2702 7.8341 15.1975C10.1981 12.4419 15.8397 9.48306 17.3046 8.72892C17.2901 8.72892 17.2756 8.72892 17.2611 8.70039C16.7099 8.33758 15.9993 7.96051 15.2016 7.61266C14.3024 7.22064 13.3018 6.88705 12.301 6.66964C10.082 8.06175 7.67451 10.0341 5.86165 12.7897C5.86165 12.7897 5.86165 12.8189 5.84718 12.8189C5.81817 12.8767 5.77462 12.9202 5.74561 12.9786C5.67312 13.0948 5.60062 13.196 5.52806 13.3122C4.99147 14.211 4.49835 15.1833 4.10675 16.2418C2.19238 21.3903 4.87543 24.0298 7.96461 25.3934C7.74707 25.2915 7.32645 25.0741 6.89136 24.7405H6.9059Z" fill="#58F287"/>
    <path d="M22.2928 28.5546C21.4806 29.0913 20.2769 29.6131 18.8121 29.3522C18.377 29.2795 17.8983 29.1205 17.4198 28.8882C17.3907 28.8882 17.3617 28.859 17.3327 28.8447C17.2892 28.8155 17.2457 28.8012 17.1877 28.772H17.1587C17.0862 28.7285 17.0137 28.685 16.9412 28.6416C16.6221 28.4384 16.2885 28.2067 15.955 27.9309C15.8679 27.8582 15.7809 27.7862 15.7084 27.7135C15.4909 27.5246 15.2878 27.3072 15.0702 27.0898C15.0268 27.0463 14.9833 27.0028 14.9397 26.9451C14.9107 26.9159 14.8672 26.8724 14.8382 26.8289C14.7367 26.7127 14.6351 26.5966 14.5336 26.4661C14.5046 26.4226 14.4611 26.3791 14.4321 26.3357C14.4031 26.2922 14.3596 26.2487 14.3306 26.2052C14.2726 26.1325 14.2001 26.0455 14.142 25.9586C14.0985 25.8859 14.0405 25.8281 13.997 25.7554C13.8665 25.5815 13.7359 25.3933 13.6054 25.2044C13.5474 25.1317 13.5039 25.0448 13.4459 24.9721C13.3879 24.8851 13.3444 24.8131 13.2864 24.7261C11.3429 21.6804 10.1972 15.5161 9.9217 13.9358C9.90716 13.9358 9.89269 13.9644 9.87815 13.9644C9.35603 14.3706 8.76141 14.9074 8.18133 15.5453C7.52863 16.256 6.89053 17.0828 6.36841 17.9532C7.03558 20.433 8.21028 23.2899 10.3423 25.8281C10.3423 25.8281 10.3568 25.8281 10.3713 25.8574C10.4147 25.9008 10.4583 25.9586 10.4873 26.0021C10.5743 26.104 10.6613 26.2052 10.7483 26.3064C11.4445 27.0898 12.2421 27.8297 13.1559 28.5254C17.5648 31.8905 20.973 30.2225 23.25 27.7712C23.0759 27.9458 22.7424 28.2645 22.2782 28.5689L22.2928 28.5546Z" fill="#58F287"/>
    <path d="M20.6251 3.50778C21.5968 3.53699 22.8875 3.81283 23.9173 4.87134C24.2218 5.19066 24.5119 5.582 24.7585 6.04604L24.8019 6.133C24.831 6.17649 24.8454 6.21997 24.8744 6.2784V6.30693C24.9035 6.37962 24.947 6.45232 24.976 6.53929C25.121 6.88714 25.237 7.26421 25.3385 7.68476C25.3676 7.78667 25.3821 7.90218 25.4111 8.00409C25.4691 8.27993 25.5126 8.56935 25.5416 8.8744C25.5416 8.93215 25.5561 9.00485 25.5561 9.0626V9.20799C25.5561 9.35271 25.5851 9.51236 25.5851 9.67203V10.5423C25.5851 10.7598 25.5851 10.9772 25.5706 11.2095C25.5706 11.2965 25.5706 11.3977 25.5561 11.4847C25.5561 11.5866 25.5561 11.6878 25.5416 11.7748C25.2951 15.3573 22.5104 20.9991 21.7708 22.4347H21.8288C22.496 22.4054 23.2936 22.3042 24.1493 22.1303C25.1065 21.9271 26.1218 21.637 27.0644 21.2165C28.0216 18.8236 28.7903 15.8356 28.5873 12.5581V12.3258C28.5873 12.1953 28.5728 12.0649 28.5582 11.9344C28.4567 10.9045 28.2682 9.83169 27.9491 8.75823C26.3973 3.49352 22.6555 2.89903 19.3198 3.56621C19.5663 3.52273 20.0159 3.4643 20.5815 3.47924L20.6251 3.50778Z" fill="#58F287"/>
    <path d="M17.3472 28.4968C19.4646 29.7877 22.1186 29.236 24.1636 26.0748C22.5973 26.6693 21.0309 27.0171 19.5226 27.206C18.986 27.8732 18.4929 28.0763 17.3472 28.4968Z" fill="#58F287"/>
    <path d="M29.1829 20.0268C31.0973 18.4608 31.3293 15.6032 29.0089 12.9202C29.1104 14.5596 28.9653 16.1256 28.6753 17.5762C29.1539 18.2868 29.1249 18.8378 29.1829 20.0268Z" fill="#58F287"/>
    <path d="M9.54436 6.52511C7.09334 6.93072 5.46902 9.2801 6.13612 12.7614C6.87579 11.2966 7.77499 10.0057 8.76121 8.88876C8.70319 8.03339 8.99323 7.56868 9.54436 6.52511Z" fill="#58F287"/>
    <path d="M30.7774 15.4444C31.0529 16.3582 31.1834 17.6484 30.4728 18.925C30.2552 19.3164 29.9797 19.6934 29.5881 20.0705L29.5156 20.1432C29.4721 20.1724 29.4431 20.2159 29.3996 20.2451H29.3706C29.3126 20.3028 29.2401 20.3606 29.1821 20.4041C28.892 20.6364 28.5584 20.8681 28.1814 21.1005C28.0798 21.1582 27.9928 21.2167 27.8913 21.2601C27.6447 21.3906 27.3691 21.5353 27.0791 21.6515C27.0211 21.6807 26.963 21.7099 26.905 21.7242C26.8615 21.7242 26.8181 21.7676 26.76 21.7819C26.615 21.8403 26.4699 21.8981 26.325 21.9558C26.2814 21.9558 26.2234 22 26.1654 22.0143C26.1074 22.0143 26.0639 22.0578 26.0058 22.072C25.9043 22.1012 25.8173 22.1447 25.7158 22.1739C25.6288 22.2025 25.5563 22.2317 25.4692 22.246C25.2517 22.3186 25.0342 22.3771 24.8166 22.4348C24.7296 22.464 24.6426 22.4783 24.541 22.5075C24.4395 22.5361 24.3525 22.551 24.251 22.5795C20.6832 23.4499 14.3309 22.6088 12.7065 22.3621C12.7065 22.3621 12.7065 22.3913 12.7211 22.4206C12.9531 23.0293 13.3012 23.74 13.7363 24.4798C14.2294 25.3067 14.8385 26.162 15.5202 26.9019C18.1452 27.0466 21.2924 26.8435 24.4251 25.6403H24.4685C24.5266 25.611 24.5846 25.5961 24.6426 25.5676C24.7731 25.5241 24.8891 25.4656 25.0197 25.4079C25.9914 25.0016 26.9776 24.4941 27.9203 23.8561C32.5613 20.7961 31.9956 17.1124 30.2988 14.2405C30.4148 14.4437 30.6178 14.8642 30.7774 15.386V15.4444Z" fill="#58F287"/>
    <path d="M7.61539 21.9849C6.86125 21.7098 6.20862 21.2165 5.48349 20.3605C4.94682 22.6664 6.2521 24.8711 10.139 25.8426C8.35506 23.8995 7.89096 22.6813 7.60092 21.9849H7.61539Z" fill="#58F287"/>
    <path d="M10.4312 25.8859C10.2281 25.6542 10.0396 25.4218 9.85107 25.1752C10.0251 25.4218 10.2137 25.6542 10.4022 25.8716H10.4312V25.8859Z" fill="#58F287"/>
    <path d="M45.2697 10.4323L40.2219 25.8175H36.1558L43.0518 7.25813H45.6394L45.2697 10.4323ZM49.4634 25.8175L44.4029 10.4323L43.995 7.25813H46.6081L53.5424 25.8175H49.4634ZM49.234 18.9086V21.9041H39.4317V18.9086H49.234ZM67.7168 22.8349V25.8175H57.8382V22.8349H67.7168ZM59.087 7.25813V25.8175H55.2633V7.25813H59.087ZM66.4293 14.8172V17.723H57.8382V14.8172H66.4293ZM67.7039 7.25813V10.2536H57.8382V7.25813H67.7039ZM85.1931 16.1047V16.9838C85.1931 18.3943 85.0016 19.6607 84.619 20.7824C84.2365 21.9041 83.6971 22.86 83 23.6508C82.3036 24.4321 81.4707 25.0314 80.5019 25.4479C79.5419 25.8643 78.4752 26.0722 77.3025 26.0722C76.138 26.0722 75.072 25.8643 74.1032 25.4479C73.1425 25.0314 72.3103 24.4321 71.6044 23.6508C70.8991 22.86 70.3515 21.9041 69.9602 20.7824C69.5777 19.6607 69.3868 18.3943 69.3868 16.9838V16.1047C69.3868 14.6854 69.5777 13.419 69.9602 12.3061C70.3427 11.1844 70.8822 10.2278 71.5792 9.43766C72.2844 8.64752 73.1174 8.0442 74.0774 7.62773C75.0462 7.21125 76.1129 7.00335 77.2767 7.00335C78.4501 7.00335 79.516 7.21125 80.4767 7.62773C81.4455 8.0442 82.2778 8.64752 82.9749 9.43766C83.6801 10.2278 84.2243 11.1844 84.6061 12.3061C84.9975 13.419 85.1931 14.6854 85.1931 16.1047ZM81.3307 16.9838V16.0789C81.3307 15.093 81.241 14.2261 81.063 13.4788C80.8844 12.7307 80.6207 12.1016 80.2722 11.5921C79.9244 11.0818 79.4991 10.7 78.9976 10.4445C78.4962 10.1816 77.9228 10.0498 77.2767 10.0498C76.6313 10.0498 76.0579 10.1816 75.5565 10.4445C75.0632 10.7 74.6427 11.0818 74.2941 11.5921C73.9544 12.1016 73.6949 12.7307 73.5169 13.4788C73.3382 14.2261 73.2492 15.093 73.2492 16.0789V16.9838C73.2492 17.9615 73.3382 18.8277 73.5169 19.5846C73.6949 20.3319 73.9585 20.9651 74.307 21.4835C74.6556 21.9931 75.0802 22.3803 75.5816 22.6433C76.083 22.9069 76.6564 23.0387 77.3025 23.0387C77.9487 23.0387 78.5221 22.9069 79.0235 22.6433C79.5249 22.3803 79.9454 21.9931 80.2851 21.4835C80.6255 20.9651 80.8844 20.3319 81.063 19.5846C81.241 18.8277 81.3307 17.9615 81.3307 16.9838ZM103.051 7.25813V25.8175H99.2269L91.7705 13.3769V25.8175H87.9461V7.25813H91.7705L99.2399 19.7116V7.25813H103.051Z" fill="black"/>
  </svg>
</div>

<div class="outer">
  <div class="card" id="root">
    <div id="body"></div>
  </div>
</div>

<script>
  const URI = ${JSON.stringify(uri)};
  const AMOUNT = ${JSON.stringify(amount || null)};
  const TOKEN = ${JSON.stringify(token)};
  const NETWORK = ${JSON.stringify(network)};
  const STATUS_URL = "http://127.0.0.1:${statusPort}/status";
  const EXPIRE_MS = ${QR_EXPIRE_MS};
  const startTime = Date.now();

  // 倒计时 SVG 图标（Figma 导出 1:63 clock 16x16）- 使用 currentColor 跟随 .timer 颜色
  const CLOCK_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.667 8C14.667 11.68 11.68 14.667 8 14.667C4.32 14.667 1.334 11.68 1.334 8C1.334 4.32 4.32 1.333 8 1.333C11.68 1.333 14.667 4.32 14.667 8Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.476 10.12L8.409 8.887C8.049 8.674 7.756 8.16 7.756 7.74V5.007" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // 提示 info 图标（Figma 导出 1:43 Icon 20x20）
  const INFO_SVG = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path opacity="0.2" d="M10 18.333C14.6 18.333 18.331 14.602 18.331 10C18.331 5.397 14.6 1.666 10 1.666C5.395 1.666 1.664 5.397 1.664 10C1.664 14.602 5.395 18.333 10 18.333Z" fill="#737A86"/><path d="M10 13.333V10" stroke="#737A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 6.666H10.008" stroke="#737A86" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Loading 旋转图标（Figma 导出 1:50 loading-02 24x24）
  const LOADING_SVG = '<svg class="loading-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path opacity=".7" d="M4.922 5l2.828 2.828" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".6" d="M6 12H2" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".5" d="M4.922 19.078l2.828-2.828" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".4" d="M12 18v4" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".3" d="M19.078 19.078L16.25 16.25" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".2" d="M22 12h-4" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".1" d="M19.078 5L16.25 7.828" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/><path opacity=".8" d="M12 2v4" stroke="#191B1F" stroke-width="2.5" stroke-linecap="round"/></svg>';
  // 成功勾选
  const CHECK_SVG = '<div class="check-icon"><svg viewBox="0 0 14 14" fill="none"><path d="M3 7l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';

  // 超时插图 SVG（从 Figma 导出）
  const EXPIRED_SVG = \`<svg width="144" height="129" viewBox="0 0 144 129" fill="none" xmlns="http://www.w3.org/2000/svg">
<path opacity="0.1" d="M140.369 64.988C140.369 82.769 133.106 98.797 121.461 110.317C110.066 121.711 94.289 128.598 76.884 128.598C59.604 128.598 43.826 121.586 32.306 110.317C20.661 98.797 13.398 82.769 13.398 64.988C13.398 29.802 41.823 1.377 76.884 1.377C111.944 1.377 140.369 29.927 140.369 64.988Z" fill="#1A72F7"/>
<path d="M134.859 23.291C137.695 23.291 139.993 20.992 139.993 18.157C139.993 15.321 137.695 13.023 134.859 13.023C132.024 13.023 129.725 15.321 129.725 18.157C129.725 20.992 132.024 23.291 134.859 23.291Z" fill="#E8F1FE"/>
<path d="M141.496 5.009C142.879 5.009 144 3.887 144 2.504C144 1.121 142.879 0 141.496 0C140.113 0 138.991 1.121 138.991 2.504C138.991 3.887 140.113 5.009 141.496 5.009Z" fill="#E8F1FE"/>
<path d="M15.402 23.165C17.338 23.165 18.908 21.596 18.908 19.659C18.908 17.723 17.338 16.153 15.402 16.153C13.465 16.153 11.896 17.723 11.896 19.659C11.896 21.596 13.465 23.165 15.402 23.165Z" fill="#E8F1FE"/>
<path d="M5.635 90.157C8.747 90.157 11.27 87.634 11.27 84.522C11.27 81.41 8.747 78.887 5.635 78.887C2.523 78.887 0 81.41 0 84.522C0 87.634 2.523 90.157 5.635 90.157Z" fill="#E8F1FE"/>
<path d="M106.435 31.68C114.733 31.68 121.461 38.407 121.461 46.706V110.317C110.066 121.711 94.289 128.598 76.884 128.598C59.604 128.598 43.826 121.586 32.306 110.317V46.706C32.306 38.407 39.034 31.68 47.332 31.68H106.435Z" fill="white"/>
<path d="M76.383 82.644C86.756 82.644 95.165 74.235 95.165 63.861C95.165 53.488 86.756 45.079 76.383 45.079C66.009 45.079 57.6 53.488 57.6 63.861C57.6 74.235 66.009 82.644 76.383 82.644Z" fill="url(#pe)"/>
<path d="M75.708 53.393C76.824 53.393 77.742 54.312 77.742 55.428V63.129C77.742 63.319 77.832 63.627 78.015 63.95C78.2 64.274 78.418 64.505 78.577 64.597L78.583 64.601L84.403 68.074C85.39 68.652 85.673 69.904 85.114 70.864L85.104 70.879C84.708 71.513 84.038 71.869 83.352 71.869C83.013 71.868 82.648 71.79 82.306 71.566L76.495 68.099C74.859 67.122 73.673 65.02 73.673 63.129V55.428C73.673 54.312 74.592 53.393 75.708 53.393Z" fill="url(#ph)" filter="url(#fs)"/>
<path d="M88.529 92.286H65.238C63.855 92.286 62.734 93.407 62.734 94.79C62.734 96.173 63.855 97.294 65.238 97.294H88.529C89.912 97.294 91.033 96.173 91.033 94.79C91.033 93.407 89.912 92.286 88.529 92.286Z" fill="url(#pb1)"/>
<path d="M97.169 104.807H56.598C55.215 104.807 54.094 105.929 54.094 107.312C54.094 108.695 55.215 109.816 56.598 109.816H97.169C98.552 109.816 99.673 108.695 99.673 107.312C99.673 105.929 98.552 104.807 97.169 104.807Z" fill="url(#pb2)"/>
<defs>
<filter id="fs" x="71.169" y="52.141" width="16.733" height="23.484" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="bg"/><feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="a"/><feOffset dy="1.25"/><feGaussianBlur stdDeviation="1.25"/><feComposite in2="a" operator="out"/><feColorMatrix values="0 0 0 0 .98 0 0 0 0 .59 0 0 0 0 .2 0 0 0 .5 0"/><feBlend in2="bg" result="s"/><feBlend in="SourceGraphic" in2="s"/></filter>
<linearGradient id="pe" x1="123.339" y1="36.939" x2="27.548" y2="92.661" gradientUnits="userSpaceOnUse"><stop stop-color="#FF7D00"/><stop offset="1" stop-color="#FF7D00" stop-opacity="0"/></linearGradient>
<linearGradient id="ph" x1="78.327" y1="62.004" x2="70.624" y2="69.133" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></linearGradient>
<linearGradient id="pb1" x1="62.608" y1="92.035" x2="93.286" y2="92.286" gradientUnits="userSpaceOnUse"><stop stop-color="#DBDEE3" stop-opacity=".7"/><stop offset="1" stop-color="#DBDEE3"/></linearGradient>
<linearGradient id="pb2" x1="53.891" y1="104.557" x2="103.297" y2="105.207" gradientUnits="userSpaceOnUse"><stop stop-color="#DBDEE3" stop-opacity=".7"/><stop offset="1" stop-color="#DBDEE3"/></linearGradient>
</defs></svg>\`;

  // 拒绝插图 SVG（基于超时插图，替换时钟为 X 标记，橙色改红色）
  const REJECTED_SVG = \`<svg width="144" height="129" viewBox="0 0 144 129" fill="none" xmlns="http://www.w3.org/2000/svg">
<path opacity="0.1" d="M140.369 64.988C140.369 82.769 133.106 98.797 121.461 110.317C110.066 121.711 94.289 128.598 76.884 128.598C59.604 128.598 43.826 121.586 32.306 110.317C20.661 98.797 13.398 82.769 13.398 64.988C13.398 29.802 41.823 1.377 76.884 1.377C111.944 1.377 140.369 29.927 140.369 64.988Z" fill="#1A72F7"/>
<path d="M134.859 23.291C137.695 23.291 139.993 20.992 139.993 18.157C139.993 15.321 137.695 13.023 134.859 13.023C132.024 13.023 129.725 15.321 129.725 18.157C129.725 20.992 132.024 23.291 134.859 23.291Z" fill="#E8F1FE"/>
<path d="M141.496 5.009C142.879 5.009 144 3.887 144 2.504C144 1.121 142.879 0 141.496 0C140.113 0 138.991 1.121 138.991 2.504C138.991 3.887 140.113 5.009 141.496 5.009Z" fill="#E8F1FE"/>
<path d="M15.402 23.165C17.338 23.165 18.908 21.596 18.908 19.659C18.908 17.723 17.338 16.153 15.402 16.153C13.465 16.153 11.896 17.723 11.896 19.659C11.896 21.596 13.465 23.165 15.402 23.165Z" fill="#E8F1FE"/>
<path d="M5.635 90.157C8.747 90.157 11.27 87.634 11.27 84.522C11.27 81.41 8.747 78.887 5.635 78.887C2.523 78.887 0 81.41 0 84.522C0 87.634 2.523 90.157 5.635 90.157Z" fill="#E8F1FE"/>
<path d="M106.435 31.68C114.733 31.68 121.461 38.407 121.461 46.706V110.317C110.066 121.711 94.289 128.598 76.884 128.598C59.604 128.598 43.826 121.586 32.306 110.317V46.706C32.306 38.407 39.034 31.68 47.332 31.68H106.435Z" fill="white"/>
<circle cx="76.383" cy="63.861" r="18.783" fill="url(#pr)"/>
<path d="M69.383 56.861l14 14M83.383 56.861l-14 14" stroke="white" stroke-width="3" stroke-linecap="round"/>
<path d="M88.529 92.286H65.238C63.855 92.286 62.734 93.407 62.734 94.79C62.734 96.173 63.855 97.294 65.238 97.294H88.529C89.912 97.294 91.033 96.173 91.033 94.79C91.033 93.407 89.912 92.286 88.529 92.286Z" fill="url(#prb1)"/>
<path d="M97.169 104.807H56.598C55.215 104.807 54.094 105.929 54.094 107.312C54.094 108.695 55.215 109.816 56.598 109.816H97.169C98.552 109.816 99.673 108.695 99.673 107.312C99.673 105.929 98.552 104.807 97.169 104.807Z" fill="url(#prb2)"/>
<defs>
<linearGradient id="pr" x1="123.339" y1="36.939" x2="27.548" y2="92.661" gradientUnits="userSpaceOnUse"><stop stop-color="#F53F3F"/><stop offset="1" stop-color="#F53F3F" stop-opacity="0"/></linearGradient>
<linearGradient id="prb1" x1="62.608" y1="92.035" x2="93.286" y2="92.286" gradientUnits="userSpaceOnUse"><stop stop-color="#DBDEE3" stop-opacity=".7"/><stop offset="1" stop-color="#DBDEE3"/></linearGradient>
<linearGradient id="prb2" x1="53.891" y1="104.557" x2="103.297" y2="105.207" gradientUnits="userSpaceOnUse"><stop stop-color="#DBDEE3" stop-opacity=".7"/><stop offset="1" stop-color="#DBDEE3"/></linearGradient>
</defs></svg>\`;

  function short(s) { if (!s || s.length < 12) return s; return s.slice(0,6) + '...' + s.slice(-4); }

  function fmtTime(ms) {
    if (ms <= 0) return '00:00';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtAmount(v) {
    if (v == null || v === '') return '';
    // 完整显示原始金额（不做取整），去除末尾多余的 0，整数部分加千分位
    const s = String(v);
    const neg = s.startsWith('-') ? '-' : '';
    const body = neg ? s.slice(1) : s;
    let [intPart, decPart] = body.split('.');
    if (decPart) decPart = decPart.replace(/0+$/, '');
    const intWithComma = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg + intWithComma + (decPart ? '.' + decPart : '') + ' ' + TOKEN;
  }

  // ====== 页面渲染函数 ======

  function renderQR(data) {
    const remaining = Math.max(0, EXPIRE_MS - (Date.now() - startTime));
    const isWaiting = !data || data.state === 'waiting_scan';
    const isConnected = data && (data.state === 'connected' || data.state === 'signing' || data.state === 'tx_submitted');
    const isConfirmed = data && data.state === 'confirmed';

    let statusHTML = '';
    if (isConfirmed) {
      statusHTML = '<div class="status-row">' + CHECK_SVG + '<div class="status-text">Waiting for results...</div></div>';
    } else {
      statusHTML = '<div class="status-row">' + LOADING_SVG + '<div class="status-text">Waiting for results...</div></div>';
    }

    const expireMin = Math.ceil(remaining / 60000);

    // QR wrap: 圆角矩形路径从12点（顶部中心）出发，顺时针绘制
    // canvas 200 + padding 12*2 = 224, 圆角 r=16, 描边偏移1px
    const S = 224, R = 16, cx = S/2;
    // 从顶部中心开始，顺时针绘制一圈回到起点（开放路径，不用 Z 闭合，避免 dash 环绕）
    const qrPath = 'M' + cx + ',1 H' + (S-1-R) + ' A' + R + ',' + R + ' 0 0 1 ' + (S-1) + ',' + (1+R) +
      ' V' + (S-1-R) + ' A' + R + ',' + R + ' 0 0 1 ' + (S-1-R) + ',' + (S-1) +
      ' H' + (1+R) + ' A' + R + ',' + R + ' 0 0 1 1,' + (S-1-R) +
      ' V' + (1+R) + ' A' + R + ',' + R + ' 0 0 1 ' + (1+R) + ',1 H' + cx;
    // 用 pathLength=1000 统一长度，避免手算偏差
    const PL = 1000;
    const progress = remaining / EXPIRE_MS;
    const dashOffset = -PL * (1 - progress);

    // USDT 图标 SVG（绿色圆形 Tether 标志）
    const USDT_ICON = '<svg class="usdt-icon" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="9" fill="#26A17B"/><path d="M10.1 9.6c-.06 0-.33.02-.73.02-.32 0-.58-.01-.67-.02-1.32-.06-2.3-.3-2.3-.58 0-.29.98-.52 2.3-.58v.93c.09.01.36.02.68.02.38 0 .66-.01.72-.02v-.93c1.31.06 2.29.3 2.29.58 0 .28-.98.52-2.29.58zm0-.87v-.83h2.05V6.5H5.88v1.4h2.05v.83c-1.48.07-2.6.38-2.6.75 0 .37 1.12.68 2.6.75v2.69h1.07v-2.69c1.48-.07 2.59-.38 2.59-.75 0-.37-1.11-.68-2.59-.75z" fill="#fff"/></svg>';
    // BNB 图标 SVG（黄色圆形 BNB 标志）
    const BNB_ICON = '<svg class="usdt-icon" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="9" fill="#F3BA2F"/><path d="M9 4.5L7.2 6.3l-1.8-1.8L9 1.2l3.6 3.3-1.8 1.8L9 4.5zm-4.5 4.5L2.7 7.2 4.5 5.4l1.8 1.8L4.5 9zm4.5 4.5l-1.8-1.8-1.8 1.8L9 16.8l3.6-3.3-1.8-1.8L9 13.5zm4.5-4.5l1.8 1.8-1.8 1.8-1.8-1.8 1.8-1.8zM10.8 9L9 7.2 7.2 9 9 10.8 10.8 9z" fill="#fff"/></svg>';
    const TOKEN_ICON = TOKEN === 'BNB' ? BNB_ICON : USDT_ICON;

    const infoCardHTML = AMOUNT ? '<div class="info-card">' +
      '<div class="info-row"><span class="info-label">Amount</span><span class="info-value green">' + TOKEN_ICON + fmtAmount(AMOUNT) + '</span></div>' +
      '<div class="info-row"><span class="info-label">Network</span><span class="info-value">' + NETWORK + '</span></div>' +
      '</div>' : '';

    return '<div class="title">Scan the QR code with your wallet<br>to authorize transfer</div>' +
      infoCardHTML +
      '<div class="qr-wrap" style="width:' + S + 'px;height:' + S + 'px;">' +
        '<svg class="qr-border-bg" viewBox="0 0 ' + S + ' ' + S + '"><path d="' + qrPath + '"/></svg>' +
        '<svg class="qr-border" viewBox="0 0 ' + S + ' ' + S + '"><path id="qr-progress" d="' + qrPath + '" pathLength="' + PL + '" stroke-dasharray="' + PL + '" stroke-dashoffset="' + dashOffset.toFixed(1) + '"/></svg>' +
        '<canvas id="qr" style="position:relative;"></canvas>' +
      '</div>' +
      '<div class="timer">' + CLOCK_SVG + ' ' + fmtTime(remaining) + ' Remaining</div>' +
      statusHTML +
      '<div class="hint-bar">' + INFO_SVG + '<span>Expire in ' + expireMin + ' mins. This page will close automatically once the transfer is completed</span></div>';
  }

  function renderExpired() {
    return '<div class="result-card">' + EXPIRED_SVG +
      '<div class="result-title">Request expired</div>' +
      '<div class="result-sub">This request has expired. Ask agent to send a new one</div></div>';
  }

  function renderRejected() {
    return '<div class="result-card">' + REJECTED_SVG +
      '<div class="result-title">Request rejected</div>' +
      '<div class="result-sub">You have rejected this request. Ask agent to send a new one</div></div>';
  }

  function renderFailed(error) {
    return '<div class="result-card">' + REJECTED_SVG +
      '<div class="result-title">Transaction failed</div>' +
      '<div class="result-sub">' + (error || 'Something went wrong.') + '<br>Please try again.</div></div>';
  }

  // ====== 状态机 ======

  const FINAL = ['confirmed', 'rejected', 'failed', 'expired'];
  let lastState = null;
  let stopped = false;
  let closeTimer = null;
  let timerInterval = null;

  function renderConfirmed() {
    return '<div class="result-card">' + CHECK_SVG +
      '<div class="result-title">Transfer completed</div>' +
      '<div class="result-sub">You can close this page now</div></div>';
  }

  function render(data) {
    const body = document.getElementById('body');
    const state = data ? data.state : 'waiting_scan';

    if (state === 'confirmed') {
      body.innerHTML = renderConfirmed();
      stopTimer();
    } else if (state === 'expired') {
      body.innerHTML = renderExpired();
      stopTimer();
    } else if (state === 'rejected') {
      body.innerHTML = renderRejected();
      stopTimer();
    } else if (state === 'failed') {
      body.innerHTML = renderFailed(data.error);
      stopTimer();
    } else {
      body.innerHTML = renderQR(data);
      // 渲染 QR 码
      const qrEl = document.getElementById('qr');
      if (qrEl) {
        new QRious({ element: qrEl, value: URI, size: 200, backgroundAlpha: 1, background: '#ffffff', foreground: '#000000', level: 'M' });
      }
    }
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function maybeAutoClose(state) {
    if (closeTimer || !FINAL.includes(state)) return;
    let n = 5;
    const tick = () => {
      if (n-- <= 0) { try { window.close(); } catch {} return; }
      closeTimer = setTimeout(tick, 1000);
    };
    closeTimer = setTimeout(tick, 1000);
  }

  // 初始渲染
  render(null);

  // 倒计时刷新（每秒更新 timer）
  timerInterval = setInterval(() => {
    const remaining = EXPIRE_MS - (Date.now() - startTime);
    // 后端已进入活跃状态（已连接/签名中/交易已提交），不触发页面过期
    const ACTIVE = ['connected', 'signing', 'tx_submitted'];
    if (remaining <= 0 && !FINAL.includes(lastState) && !ACTIVE.includes(lastState)) {
      lastState = 'expired';
      render({ state: 'expired' });
      maybeAutoClose('expired');
      return;
    }
    // 更新倒计时文字
    const timerEl = document.querySelector('.timer');
    if (timerEl) {
      const expireMin = Math.ceil(Math.max(0, remaining) / 60000);
      timerEl.innerHTML = CLOCK_SVG + ' ' + fmtTime(remaining) + ' Remaining';
      const hintSpan = document.querySelector('.hint-bar span');
      if (hintSpan) hintSpan.textContent = 'Expire in ' + expireMin + ' mins. This page will close automatically once the transfer is completed';
    }
    // 更新 QR 边框倒计时进度（负值 → 从12点顺时针消失）
    const progressEl = document.getElementById('qr-progress');
    if (progressEl) {
      const PL = 1000;
      const progress = Math.max(0, remaining) / EXPIRE_MS;
      progressEl.setAttribute('stroke-dashoffset', (-PL * (1 - progress)).toFixed(1));
    }
  }, 1000);

  // 轮询后端状态
  async function poll() {
    if (stopped) return;
    try {
      const r = await fetch(STATUS_URL);
      const data = await r.json();
      if (data.state !== lastState) {
        lastState = data.state;
        render(data);
        maybeAutoClose(data.state);
        if (FINAL.includes(data.state)) { stopped = true; stopTimer(); return; }
      }
    } catch (e) {
      if (FINAL.includes(lastState)) { stopped = true; stopTimer(); return; }
    }
    setTimeout(poll, 800);
  }
  poll();
<\/script>
</body></html>`;

  const filePath = join(tmpdir(), "aicard-qr.html");
  writeFileSync(filePath, html);

  const cmd = process.platform === "darwin" ? "open" :
              process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${cmd} ${filePath}`, { stdio: "ignore" });
  } catch {
    console.error(`Open this file in your browser: ${filePath}`);
  }
}

/**
 * 初始化 WalletConnect SignClient
 * @param {string} projectId - WalletConnect Cloud project ID
 */
export async function initSignClient(projectId) {
  const INIT_TIMEOUT_MS = 15_000;
  const client = await Promise.race([
    SignClient.init({
      projectId,
      metadata: {
        name: "aicard",
        description: "Virtual debit card via x402 protocol",
        url: "https://github.com/AEON-Project/aicard",
        icons: [],
      },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("WalletConnect init timed out (15s). Check your network connection.")), INIT_TIMEOUT_MS)
    ),
  ]);

  // WalletConnect relay 偶发 null WebSocket 帧，导致 isJsonRpcPayload('id' in null) 崩溃
  // 在 connection 层过滤掉 null payload，避免错误传播到 provider / request 链路
  try {
    const conn = client.core.relayer.provider.connection;
    const _origEmit = conn.emit.bind(conn);
    conn.emit = function (event, ...args) {
      if (event === "payload" && args[0] == null) {
        console.error("[WC guard] Intercepted null WebSocket frame, skipped.");
        return false;
      }
      return _origEmit(event, ...args);
    };
  } catch {}

  // 清理残留 session + pairing（并行等待完成，确保 relay 状态干净后再建新连接）
  try {
    const sessions = client.session.getAll();
    if (sessions.length > 0) {
      await Promise.allSettled(
        sessions.map(s =>
          client.disconnect({ topic: s.topic, reason: { code: 6000, message: "Cleanup" } }).catch(() => {})
        )
      );
    }
  } catch {}
  try {
    const pairings = client.core.pairing.pairings.getAll({ active: true });
    if (pairings.length > 0) {
      await Promise.allSettled(
        pairings.map(p =>
          client.core.pairing.disconnect({ topic: p.topic }).catch(() => {})
        )
      );
    }
  } catch {}

  return client;
}

/**
 * 连接钱包：展示 QR 码，等待用户扫码授权
 * @param {SignClient} signClient
 * @param {number} statusPort
 * @param {string|null} amount - 需要展示的 USDT 金额（如 "0.66"）
 * @returns {{ session: object, peerAddress: string }}
 */
export async function connectWallet(signClient, statusPort, amount = null, token = "USDT") {
  const { uri, approval } = await signClient.connect({
    optionalNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction"],
        chains: [BSC_CHAIN_ID],
        events: ["chainChanged", "accountsChanged"],
      },
    },
  });

  // 生成 QR 码页面（含状态轮询）并在浏览器中打开
  openQRInBrowser(uri, statusPort, amount, token);
  console.error("QR code opened in browser. Scan it with your wallet app.");
  console.error("Waiting for wallet approval...");

  const session = await Promise.race([
    approval(),
    new Promise((_, reject) =>
      setTimeout(
        () => {
          setStatus("expired");
          reject(new Error("WalletConnect connection timed out. Please try again."));
        },
        WC_CONNECT_TIMEOUT_MS,
      ),
    ),
  ]);

  const accounts = session.namespaces.eip155.accounts;
  const peerAddress = accounts[0].split(":")[2];
  setStatus("connected", { peerAddress });
  return { session, peerAddress };
}

/**
 * 请求 ERC-20 代币转账
 * @param {SignClient} signClient
 * @param {object} session - WalletConnect session
 * @param {{ from: string, to: string, token: string, amount: string, decimals?: number }} params
 * @returns {string} 交易 hash
 */
export async function requestERC20Transfer(signClient, session, { from, to, token, amount, decimals = 18 }) {
  const value = parseUnits(amount, decimals);
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, value],
  });

  const TX_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
  const txHash = await Promise.race([
    signClient.request({
      topic: session.topic,
      chainId: BSC_CHAIN_ID,
      request: {
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: token,
            data,
            gas: "0xFDE8", // 65000 — ERC20 transfer 合约调用
          },
        ],
      },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Payment approval timed out. Please try again.")), TX_REQUEST_TIMEOUT_MS)
    ),
  ]);

  return txHash;
}

/**
 * 请求原生 BNB 转账
 * @param {SignClient} signClient
 * @param {object} session
 * @param {{ from: string, to: string, value: string }} params - value 为 BNB 数量（如 "0.001"）
 * @returns {string} 交易 hash
 */
export async function requestNativeTransfer(signClient, session, { from, to, value }) {
  const weiValue = "0x" + parseUnits(value, 18).toString(16);

  const TX_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
  const txHash = await Promise.race([
    signClient.request({
      topic: session.topic,
      chainId: BSC_CHAIN_ID,
      request: {
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to,
            value: weiValue,
            gas: "0x5208", // 21000 — BNB 原生转账固定 gas
          },
        ],
      },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Payment approval timed out. Please try again.")), TX_REQUEST_TIMEOUT_MS)
    ),
  ]);

  return txHash;
}

const FINAL_LINGER_MS = 2000;

/**
 * 通用钱包连接高阶函数：自动管理连接生命周期
 * - 启动状态服务器
 * - 扫码连接钱包
 * - 执行调用方的事务逻辑
 * - 无论成功失败，始终断开连接并清理
 *
 * @param {{ amount?: string, projectId?: string }} opts
 * @param {(ctx: { signClient, session, peerAddress }) => Promise<void>} fn
 */
export async function withWallet(opts, fn) {
  const { amount = null, token = "USDT", projectId = DEFAULT_WC_PROJECT_ID } = opts;
  const statusPort = await startStatusServer();
  let signClient = null;
  let session = null;
  let exitCode = 0;
  let errorPayload = null;

  try {
    signClient = await initSignClient(projectId);
    let peerAddress;
    ({ session, peerAddress } = await connectWallet(signClient, statusPort, amount, token));
    console.error(`Wallet connected: ${peerAddress}`);

    await fn({ signClient, session, peerAddress });

    // 成功：写回 mainWallet
    const config = loadConfig();
    config.mainWallet = peerAddress;
    saveConfig(config);
  } catch (error) {
    normalizeWalletError(error);
    const isRejected = error.message?.includes("rejected") || error.code === 5000;
    const isTimeout = error.message?.includes("timed out");

    if (isTimeout) {
      setStatus("expired");
      errorPayload = { error: "Payment approval timed out. Please try again." };
    } else if (isRejected) {
      setStatus("rejected", { error: "Payment approval was rejected." });
      errorPayload = { error: "Payment approval was rejected. Please try again if you'd like to proceed." };
    } else {
      setStatus("failed", { error: error.message });
      errorPayload = { error: `Wallet operation failed: ${error.message}` };
    }
    exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, FINAL_LINGER_MS));
    stopStatusServer();
    if (signClient) {
      // 断开当前 session
      if (session) {
        await disconnectSession(signClient, session);
      }
      // 断开所有 pairing，确保钱包端不残留连接
      try {
        const pairings = signClient.core.pairing.pairings.getAll({ active: true });
        await Promise.allSettled(
          pairings.map(p =>
            signClient.core.pairing.disconnect({ topic: p.topic }).catch(() => {})
          )
        );
      } catch {}
    }
  }

  if (exitCode !== 0) {
    console.error(JSON.stringify(errorPayload));
    process.exit(exitCode);
  }
}

/**
 * 标准化钱包错误消息：将已知的中文/多语言错误映射为统一英文
 * @param {Error} error
 * @returns {Error} 同一个 error 对象，message 已替换
 */
export function normalizeWalletError(error) {
  const msg = error?.message || "";
  const patterns = [
    // 拒绝类
    { test: /拒绝|用户取消|User rejected|User denied|declined/i, replacement: "rejected" },
    // 断开连接类
    { test: /断开.*连接|断开.*DApp|disconnect.*DApp|session.*expired|session.*disconnected/i, replacement: "rejected" },
    // 超时类
    { test: /超时|timed?\s*out|timeout/i, replacement: "timed out" },
  ];
  for (const { test, replacement } of patterns) {
    if (test.test(msg)) {
      error.message = replacement;
      return error;
    }
  }
  return error;
}

/**
 * 断开 WalletConnect 会话
 * @param {SignClient} signClient
 * @param {object} session
 */
export async function disconnectSession(signClient, session) {
  try {
    await signClient.disconnect({
      topic: session.topic,
      reason: { code: 6000, message: "Session complete" },
    });
  } catch {
    // 静默处理断开错误
  }
}
