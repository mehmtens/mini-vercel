import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      QUEUE_NAME: 'deployment-queue-worker-test',
    },
  },
});
