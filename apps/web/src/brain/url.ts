// 从 shared/protocol.ts 搬过来的 URL 校验（那个文件要删，这里自己留一份）。
//
// 规则没变，但注释写清为什么：
// - 只允许 https：http 会被中间人改写，而且我们是把链接交给系统浏览器打开，
//   一旦被改写用户点到的就不是她说的那个站。
// - 拒绝带用户名/密码的 URL：`https://evil.com@real.com` 这种形式在
//   链接卡片上显示成 real.com，点下去去的是 evil.com。
// - 必须有 hostname：`https:///x` 之类在不同平台的 opener 里行为不一致。

/** 合法则返回规范化后的 href，否则返回 null。 */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname
      ? url.href
      : null;
  } catch {
    return null;
  }
}
