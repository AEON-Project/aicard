import { resolve } from "../config.mjs";
import { POLL_INTERVAL, MAX_POLLS } from "../constants.mjs";
import { sanitizeOutput } from "../sanitize.mjs";

export async function status(opts) {
  const { default: axios } = await import("axios");
  const serviceUrl = resolve(opts.serviceUrl, "X402_CARD_SERVICE_URL", "serviceUrl");
  const { orderNo, poll } = opts;

  if (!serviceUrl) {
    console.error(JSON.stringify({ error: "Missing service URL. This should not happen — default is built-in. Run: aicard setup --service-url <url> to override." }));
    process.exit(1);
  }

  const url = `${serviceUrl}/open/ai/x402/card/status?orderNo=${encodeURIComponent(orderNo)}`;

  if (!poll) {
    try {
      const res = await axios.get(url);
      console.log(JSON.stringify(sanitizeOutput(res.data), null, 2));
    } catch (error) {
      console.error(JSON.stringify({
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      }));
      process.exit(1);
    }
    return;
  }

  // 轮询模式
  console.error(`Polling ${url} every ${POLL_INTERVAL / 1000}s (max ${MAX_POLLS} times)`);

  for (let i = 1; i <= MAX_POLLS; i++) {
    try {
      const res = await axios.get(url);
      const model = res.data?.model;

      console.error(
        `[${i}/${MAX_POLLS}] orderStatus=${model?.orderStatus} channelStatus=${model?.channelStatus} cardStatus=${model?.cardStatus || "-"}`
      );

      if (model?.orderStatus === "SUCCESS" || model?.orderStatus === "FAIL") {
        console.log(JSON.stringify(sanitizeOutput(res.data), null, 2));
        return;
      }
    } catch (e) {
      console.error(`[${i}/${MAX_POLLS}] Error: ${e.message}`);
    }

    if (i < MAX_POLLS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  console.error("Polling timeout. Card may still be provisioning.");
  process.exit(2);
}
