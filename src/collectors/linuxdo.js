// linux.do 兼容入口：实现迁移到通用 Discourse 工厂，保留原有导出。
import {
  BROWSER_HEADERS,
  buildDiscourseUrl,
  collectDiscourse,
  createDiscourseAdapter,
  fetchDiscourseCategories,
  normalizeDiscourseTopic,
} from './discourse.js';

export const LINUXDO_ORIGIN = 'https://linux.do';
export const LINUXDO_DEFAULT_URL = `${LINUXDO_ORIGIN}/latest.json`;
export { BROWSER_HEADERS };

export function buildLinuxdoUrl(source, rule = {}) {
  return buildDiscourseUrl(source, rule, LINUXDO_ORIGIN);
}

export function normalizeLinuxdoTopic(topic, { sourceUrl = LINUXDO_DEFAULT_URL, users = [] } = {}) {
  return normalizeDiscourseTopic(topic, {
    sourceUrl, users, origin: LINUXDO_ORIGIN, platform: 'linux.do',
  });
}

export function collectLinuxdo({ source, rule, auth, fetch, fetchImpl, proxy = '', timeoutMs, retries } = {}) {
  return collectDiscourse({
    source, rule, auth, fetch, fetchImpl, proxy, timeoutMs, retries,
    origin: LINUXDO_ORIGIN, platform: 'linux.do',
  });
}

export function fetchLinuxdoCategories({ fetch, fetchImpl, proxy = '', timeoutMs, retries } = {}) {
  return fetchDiscourseCategories({
    origin: LINUXDO_ORIGIN, fetch, fetchImpl, proxy, timeoutMs, retries,
  });
}

export const linuxdoAdapter = createDiscourseAdapter({
  id: 'linux.do',
  label: 'linux.do',
  origin: LINUXDO_ORIGIN,
  defaultUrl: LINUXDO_DEFAULT_URL,
});
