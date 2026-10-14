import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

// Tauri 开发时会把 TAURI_DEV_HOST 设成局域网地址（移动端调试用）；没有就留空走默认。
const host = process.env.TAURI_DEV_HOST;

/**
 * 浏览器调试路径专用：把根目录 .env 里的 key 喂给 apps/web/src/platform/desktop.ts
 * 的 browserFallback().credentials()。字段名必须和 shared/desktop.ts 的
 * credentialsSchema 对齐（strict，多一个键就会 parse 失败）。
 *
 * 只挂在 dev server 上 —— configureServer 不参与生产构建，打出来的包里没有这段，
 * 也就不存在"key 被塞进静态资源"的风险。桌面版走 Rust 的 get_credentials，不碰这里。
 */
function devCredentials(): Plugin {
  return {
    name: 'stepchan-dev-credentials',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/credentials', (_req, res) => {
        // 和 credentials.rs 一致：文件优先于进程环境变量。shell 里残留的旧 export
        // 会把鉴权问题伪装成别的故障。
        const env = readDotEnv(resolve(repoRoot, '.env'));
        const pick = (key: string, fallback: string) =>
          env[key] ?? process.env[key] ?? fallback;
        const apiKey = pick('STEPFUN_API_KEY', '');
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        if (!apiKey) {
          res.statusCode = 503;
          res.end(
            JSON.stringify({ error: '根目录 .env 里没有 STEPFUN_API_KEY，配置后重启 dev server。' }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            apiKey,
            realtimeModel: pick('STEPFUN_REALTIME_MODEL', 'stepaudio-3-realtime-preview'),
            visionModel: pick('STEPFUN_VISION_MODEL', 'step-1o-turbo-vision'),
            chatModel: pick('STEPFUN_MODEL', 'step-3.7-flash'),
          }),
        );
      });
    },
  };
}

/** 极简 .env 解析。只认 KEY=VALUE，忽略注释与空行；不引入 dotenv 依赖。 */
function readDotEnv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export default defineConfig({
  plugins: [react(), devCredentials()],
  // Tauri CLI 自己在终端里输出进度，别被 vite 清屏吞掉。
  clearScreen: false,
  server: {
    port: 5173,
    // 端口必须固定：tauri.conf.json 的 devUrl 写死了 127.0.0.1:5173，
    // vite 偷偷换端口的话桌面壳会打开一个白窗。
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Rust 侧的改动由 cargo 监听，vite 跟着重启只会互相打断。
      ignored: ['**/src-tauri/**'],
    },
    // 刻意没有 /api 代理：Node 服务端已经删掉，所有请求直连 StepFun 或走 Tauri 命令。
  },
  // TAURI_ENV_* 由 Tauri CLI 注入（平台、架构、debug 与否）。
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // WKWebView on macOS 13+ ≈ Safari 16。别让 esbuild 降级到 es2015 白浪费体积。
    target: 'safari16',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    rollupOptions: {
      // Pixi 单独切一块：它是最大的依赖，和业务代码分开能让业务改动不动它的缓存。
      // 原来还有一块 markdown（react-markdown），聊天面板删掉后那个依赖也移除了。
      output: { manualChunks: { pixi: ['pixi.js'] } },
    },
  },
});
