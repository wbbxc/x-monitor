// 通用 HTML 工具：零依赖的链接、结构化数据、正文、sitemap 与 robots 解析。
import { cleanText, safeUrl } from './text.js';

function attr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match?.[1] || '';
}

function resolveUrl(value, baseUrl = '') {
  try { return new URL(String(value || '').trim(), baseUrl || undefined).href; } catch { return ''; }
}

function patternOf(value) {
  if (!value) return null;
  if (value instanceof RegExp) return value;
  const text = String(value);
  const literal = text.match(/^\/(.+)\/([gimsuy]*)$/);
  try { return literal ? new RegExp(literal[1], literal[2]) : new RegExp(text, 'i'); } catch { return null; }
}

function listOf(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => {
    const re = patternOf(pattern);
    if (re) return re.test(value);
    return value.toLowerCase().includes(String(pattern).toLowerCase());
  });
}

export function isLoginLikeUrl(value) {
  const url = String(value || '').toLowerCase();
  return /(?:^|\/)(?:login|logout|signin|signup|register|auth|account|password|wp-login)(?:\/|$|\?)/.test(url)
    || /(?:javascript|mailto|tel):/.test(url);
}

/**
 * 提取页面链接。pattern 可匹配 href 本身或整段 a 标签；
 * 匹配结果优先使用第一个捕获组作为 URL。
 */
export function extractLinks(html, {
  pattern, include = [], exclude = [], baseUrl = '', maxLinks = 500, text = true,
} = {}) {
  const source = String(html || '');
  const includeList = listOf(include);
  const excludeList = listOf(exclude);
  const out = [];
  const seen = new Set();

  function push(url, label, block = '') {
    const resolved = resolveUrl(url, baseUrl);
    if (!resolved || !/^https?:\/\//i.test(resolved)) return;
    if (isLoginLikeUrl(resolved)) return;
    if (includeList.length && !matchesAny(resolved, includeList)) return;
    if (excludeList.length && matchesAny(resolved, excludeList)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ url: resolved, title: cleanText(label || ''), text: cleanText(text ? label : ''), html: block });
  }

  if (pattern) {
    const re = patternOf(pattern);
    if (re) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const match of source.matchAll(global)) {
        if (out.length >= maxLinks) break;
        const url = match[1] || match[0];
        if (!url) continue;
        const start = Math.max(0, (match.index || 0) - 120);
        const block = source.slice(start, Math.min(source.length, (match.index || 0) + match[0].length + 120));
        push(url, cleanText(match[2] || ''), block);
      }
      return out;
    }
  }

  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorRe)) {
    if (out.length >= maxLinks) break;
    const href = attr(match[1], 'href');
    if (!href) continue;
    push(href, cleanText(match[2] || ''), match[0]);
  }
  return out;
}

function parseJsonLoose(text) {
  const value = String(text || '').trim().replace(/^<!--|-->$/g, '').trim();
  try { return JSON.parse(value); } catch {}
  return null;
}

/** 从 JSON-LD 中挑出文章类对象，支持 @graph。 */
export function extractJsonLd(html) {
  const blocks = [...String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const candidates = [];
  const wanted = new Set(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'WebPage']);
  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== 'object') return;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => wanted.has(String(type)))) candidates.push(value);
    if (value['@graph']) visit(value['@graph']);
  }
  for (const block of blocks) visit(parseJsonLoose(block[1]));
  const item = candidates[0];
  if (!item) return null;
  const authorValue = item.author;
  const authors = Array.isArray(authorValue) ? authorValue : [authorValue];
  return {
    title: cleanText(item.headline || item.name || ''),
    content: cleanText(item.articleBody || item.description || ''),
    summary: cleanText(item.description || ''),
    author: authors.map((author) => cleanText(author?.name || author || '')).filter(Boolean).join(', '),
    published_at: item.datePublished || item.dateCreated || item.dateModified || null,
    canonical_url: safeUrl(item.url || item['@id'] || ''),
    image: safeUrl(Array.isArray(item.image) ? item.image[0] : item.image || ''),
  };
}

/** OpenGraph / Twitter Card 回退。 */
export function extractOpenGraph(html) {
  const source = String(html || '');
  const meta = {};
  for (const match of source.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const key = attr(attrs, 'property') || attr(attrs, 'name');
    if (!key) continue;
    const value = attr(attrs, 'content');
    if (value) meta[key.toLowerCase()] = value;
  }
  const canonical = safeUrl(attr(source.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] || '', 'href'));
  return {
    title: cleanText(meta['og:title'] || meta['twitter:title'] || ''),
    content: cleanText(meta['og:description'] || meta['twitter:description'] || meta['description'] || ''),
    summary: cleanText(meta['og:description'] || meta['twitter:description'] || meta['description'] || ''),
    author: cleanText(meta['article:author'] || meta['author'] || ''),
    published_at: meta['article:published_time'] || meta['article:modified_time'] || null,
    canonical_url: safeUrl(meta['og:url'] || '') || canonical || '',
    image: safeUrl(meta['og:image'] || meta['twitter:image'] || ''),
  };
}

function stripHtml(html) {
  return cleanText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

/** 优先 article/main，再回退到最长文本块。 */
export function extractArticleText(html) {
  const source = String(html || '');
  for (const selector of [/<article\b[^>]*>([\s\S]*?)<\/article>/i, /<main\b[^>]*>([\s\S]*?)<\/main>/i]) {
    const match = source.match(selector);
    const text = stripHtml(match?.[1] || '');
    if (text.length > 80) return text;
  }
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source;
  const blocks = [...body.matchAll(/<(?:p|div|section|li)\b[^>]*>([\s\S]*?)<\/(?:p|div|section|li)>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((text) => text.length > 30)
    .sort((a, b) => b.length - a.length);
  return blocks[0] || stripHtml(body).slice(0, 4000);
}

export function extractPageContent(html, url = '') {
  const jsonLd = extractJsonLd(html);
  const og = extractOpenGraph(html);
  const titleTag = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const h1 = cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const article = extractArticleText(html);
  return {
    title: jsonLd?.title || og.title || h1 || titleTag,
    content: jsonLd?.content || article || og.content,
    summary: jsonLd?.summary || og.summary || article.slice(0, 4000),
    author: jsonLd?.author || og.author || '',
    published_at: jsonLd?.published_at || og.published_at || null,
    canonical_url: safeUrl(jsonLd?.canonical_url || og.canonical_url || url),
    image: jsonLd?.image || og.image || '',
    format: jsonLd ? 'jsonld' : (og.title ? 'opengraph' : 'html'),
  };
}

/** sitemap / sitemap index。 */
export function parseSitemap(xml) {
  const source = String(xml || '');
  const locs = [...source.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);
  return {
    type: /<sitemapindex\b/i.test(source) ? 'index' : 'urlset',
    urls: locs,
  };
}

/** 基础 robots.txt 解析：支持 User-agent 分组、Disallow/Allow 与 Crawl-delay。 */
export function parseRobots(text, userAgent = 'x-monitor') {
  const groups = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const index = clean.indexOf(':');
    if (index === -1) continue;
    const key = clean.slice(0, index).trim().toLowerCase();
    const value = clean.slice(index + 1).trim();
    if (key === 'user-agent') {
      current = { agents: [value.toLowerCase()], disallow: [], allow: [], crawlDelay: null };
      groups.push(current);
    } else if (current && key === 'disallow') {
      if (value) current.disallow.push(value);
    } else if (current && key === 'allow') {
      if (value) current.allow.push(value);
    } else if (current && key === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.crawlDelay = delay * 1000;
    }
  }
  const ua = String(userAgent || '').toLowerCase();
  const matched = groups.filter((group) => group.agents.some((agent) => agent === '*' || ua.includes(agent)));
  const effective = matched.length ? matched : groups.filter((group) => group.agents.includes('*'));
  const disallow = effective.flatMap((group) => group.disallow);
  const allow = effective.flatMap((group) => group.allow);
  const crawlDelay = effective.map((group) => group.crawlDelay).filter((value) => value != null).sort((a, b) => b - a)[0] || null;
  return { disallow, allow, crawlDelay };
}

export function isPathAllowed(pathname, robots) {
  const value = String(pathname || '/');
  const rules = [...(robots?.allow || []).map((rule) => ({ rule, allow: true })),
    ...(robots?.disallow || []).map((rule) => ({ rule, allow: false }))];
  if (!rules.length) return true;
  let best = null;
  for (const item of rules) {
    const rule = String(item.rule || '');
    if (!rule) continue;
    const pattern = rule.replace(/\*/g, '.*');
    let hit = false;
    try { hit = new RegExp(`^${pattern}`).test(value); } catch { hit = value.startsWith(rule); }
    if (!hit) continue;
    if (!best || rule.length > best.rule.length || (rule.length === best.rule.length && item.allow)) best = item;
  }
  return best ? best.allow : true;
}
