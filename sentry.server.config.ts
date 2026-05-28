import * as Sentry from "@sentry/nuxt";

const vercelEnv = process.env.VERCEL_ENV;
const nodeEnv = process.env.NODE_ENV;

const isLocal = !vercelEnv && nodeEnv === "development";
const isProduction = vercelEnv === "production";
const isPreview = vercelEnv === "preview";

// server 側は SENTRY_DSN を優先し、無ければ public 側と同じ DSN を使う
const dsn = process.env.SENTRY_DSN ?? process.env.NUXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,

  enabled: !isLocal && Boolean(dsn),

  environment: vercelEnv ?? nodeEnv,

  tracesSampleRate: isProduction ? 0.05 : isPreview ? 0.01 : 0,

  integrations: [
    // Logs は必要になるまで無効化
    // Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
  ],

  enableLogs: false,

  sendDefaultPii: false,

  debug: false,
});
