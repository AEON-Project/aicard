import { resolve } from "../config.mjs";
import { POLL_INTERVAL, MAX_POLLS } from "../constants.mjs";
import { sanitizeOutput } from "../sanitize.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function status(opts) {
  const { default: axios } = await import("axios");
  const serviceUrl = resolve(opts.serviceUrl, "AGENT_PAY_SERVICE_URL", "serviceUrl");
  const { orderNo, poll } = opts;

  if (!serviceUrl) {
    emitErr("status", "SERVICE_URL_MISSING", {
      message: "Missing service URL. This should not happen — default is built-in. Run: aicard setup --service-url <url> to override.",
    });
    return;
  }

  const url = `${serviceUrl}/open/ai/x402/card/status?orderNo=${encodeURIComponent(orderNo)}`;

  if (!poll) {
    try {
      const res = await axios.get(url);
      const sanitized = sanitizeOutput(res.data);
      emitOk("status", sanitized, sanitized);
    } catch (error) {
      emitErr("status", "SERVICE_UNAVAILABLE", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
    }
    return;
  }

  // 轮询模式
  logInfo(`Polling ${url} every ${POLL_INTERVAL / 1000}s (max ${MAX_POLLS} times)`);

  for (let i = 1; i <= MAX_POLLS; i++) {
    try {
      const res = await axios.get(url);
      const model = res.data?.model;

      logInfo(
        `[${i}/${MAX_POLLS}] orderStatus=${model?.orderStatus} channelStatus=${model?.channelStatus} cardStatus=${model?.cardStatus || "-"}`,
      );

      if (model?.orderStatus === "SUCCESS" || model?.orderStatus === "FAIL") {
        const sanitized = sanitizeOutput(res.data);
        emitOk("status", sanitized, sanitized);
        return;
      }
    } catch (e) {
      logInfo(`[${i}/${MAX_POLLS}] Error: ${e.message}`);
    }

    if (i < MAX_POLLS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  emitErr("status", "POLL_TIMEOUT", {
    orderNo,
    message: "Polling timeout. Card may still be provisioning.",
  });
}
