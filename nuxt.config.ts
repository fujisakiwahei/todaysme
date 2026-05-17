// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },

  modules: ["@pinia/nuxt", "@sentry/nuxt/module"],

  css: ["~/assets/styles/style.scss"],

  typescript: {
    typeCheck: true,
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
