import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8788',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
  webServer: {
    command: 'node server/index.js',
    url: 'http://localhost:8788',
    env: { PORT: '8788' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});