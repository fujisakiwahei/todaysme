<script setup lang="ts">
const requestURL = useRequestURL();
const siteUrl = `${requestURL.protocol}//${requestURL.host}`;
const title = "Today's ME";
const description =
  "Oura / Google Calendar / Toggl Track を「起床を 0 時間目とする」1 つの時間軸に統合する、個人向け時間ダッシュボード。";
const ogImage = `${siteUrl}/ogp-rectangle.png`;
const ogImageSquare = `${siteUrl}/ogp-square.png`;

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogType: "website",
  ogUrl: requestURL.href,
  ogSiteName: title,
  ogLocale: "ja_JP",
  ogImage: [
    { url: ogImage, width: 1731, height: 909, alt: title },
    { url: ogImageSquare, width: 1254, height: 1254, alt: title },
  ],
  twitterCard: "summary_large_image",
  twitterTitle: title,
  twitterDescription: description,
  twitterImage: ogImage,
});

useHead({
  htmlAttrs: { lang: "ja" },
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
