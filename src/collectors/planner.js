// Planner：把到期规则变成任务，负责抖动、合并和下一次时间。
import { collectionRules, collectionSources } from '../db.js';
import { enqueueJob } from './queue.js';
import { config } from '../config.js';

const DEFAULT_INTERVAL_MS = 60 * 60_000;

export function jitterMs(baseMs, random = Math.random) {
  const value = Math.max(60_000, Number(baseMs) || DEFAULT_INTERVAL_MS);
  return Math.round(value * (0.9 + random() * 0.2));
}

export function ruleDedupeKey(sourceId, ruleId) {
  return `source:${sourceId}:rule:${ruleId}`;
}

/**
 * 扫描到期规则并入队。同一规则已有活动任务时 coalesce，并推进 next_run_at。
 * 错过多个周期只补一次，避免重启后任务风暴。
 */
export function planDueRules({
  now = Date.now(), maxAttempts = config.collector.maxAttempts, random = Math.random,
} = {}) {
  const due = collectionRules.due(now);
  const jobs = [];
  let coalesced = 0;
  for (const rule of due) {
    const source = collectionSources.get(rule.source_id);
    if (!source || source.enabled === false) continue;
    const intervalMs = Math.max(60_000, Number(rule.interval_min) * 60_000);
    const nextRunAt = new Date(now + jitterMs(intervalMs, random)).toISOString();
    const result = enqueueJob({
      sourceId: source.id,
      ruleId: rule.id,
      mode: 'scheduled',
      priority: 50,
      dedupeKey: ruleDedupeKey(source.id, rule.id),
      payload: {
        source: { ...source, config: source.config || {} },
        rule,
        keyword: rule.value || '',
      },
      availableAt: now,
      maxAttempts,
      scheduledFor: rule.next_run_at || new Date(now).toISOString(),
      nextRunAt,
    });
    if (result.coalesced) coalesced++;
    jobs.push(result.job);
  }
  return { planned: jobs.length, coalesced, jobs };
}
