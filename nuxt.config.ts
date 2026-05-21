// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },

  runtimeConfig: {
    public: {
      supabaseUrl: process.env.NUXT_PUBLIC_SUPABASE_URL,
      supabasePublishableKey: process.env.NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
  },

  modules: [
    "@pinia/nuxt",
    "@sentry/nuxt/module",
    "@nuxt/eslint",
    "@nuxtjs/supabase",
  ],

  supabase: {
    url: process.env.NUXT_PUBLIC_SUPABASE_URL,
    key: process.env.NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    serviceKey: process.env.SUPABASE_SECRET_KEY,
    // ルート単位の認証ガードは app/middleware/auth.ts で行うため
    // モジュール組み込みの自動リダイレクトは無効化する
    redirect: false,
  },

  css: ["~/assets/styles/style.scss"],

  app: {
    head: {
      link: [
        // Material Symbols Outlined (refresh / chevron などのアイコン用)
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0",
        },
      ],
    },
  },

  typescript: {
    typeCheck: true,
    tsConfig: {
      compilerOptions: {
        // *.test.ts から Node 標準テストランナーで .ts 拡張子つきの
        // 相対 import を行うため (noEmit 時のみ有効化できる)
        allowImportingTsExtensions: true,
      },
    },
    // shared/ (Nuxt 4) の tsconfig にも同じフラグを通す。
    // shared/schemas/*.ts 間の `.ts` 付き相対 import (および schemas.test.ts) を許可。
    sharedTsConfig: {
      compilerOptions: {
        allowImportingTsExtensions: true,
      },
    },
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          allowImportingTsExtensions: true,
        },
      },
    },
  },

  sourcemap: {
    client: "hidden",
  },

  // sentry: {
  //   org: "...",
  //   project: "...",
  //   authToken: process.env.SENTRY_AUTH_TOKEN,
  // },
  vite: {
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: `
          @use "sass:color";
          @use "~/assets/styles/variables" as *;
          @use "~/assets/styles/mixins" as *;
          `,
        },
      },
    },
  },

  sentry: {
    org: "saki-llc",
    project: "todaysme",
    autoInjectServerSentry: "top-level-import",
  },
});
