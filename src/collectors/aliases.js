// 平台别名与 URL 推断：存储只写规范平台 ID，展示层可以保留原始输入。

export const PLATFORM_ALIASES = new Map([
  ['twitter', 'x'],
  ['x.com', 'x'],
  ['x', 'x'],
  ['hf', 'huggingface'],
  ['hf-mirror', 'huggingface'],
  ['hfmirror', 'huggingface'],
  ['huggingface.co', 'huggingface'],
  ['hf-mirror.com', 'huggingface'],
  ['macosdo', 'macos.do'],
  ['macos.do', 'macos.do'],
  ['linuxdo', 'linux.do'],
  ['linux.do', 'linux.do'],
  ['telegram', 'telegram'],
  ['tg', 'telegram'],
  ['discord', 'discord'],
  ['reddit', 'reddit'],
  ['github', 'github'],
  ['gh', 'github'],
  ['v2ex', 'v2ex'],
  ['arxiv', 'arxiv'],
  ['google', 'google'],
  ['web', 'web'],
  ['auto', 'auto'],
]);

export function canonicalPlatform(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return PLATFORM_ALIASES.get(raw) || raw;
}

/** 已知域名 → 规范平台；未知域名回退 web。 */
export function inferPlatformFromUrl(url) {
  let host = '';
  try {
    host = new URL(String(url || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'web';
  }
  if (!host) return 'web';
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
  if (host === 'github.com' || host === 'api.github.com') return 'github';
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
  if (host === 'discord.com' || host === 'discord.gg' || host.endsWith('.discord.com')) return 'discord';
  if (host === 'huggingface.co' || host === 'hf-mirror.com') return 'huggingface';
  if (host === 'arxiv.org' || host === 'export.arxiv.org') return 'arxiv';
  if (host === 'v2ex.com' || host.endsWith('.v2ex.com')) return 'v2ex';
  if (host === 'linux.do' || host.endsWith('.linux.do')) return 'linux.do';
  if (host === 'macos.do' || host.endsWith('.macos.do')) return 'macos.do';
  if (host === 't.me' || host === 'telegram.me' || host.endsWith('.telegram.org')) return 'telegram';
  if (host === 'google.com' || host.endsWith('.google.com')) return 'google';
  return 'web';
}

/** 把 URL 归一化为来源根地址/站点地址，便于 detect 返回可保存的 URL。 */
export function originOf(url, fallback = '') {
  try { return new URL(String(url || '')).origin; } catch { return fallback; }
}
