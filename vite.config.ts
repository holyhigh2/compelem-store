import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

// 单文件配置（对齐 compelem-i18n）：
// · `vite` 开发态：根 index.html 即 demo 页面，直接加载 /test/main.ts；
// · `vite build`：库模式构建 dist（ESM + UMD + d.ts），compelem/myfx 保持 external。
export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  // compelem 在本仓库 working tree 内被直接修改（node_modules symlink），
  // 若参与 vite 依赖预打包（node_modules/.vite 缓存），修改后浏览器仍拿到旧版
  // （缓存仅在 lockfile/config 变化时失效，不感知 node_modules 内文件改动），
  // 曾导致 _notify 透传参数缺失 → subscribe 收到 undefined。
  // 排除后 vite 直接以源码方式服务该包，改动刷新即生效。
  optimizeDeps: {
    exclude: ['compelem'],
  },
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      outDir: 'dist',
    }),
  ],
  build: {
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'CompelemStore',
      fileName: 'index',
    },
    rollupOptions: {
      external: ['compelem', 'myfx'],
      output: {
        globals: {
          compelem: 'CompElem',
          myfx: 'myfx',
        },
      },
    },
  },
  test: {
    // jsdom（非 happy-dom）：compelem 的 h`` 模板基于 lit 风格「Part 标记」实现，
    // 在 happy-dom 下绑定节点不会被提交成真实值（@click 退化成 `2=""`、
    // ${store.x} 退化成 `⟬Ċ⟭N`），导致组件级断言全失败；jsdom 可忠实渲染，
    // 与原 26/26 探针环境一致。目录结构仍对齐 i18n（test/ + 单 vite.config.ts）。
    environment: 'jsdom',
    globals: true,
  },
});
