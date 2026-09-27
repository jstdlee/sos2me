import { existsSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // Workers AI only works against Cloudflare; run `CF_REMOTE=1 pnpm dev` (after `wrangler login`) to use it locally.
  plugins: [
    vue(),
    tailwindcss(),
    ...(process.env.VITEST
      ? []
      : [
          cloudflare({
            // Your real database id / domain live in the git-ignored wrangler.local.jsonc.
            configPath: existsSync('wrangler.local.jsonc') ? 'wrangler.local.jsonc' : 'wrangler.jsonc',
            remoteBindings: process.env.CF_REMOTE === '1',
          }),
        ]),
  ],

  test: {
    include: ['worker/**/*.test.ts', 'src/**/*.test.ts'],
  },

  lint: {
    ignorePatterns: ['dist/**', '.wrangler/**', 'worker/worker-configuration.d.ts'],
  },

  fmt: {
    semi: true,
    singleQuote: true,
    printWidth: 110,
    ignorePatterns: ['dist/**', '.wrangler/**', 'docs/archive/**', 'pnpm-lock.yaml'],
  },
});
