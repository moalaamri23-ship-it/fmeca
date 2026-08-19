import { defineConfig } from 'vitest/config';

/**
 * Config for the manual live-generation harness only.
 *
 * The default `npm run test` glob deliberately excludes *.manual.ts: those tests
 * spend real API calls and need a flow URL. This config opts them in, so the live
 * check stays one command rather than a remembered incantation.
 *
 *   OUT_DIR=/tmp/fmeca-live COPILOT_URL='<flow url>' npm run test:live
 */
export default defineConfig({
    test: {
        include: ['services/__tests__/*.manual.ts'],
        testTimeout: 900_000,
        hookTimeout: 900_000,
    },
});
