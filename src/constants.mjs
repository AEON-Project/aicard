export const MIN_AMOUNT = 0.6;
export const MAX_AMOUNT = 800;
export const POLL_INTERVAL = 5000;
export const MAX_POLLS = 42;
export const BSC_RPC_URL = "https://few-boldest-spring.bsc.quiknode.pro/ec468d8a1ea2c310457b2e2f4eea257e62ba3b1e/";
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
export const FACILITATOR_ADDRESS = "0x555e3311a9893c9B17444C1Ff0d88192a57Ef13e";
export const DEFAULT_WC_PROJECT_ID = "1c5e29cd4b466f52393cd39d05ec265c";
export const WC_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "nonpayable",
  },
];
