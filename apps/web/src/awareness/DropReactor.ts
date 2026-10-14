// 拖放 → 反应意图。
//
// 范围红线（AGENTS.md）：**只看文件名、后缀、数量，绝不读文件内容**。
// 所以生成的提示里必须显式告诉她"你看不到里面是什么" —— 不写这句，模型会很自然地
// 开始编造文件内容（realtime 在纯文本输入下有过"嘴上说做了但没真做"的实测记录）。
//
// 这个反应器刻意**没有隐私开关**：把东西拖到桌宠身上是用户的主动投喂，
// 不是被动监视，和截屏/前台应用/剪贴板不是一类。它受 Awareness.stop() 控制，
// 也受突发配额限制，但不受 settings 里任何感知开关控制。
import { RateWindow } from './types';
import type { AwarenessIntent, DragDropPayload } from './types';

/** 两次拖放反应的最小间隔，用来吃掉重复投递的同一次拖放。 */
export const DROP_COOLDOWN_MS = 2_000;
/** 突发上限：一分钟最多反应 6 次。 */
export const DROP_WINDOW_MS = 60_000;
export const DROP_LIMIT = 6;
/** 拖进来的文字最多引用多少字符。 */
export const TEXT_PREVIEW_CHARS = 120;

type Category = '图片' | '代码' | '文档' | '音视频' | '压缩包';

const CATEGORIES: ReadonlyArray<readonly [Category, ReadonlySet<string>]> = [
  ['图片', new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'svg', 'avif'])],
  [
    '代码',
    new Set([
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp',
      'h', 'hpp', 'rb', 'php', 'swift', 'kt', 'sh', 'zsh', 'json', 'yaml', 'yml', 'toml',
      'sql', 'css', 'scss', 'html', 'vue', 'lua', 'dart', 'scala', 'ex', 'clj',
    ]),
  ],
  [
    '文档',
    new Set([
      'pdf', 'md', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
      'pages', 'numbers', 'key', 'rtf', 'epub',
    ]),
  ],
  [
    '音视频',
    new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']),
  ],
  ['压缩包', new Set(['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'pkg'])],
];

/** 取文件名。同时处理 / 和 \，并忽略尾部斜杠（拖目录时会带）。 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** 小写后缀，没有后缀返回空串。隐藏文件（.zshrc）不算有后缀。 */
export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function categorize(path: string): Category | null {
  const ext = extension(path);
  if (!ext) return null;
  for (const [label, set] of CATEGORIES) {
    if (set.has(ext)) return label;
  }
  return null;
}

/**
 * 把一堆路径描述成一句中文。纯函数，没有时钟也没有状态，方便直接测。
 * 空数组、或者全是空白路径，返回 null。
 */
export function describePaths(paths: string[]): string | null {
  // 先把无效路径剔掉，后面所有逻辑都基于这份过滤后的列表 ——
  // 不然 paths[0] 是空白时会描述成「一个没有后缀的文件，叫「 」」。
  const valid = paths.filter((path) => basename(path).trim().length > 0);
  if (valid.length === 0) return null;

  if (valid.length === 1) {
    const only = basename(valid[0]);
    const category = categorize(valid[0]);
    const ext = extension(valid[0]);
    const what = category ?? (ext ? `.${ext} 文件` : '没有后缀的文件');
    return `一个${what}，叫「${only}」`;
  }

  // 按类别计数，多的排前面，最多列三类，剩下的归到"其他文件"。
  const counts = new Map<string, number>();
  for (const path of valid) {
    const label = categorize(path) ?? '其他文件';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([label, n]) => `${n} 个${label}`);

  return `${valid.length} 个文件（${parts.join('、')}），第一个叫「${basename(valid[0])}」`;
}

/** 截断拖进来的文字。返回 null 表示全是空白，不值得反应。 */
export function previewText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 换行压成空格，否则提示串被撑得很难读。
  const flat = trimmed.replace(/\s+/g, ' ');
  if ([...flat].length <= TEXT_PREVIEW_CHARS) return flat;
  return `${[...flat].slice(0, TEXT_PREVIEW_CHARS).join('')}…`;
}

export class DropReactor {
  private readonly budget = new RateWindow(DROP_WINDOW_MS, DROP_LIMIT);
  private lastAt = Number.NEGATIVE_INFINITY;

  handle(payload: DragDropPayload, now: number): AwarenessIntent | null {
    if (now - this.lastAt < DROP_COOLDOWN_MS) return null;
    if (!this.budget.has(now)) return null;

    const prompt = this.describe(payload);
    if (!prompt) return null;

    this.budget.take(now);
    this.lastAt = now;
    return { kind: 'drop', prompt };
  }

  reset(): void {
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.budget.reset();
  }

  private describe(payload: DragDropPayload): string | null {
    if (payload.kind === 'files') {
      const what = describePaths(payload.paths);
      if (!what) return null;
      return (
        `用户把${what}拖到你身上了。` +
        `你只知道文件名，**打不开也看不到里面的内容**，所以不要猜里面写了什么。` +
        `用一句话反应一下，好奇或者吐槽都行。`
      );
    }

    const preview = previewText(payload.text);
    if (!preview) return null;
    return (
      `用户把一段文字拖到你身上了：「${preview}」。` +
      `用一句话反应一下；如果这段文字看起来是要你处理的任务，就先问清楚他想让你做什么。`
    );
  }
}
