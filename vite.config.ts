import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from 'vite-plugin-pwa'
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    inspectAttr(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'data/registry-norilsk.json'],
      manifest: {
        name: 'Комиссия.Финансы — Норильск · учёт и отчётность избирательных комиссий',
        short_name: 'Комиссия.Финансы Норильск',
        description:
          'PWA для финансового и бухгалтерского учёта расходов избирательных комиссий МО город Норильск: ТИК + 63 УИК, сметы, вознаграждения, банк/касса, отчётность (прил. № 10). Офлайн-first.',
        start_url: './',
        display: 'standalone',
        background_color: '#f4f5f7',
        theme_color: '#0f1f3d',
        lang: 'ru',
        scope: './',
        orientation: 'any',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,json,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
