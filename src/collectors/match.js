// 统一匹配器：把“采什么”和“留什么”分开，所有适配器共用同一套过滤语义。
// 纯函数、无 I/O，便于在适配器预过滤和入库前强制过滤两处复用。

const ALLOWED_FIELDS = new Set([
  'includeAny', 'includeAll', 'excludeAny', 'regex', 'authors', 'authorsExact',
  'tags', 'requireMedia', 'caseSensitive', 'wholeWord',
]);
const MAX_REGEX_LENGTH = 200;
const MAX_REGEX_COUNT = 20;
const MAX_TEXT_LENGTH = 20_000;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function asArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function stringList(value, field) {
  const out = [];
  for (const raw of asArray(value)) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    out.push(text);
    if (out.length > 200) throw new Error(`匹配条件 ${field} 条目过多`);
  }
  return out;
}

export function normalizeMatchText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeForCompare(value, caseSensitive) {
  const text = normalizeMatchText(value);
  return caseSensitive ? text : text.toLocaleLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordHit(haystack, keyword, { wholeWord, caseSensitive }) {
  const needle = normalizeForCompare(keyword, caseSensitive);
  if (!needle) return true;
  if (!wholeWord || CJK_PATTERN.test(needle)) return haystack.includes(needle);
  const flags = caseSensitive ? 'u' : 'iu';
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(needle)}(?![\\p{L}\\p{N}_])`, flags);
  return re.test(haystack);
}

function authorValues(item) {
  return [item.author, item.author_name, item.username, item.metadata?.author]
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => normalizeMatchText(value).replace(/^@+/, ''))
    .filter(Boolean);
}

function tagValues(item) {
  const values = [
    ...asArray(item.metadata?.tags),
    ...asArray(item.metadata?.keywords),
    ...asArray(item.metadata?.category),
  ];
  return values.map((value) => normalizeMatchText(value).replace(/^#+/, '')).filter(Boolean);
}

function mediaPresent(item) {
  const meta = item.metadata || {};
  return ['media', 'attachments', 'images', 'videos', 'embeds']
    .some((key) => Array.isArray(meta[key]) ? meta[key].length > 0 : Boolean(meta[key]));
}

/** 校验并规范化匹配条件；未知字段/非法正则直接抛错，供保存 API 返回 400。 */
export function validateMatch(input = {}) {
  if (input == null || input === '') return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('匹配条件必须是对象');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`未知匹配条件字段: ${key}`);
  }
  const out = {};
  for (const field of ['includeAny', 'includeAll', 'excludeAny', 'authors', 'tags']) {
    if (input[field] !== undefined) out[field] = stringList(input[field], field);
  }
  if (input.authorsExact !== undefined) out.authorsExact = !!input.authorsExact;
  if (input.requireMedia !== undefined) out.requireMedia = !!input.requireMedia;
  if (input.caseSensitive !== undefined) out.caseSensitive = !!input.caseSensitive;
  if (input.wholeWord !== undefined) out.wholeWord = !!input.wholeWord;
  if (input.regex !== undefined) {
    const patterns = stringList(input.regex, 'regex');
    if (patterns.length > MAX_REGEX_COUNT) throw new Error(`正则条件最多 ${MAX_REGEX_COUNT} 条`);
    out.regex = patterns.map((pattern) => {
      if (pattern.length > MAX_REGEX_LENGTH) throw new Error(`正则条件不能超过 ${MAX_REGEX_LENGTH} 字符`);
      const flags = `${out.caseSensitive ? '' : 'i'}mu`;
      try {
        // 只校验，不把 RegExp 对象写进可持久化的 match。
        new RegExp(pattern, flags);
        return pattern;
      } catch (error) {
        throw new Error(`正则条件无效: ${pattern}（${error.message}）`);
      }
    });
  }
  return out;
}

/** 来源默认值 + 规则覆盖；数组字段整体替换，不做拼接。 */
export function mergeMatch(defaults = {}, match = {}) {
  return { ...(defaults || {}), ...(match || {}) };
}

/**
 * 编译匹配器。predicate 只依赖传入 item，可安全用于分页预过滤和入库前复检。
 */
export function compileMatcher({ match = {}, defaults = {}, rule = null } = {}) {
  const merged = mergeMatch(defaults, match);
  const normalized = validateMatch(merged);
  const caseSensitive = normalized.caseSensitive === true;
  const wholeWord = normalized.wholeWord === true;
  const includeAny = normalized.includeAny || [];
  const includeAll = normalized.includeAll || [];
  const excludeAny = normalized.excludeAny || [];
  const flags = `${caseSensitive ? '' : 'i'}mu`;
  const regex = (normalized.regex || []).map((item) => {
    const source = typeof item === 'string' ? item : item?.source;
    return { source, regex: new RegExp(source, flags) };
  }).filter((item) => item.source);
  const authors = (normalized.authors || []).map((value) => {
    const exact = normalized.authorsExact || value.startsWith('=');
    return { value: normalizeForCompare(value.replace(/^=/, '').replace(/^@+/, ''), caseSensitive), exact };
  });
  const tags = (normalized.tags || []).map((value) => normalizeForCompare(value.replace(/^#+/, ''), caseSensitive));

  function matches(item = {}) {
    const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const fields = [
      item.title, item.content, item.summary, item.author, item.author_name, item.username,
      meta.author, meta.category, meta.provider, meta.subreddit, meta.node,
      ...asArray(meta.keywords), ...asArray(meta.tags),
    ];
    const rawText = normalizeMatchText(fields.filter(Boolean).join('\n')).slice(0, MAX_TEXT_LENGTH);
    const haystack = caseSensitive ? rawText : rawText.toLocaleLowerCase();

    if (excludeAny.some((keyword) => keywordHit(haystack, keyword, { wholeWord, caseSensitive }))) return false;

    if (includeAny.length && !includeAny.some((keyword) => keywordHit(haystack, keyword, { wholeWord, caseSensitive }))) {
      return false;
    }
    if (includeAll.length && !includeAll.every((keyword) => keywordHit(haystack, keyword, { wholeWord, caseSensitive }))) {
      return false;
    }
    if (regex.length && !regex.some(({ regex: re }) => re.test(rawText))) return false;

    if (authors.length) {
      const values = authorValues(item).map((value) => normalizeForCompare(value, caseSensitive));
      const hit = authors.some(({ value, exact }) => (exact
        ? values.some((candidate) => candidate === value)
        : values.some((candidate) => candidate.includes(value))));
      if (!hit) return false;
    }

    if (tags.length) {
      const values = tagValues(item).map((value) => normalizeForCompare(value, caseSensitive));
      if (!tags.some((tag) => values.some((candidate) => candidate === tag || candidate.includes(tag)))) return false;
    }

    if (normalized.requireMedia && !mediaPresent(item)) return false;
    return true;
  }

  return {
    predicate: matches,
    matches,
    match: normalized,
    rule,
    summary() {
      return {
        includeAny: [...includeAny],
        includeAll: [...includeAll],
        excludeAny: [...excludeAny],
        regex: regex.map((item) => item.source),
        authors: (normalized.authors || []),
        tags: (normalized.tags || []),
        requireMedia: !!normalized.requireMedia,
        wholeWord,
        caseSensitive,
      };
    },
  };
}

/** 兼容旧调用：没有 match 时保持 kind/value 的原有语义。 */
export function matchesRule(item, rule) {
  if (rule?.match && Object.keys(rule.match).length) {
    try {
      return compileMatcher({ match: rule.match }).predicate(item);
    } catch {
      return false;
    }
  }
  const value = normalizeForCompare(rule?.value || '', false);
  if (!value) return true;
  const kind = String(rule?.kind || 'keyword').toLowerCase();
  if (kind === 'account' || kind === 'author' || kind === 'user') {
    const authors = authorValues(item).map((entry) => normalizeForCompare(entry, false));
    return authors.some((author) => author.includes(value.replace(/^@+/, '')));
  }
  const haystack = normalizeForCompare([
    item.title, item.content, item.summary, item.author,
    ...(item.metadata?.keywords || []), ...(item.metadata?.tags || []),
  ].join('\n'), false);
  return haystack.includes(value);
}
