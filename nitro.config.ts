import { defineNitroConfig } from 'nitro/config';
export default defineNitroConfig({
  modules: ['workflow/nitro'],
  preset: 'vercel',
  vercel: { entryFormat: 'node' },
  routes: { '/**': { handler: './src/index.ts', format: 'node' } },
});
