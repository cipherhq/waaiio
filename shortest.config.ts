import type { ShortestConfig } from "@antiwork/shortest";

export default {
  headless: true,
  baseUrl: "https://waaiio.com",
  testPattern: "**/__shortest__/**/*.test.ts",
  ai: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514" as any,
  },
} satisfies ShortestConfig;
