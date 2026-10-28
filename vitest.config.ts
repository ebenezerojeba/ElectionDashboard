import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // one in-memory MongoDB at a time (low-RAM machine)
    env: { MONGOMS_VERSION: '7.0.14', NODE_ENV: 'test' },
  },
});
