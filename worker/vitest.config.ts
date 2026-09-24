import { defineConfig } from 'vitest/config'

// Worker tests are *.spec.ts so `claude plugin test` (which runs *.test.ts) skips them.
export default defineConfig({ test: { include: ['test/**/*.spec.ts'] } })
