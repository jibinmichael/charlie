// next.config.mjs — Next.js config for the marketing site, wrapped with Sentry (source maps, tunnel route).
import { withSentryConfig } from "@sentry/nextjs";
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lint the app + shared lib on `next build` and `next lint` (the browser/server surface).
  // Backend .mjs workers are covered by typecheck + the Vitest suites instead.
  eslint: { dirs: ["app", "lib"] },
};

// Source-map upload needs your own Sentry org + project slugs (and SENTRY_AUTH_TOKEN at build time).
// Unset = the wrapper still runs (instrumentation, tunnel route) but uploads nothing.
const SENTRY_ORG = process.env.SENTRY_ORG || undefined;
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || undefined;
const uploadSourceMaps = Boolean(SENTRY_ORG && SENTRY_PROJECT);

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: SENTRY_ORG,

  project: SENTRY_PROJECT,

  // No org/project configured → skip every source-map step (no upload attempt, no warning noise).
  sourcemaps: { disable: !uploadSourceMaps },

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
