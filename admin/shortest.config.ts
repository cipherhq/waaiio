import type { ShortestConfig } from "@antiwork/shortest";

export default {
  headless: false,
  baseUrl: "https://admin.waaiio.com",
  testPattern: "**/__shortest__/**/*.test.ts",
  ai: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514" as any,
  },
} satisfies ShortestConfig;
