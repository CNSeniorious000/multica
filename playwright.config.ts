import "./e2e/env";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
    headless: true,
    // Opt-in video recording (PLAYWRIGHT_VIDEO=1) for the streaming demo, so a
    // normal run stays fast and artifact-free.
    ...(process.env.PLAYWRIGHT_VIDEO === "1"
      ? { video: { mode: "on" as const, size: { width: 1440, height: 1400 } } }
      : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Don't auto-start servers — they must be running already
  // This avoids complexity and port conflicts during testing
});
