import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  // Files are the unit of parallelism: fullyParallel stays false so tests within a
  // spec run serially, while distinct spec files run concurrently across workers.
  // Every test opens its own fresh persistent profile, so no test depends on state
  // left by another. The extension is built once in global-setup.
  fullyParallel: false,
  workers: process.env.CI ? 3 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  // 'github' turns failures into file/line-anchored annotations in the run summary UI; without it
  // a red E2E step shows only a blank "Error:". 'list' keeps the readable log, 'html' the artifact.
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run serve:e2e',
    url: 'http://127.0.0.1:4173/single-image.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
