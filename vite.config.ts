import { compelemCompiler } from '@compelem/compiler';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

// 单文件配置（对齐 compelem-i18n）：
export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  optimizeDeps: {
    exclude: ['compelem'],
  },
  plugins: [
    compelemCompiler(),
    dts({
      include: ['src/**/*.ts'],
      outDir: 'dist',
    }),
  ],
  build: {
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'index.js' : 'index.umd.cjs',
    },
    rollupOptions: {
      external: ['compelem', 'myfx'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
