// 统一匹配器：关键词、排除、作者、标签、正则和旧规则兼容。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileMatcher, matchesRule, normalizeMatchText, validateMatch,
} from '../src/collectors/match.js';

test('关键词大小写不敏感，中文子串命中', () => {
  const matcher = compileMatcher({ match: { includeAny: ['Agent', '大模型'] } });
  assert.equal(matcher.predicate({ title: 'Building an autonomous agent' }), true);
  assert.equal(matcher.predicate({ content: '开源大模型发布' }), true);
  assert.equal(matcher.predicate({ content: '无关内容' }), false);
  assert.equal(normalizeMatchText('  ＡＩ　安全  '), 'AI 安全');
});

test('wholeWord 避免拉丁词内部误命中，中文仍按子串', () => {
  const latin = compileMatcher({ match: { includeAny: ['AI'], wholeWord: true } });
  assert.equal(latin.predicate({ title: 'AI safety' }), true);
  assert.equal(latin.predicate({ title: 'said email' }), false);
  const chinese = compileMatcher({ match: { includeAny: ['大模型'], wholeWord: true } });
  assert.equal(chinese.predicate({ content: '开源大模型发布' }), true);
});

test('includeAll 必须全部命中，excludeAny 优先拒绝', () => {
  const all = compileMatcher({ match: { includeAll: ['AI', 'agent'] } });
  assert.equal(all.predicate({ title: 'AI agent' }), true);
  assert.equal(all.predicate({ title: 'AI only' }), false);
  const excluded = compileMatcher({ match: { includeAny: ['AI'], excludeAny: ['招聘'] } });
  assert.equal(excluded.predicate({ title: 'AI 招聘' }), false);
});

test('作者 @ 归一化与精确匹配', () => {
  const contains = compileMatcher({ match: { authors: ['@karpathy'] } });
  assert.equal(contains.predicate({ author: 'karpathy' }), true);
  const exact = compileMatcher({ match: { authors: ['=sama'] } });
  assert.equal(exact.predicate({ author: 'sama' }), true);
  assert.equal(exact.predicate({ author: 'sama_fan' }), false);
});

test('标签与媒体条件', () => {
  const tagged = compileMatcher({ match: { tags: ['#AI'] } });
  assert.equal(tagged.predicate({ metadata: { tags: ['ai'] } }), true);
  assert.equal(tagged.predicate({ metadata: { tags: ['other'] } }), false);
  const media = compileMatcher({ match: { requireMedia: true } });
  assert.equal(media.predicate({ metadata: { media: [{ url: 'https://example.com/a.png' }] } }), true);
  assert.equal(media.predicate({ metadata: {} }), false);
});

test('正则校验与匹配，非法表达式被拒绝', () => {
  const matcher = compileMatcher({ match: { regex: ['\\bGPT-?[45]\\b'] } });
  assert.equal(matcher.predicate({ content: 'GPT-5 released' }), true);
  assert.equal(matcher.predicate({ content: 'GPT-3' }), false);
  assert.throws(() => validateMatch({ regex: ['[unclosed'] }), /正则条件无效/);
  assert.throws(() => validateMatch({ regex: ['x'.repeat(201)] }), /不能超过/);
  assert.throws(() => validateMatch({ unknown: 1 }), /未知匹配条件字段/);
});

test('空条件放行，来源默认值与规则覆盖', () => {
  assert.equal(compileMatcher({}).predicate({ title: 'anything' }), true);
  const matcher = compileMatcher({
    defaults: { excludeAny: ['spam'], includeAny: ['AI'] },
    match: { excludeAny: ['广告'] },
  });
  assert.equal(matcher.predicate({ title: 'AI 广告' }), false);
  assert.equal(matcher.predicate({ title: 'AI spam' }), true, '规则级 excludeAny 覆盖来源默认值');
});

test('旧规则没有 match 时保持 kind/value 语义', () => {
  assert.equal(matchesRule({ title: 'AI news' }, { kind: 'keyword', value: 'AI' }), true);
  assert.equal(matchesRule({ title: 'Other' }, { kind: 'keyword', value: 'AI' }), false);
  assert.equal(matchesRule({ author: 'karpathy' }, { kind: 'account', value: '@karpathy' }), true);
  assert.equal(matchesRule({ title: 'any' }, { kind: 'full', value: '' }), true);
  assert.equal(matchesRule({ title: 'AI 招聘' }, { kind: 'keyword', value: '', match: { excludeAny: ['招聘'] } }), false);
});
