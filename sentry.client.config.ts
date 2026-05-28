import * as Sentry from "@sentry/nuxt";

// VERCEL_ENV: "production" | "preview" | "development" | undefined
// undefined になるのは Vercel 外（ローカル開発・ローカルビルド）。
// local 判定は VERCEL_ENV が無く NODE_ENV が development のときのみ。
const vercelEnv = process.env.VERCEL_ENV;
const nodeEnv = process.env.NODE_ENV;

const isLocal = !vercelEnv && nodeEnv === "development";
const isProduction = vercelEnv === "production";
const isPreview = vercelEnv === "preview";

const dsn = process.env.NUXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,

  enabled: !isLocal && Boolean(dsn),

  environment: vercelEnv ?? nodeEnv,

  tracesSampleRate: isProduction ? 0.05 : isPreview ? 0.01 : 0,

  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,

  integrations: [
    // Session Replay はコスト・プライバシー面の理由で一旦無効化
    // Sentry.replayIntegration(),
    // Logs も必要になるまで無効化
    // Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
  ],

  enableLogs: false,

  sendDefaultPii: false,

  debug: false,
});
