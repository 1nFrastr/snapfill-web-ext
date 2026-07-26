import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

export default {
  resolve: { alias: { '@': ROOT } },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'entry.ts'),
      formats: ['iife'],
      name: 'SnapfillTrace',
      fileName: () => 'trace-bundle.js',
    },
    outDir: path.resolve(ROOT, 'output/trace-bundle'),
    emptyOutDir: true,
    minify: false,
  },
};
