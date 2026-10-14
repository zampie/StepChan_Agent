// 把 webview 里的错误转发到进程 stderr。
//
// 桌宠窗口没有地址栏、没有控制台，WKWebView 的 console 也不会进进程 stderr。
// 结果是前端任何失败（素材 404、CSP 拦截、WebGL 不可用）在打包产物里**完全不可见**，
// 症状只是"桌宠没出现"，而且不指向原因。所以这里主动把错误喊出去：
// 从终端启动 .app 的二进制就能看到，不需要 devtools。
import { commands } from '../../../../shared/desktop';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 直接用底层 invoke，不经 platform/desktop.ts —— 那一层自己出错时也要能上报。 */
async function forward(level: string, message: string): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(commands.logFrontend, { level, message });
  } catch {
    // 连上报都失败就只能放弃，但绝不能因此再抛一个错出去。
  }
}

export function installDiagnostics(): void {
  window.addEventListener('error', (event) => {
    void forward('error', describe(event.error ?? event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    void forward('unhandled', describe(event.reason));
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    void forward('console', args.map(describe).join(' '));
  };
}

/** 给业务代码主动上报用（素材加载失败这类"不抛异常但很致命"的情况）。 */
export function reportDiagnostic(message: string): void {
  void forward('diag', message);
}
