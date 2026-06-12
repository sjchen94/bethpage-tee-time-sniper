const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45000,
  // The mock server holds global state (release clock, booking ledger),
  // so tests must not run concurrently.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4399',
    headless: true,
  },
  webServer: {
    command: 'node mock/mock-server.js',
    url: 'http://127.0.0.1:4399/',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
