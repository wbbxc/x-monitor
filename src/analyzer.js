// 素材分析器（keep-all 分支：全量收录，分析仅作人工参考）
import { chatJson } from './llm.js';

const SCHEMA = {
  suitable: 'boolean',
  score: 'number',        // 0-100
  title: 'string',
  summary: 'string',
  category: 'string',     // 如：模型发布 / 开源工具 / 论文解读 / 观点金句 / 行业动态 / 技术教程
  tags: 'array',          // 2-6 个标签
  suggested_types: 'array', // 建议创作类型：article / image / video_script
  reason: 'string',
};

/**
 * 分析单条推文是否值得进入素材库。
 * @param {object} tweet
 * @returns {Promise<{suitable:boolean, score:number, title:string, summary:string,
 *                    category:string, tags:string[], suggested_types:string[], reason:string}>}
 */
export async function analyzeTweet(tweet) {
  const mediaDesc = Array.isArray(tweet.media) && tweet.media.length
    ? tweet.media.map((m) => (m.type || 'image') + (m.url ? ` ${m.url}` : '')).join('; ')
    : '无';
  const engagement = [
    tweet.like_count ? `点赞 ${tweet.like_count}` : '',
    tweet.retweet_count ? `转发 ${tweet.retweet_count}` : '',
    tweet.reply_count ? `评论 ${tweet.reply_count}` : '',
    tweet.view_count ? `浏览 ${tweet.view_count}` : '',
  ].filter(Boolean).join('，') || '互动数据未知';

  const prompt = `你是资深 AI 内容创意总监，负责为 X (Twitter) 上 AI 领域账号的推文做创意价值分析，供人工筛选参考。

【推文原文】
作者：@${tweet.author_username}（${tweet.author_name || '未知'}）
发布时间：${tweet.tweet_created_at || '未知'}
互动：${engagement}
附件：${mediaDesc}
内容：
${tweet.text.slice(0, 2800)}

【说明】
本系统采用「全量收录、人工决断」策略：所有推文都会进入素材库，由人工确认是否使用。
因此你的分析是参考信息，请如实评估，不要因为"不够有价值"而刻意压低评分——低价值内容也会被收录，交给人工判断。

【评估维度】
1. 信息是否新鲜、有独到观点或实用价值（新品发布、开源项目、技术解读、行业洞察、金句观点等）
2. 是否具备二次创作空间（可延展成文章、图解、短视频脚本）
3. 是否代表 AI 行业趋势或热门话题
4. 主观评分即可，无需考虑是否"应该"被收录

【输出要求】
- suitable: 是否值得优先关注（供人工参考，不决定是否收录）
- score: 创意价值评分 0-100（供人工参考排序）
- title: 一句有吸引力的素材标题（中文）
- summary: 80 字以内的素材摘要（中文）
- category: 从 [模型发布, 开源项目, 论文解读, 观点金句, 行业动态, 技术教程, 产品体验, 其他] 中选一个
- tags: 2-6 个中文标签
- suggested_types: 从 ["article","image","video_script"] 中选 1-3 个最合适创作的类型
- reason: 一句话说明该内容的价值点或注意事项（中文）`;

  const result = await chatJson(
    [{ role: 'user', content: prompt }],
    SCHEMA,
    { temperature: 0.4, maxTokens: 1200 }
  );

  return {
    suitable: !!result.suitable,
    score: Math.max(0, Math.min(100, Number(result.score) || 0)),
    title: String(result.title || '').slice(0, 120),
    summary: String(result.summary || '').slice(0, 300),
    category: String(result.category || '其他'),
    tags: Array.isArray(result.tags) ? result.tags.map(String).slice(0, 6) : [],
    suggested_types: Array.isArray(result.suggested_types)
      ? result.suggested_types.filter((t) => ['article', 'image', 'video_script'].includes(t)).slice(0, 3)
      : [],
    reason: String(result.reason || ''),
  };
}

/**
 * 分析一批新推文，全量收录进素材库（pending 状态，交由人工决断）。
 * @returns {Promise<{analyzed:number, added:number, skipped:number}>}
 */
export async function analyzeNewTweets(tweetRepo, materialRepo) {
  const queue = tweetRepo.newUnanalyzed(30);
  let analyzed = 0, added = 0, skipped = 0;

  for (const tweet of queue) {
    analyzed++;
    try {
      const r = await analyzeTweet(tweet);
      // 「全量收录」策略：不按评分/适合度过滤，所有推文都进素材库，由人工确认
      if (!materialRepo.existsByTweet(tweet.id)) {
        materialRepo.insert({
          tweet_id: tweet.id,
          title: r.title || tweet.text.slice(0, 40),
          summary: r.summary,
          score: r.score,
          score_reason: r.reason,
          category: r.category,
          tags: r.tags,
          suggested_types: r.suggested_types,
          analysis_raw: r,
        });
        added++;
      } else {
        skipped++; // 仅重复内容才跳过
      }
      tweetRepo.markAnalyzed(tweet.id, 'analyzed');
    } catch (err) {
      // 分析失败（如未配 Key/超时/限流）：不标记淘汰，保持 new 状态下轮重试
      console.error(`[analyze] 分析推文 ${tweet.id} 失败:`, err.message);
    }
  }
  return { analyzed, added, skipped };
}
