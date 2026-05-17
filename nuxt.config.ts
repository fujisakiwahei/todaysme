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

  modules: ["@pinia/nuxt", "@sentry/nuxt/module", "@nuxt/eslint"],

  css: ["~/assets/styles/style.scss"],

  typescript: {
    typeCheck: true,
    tsConfig: {
      compilerOptions: {
        // *.test.ts から Node 標準テストランナーで .ts 拡張子つきの
        // 相対 import を行うため (noEmit 時のみ有効化できる)
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
