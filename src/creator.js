// 多类型自动创作：文章 / 配图 / 视频脚本
import { chat, chatJson } from './llm.js';
import { config } from './config.js';

const TYPES = {
  article: '文章',
  image: '配图',
  video_script: '视频脚本',
};

function materialContext(material) {
  return `
【素材标题】${material.title}
【素材摘要】${material.summary}
【素材分类】${material.category}
【素材标签】${(material.tags || []).join('、')}
【原始推文】@${material.author_username || ''}：${(material.tweet_text || '').slice(0, 2000)}
【分析理由】${material.score_reason || ''}
【创意评分】${material.score}`;
}

// ---------------- 文章 ----------------
async function createArticle(material) {
  const prompt = `你是资深 AI 科技内容主编，请基于以下创意素材撰写一篇高质量中文长文。

${materialContext(material)}

【写作要求】
1. 标题要有吸引力但不标题党
2. 结构清晰：引言（hook）→ 主体（3-5 个小节，用小标题分隔）→ 总结与延伸思考
3. 结合素材中的事实/观点展开，可补充行业背景与延伸分析
4. 风格专业、克制、有信息密度，避免空洞套话
5. 正文用 Markdown 格式（## 小标题、列表、加粗）

输出 JSON：
{
  "title": "文章标题",
  "summary": "80字以内摘要",
  "read_minutes": 预计阅读分钟数,
  "tags": ["标签1","标签2"],
  "body": "完整 Markdown 正文"
}`;

  const r = await chatJson([{ role: 'user', content: prompt }], {
    title: 'string', summary: 'string', read_minutes: 'number', tags: 'array', body: 'string',
  }, { temperature: 0.7, maxTokens: 4000 });

  return {
    title: r.title,
    content: {
      type: 'article',
      title: r.title,
      summary: r.summary,
      read_minutes: Number(r.read_minutes) || 5,
      tags: r.tags || [],
      body: r.body,
    },
  };
}

// ---------------- 配图 ----------------
async function createImage(material) {
  const prompt = `你是顶级 AI 视觉创意指导。请基于以下创意素材，设计一张可用于内容传播的配图方案。

${materialContext(material)}

【设计思路】
1. 提炼素材的核心视觉隐喻，避免直白图解
2. 给出构图、色彩、质感、风格的明确指引
3. 提供可直接用于 Midjourney / Stable Diffusion / DALL-E 的文生图提示词

输出 JSON：
{
  "title": "配图方案名称",
  "concept": "核心视觉概念（中文，150字内）",
  "prompt_zh": "中文文生图提示词（含主体、环境、光线、风格、质感、镜头），200字内",
  "prompt_en": "对应英文提示词（可直接投喂文生图模型）",
  "negative_prompt": "负面提示词（要避免的元素）",
  "style": "风格标签，如：赛博朋克 / 极简3D / 手绘插画 / 摄影写实",
  "aspect_ratio": "建议比例，如 16:9、1:1、9:16",
  "usage_suggestion": "该配图适合用在哪（封面/正文插图/海报）"
}`;

  const r = await chatJson([{ role: 'user', content: prompt }], {
    title: 'string', concept: 'string', prompt_zh: 'string', prompt_en: 'string',
    negative_prompt: 'string', style: 'string', aspect_ratio: 'string', usage_suggestion: 'string',
  }, { temperature: 0.8, maxTokens: 2000 });

  return {
    title: r.title,
    content: { type: 'image', ...r },
  };
}

// ---------------- 视频脚本 ----------------
async function createVideoScript(material) {
  const prompt = `你是短视频导演，请基于以下创意素材写一个 60 秒内的口播短视频分镜脚本。

${materialContext(material)}

【脚本要求】
1. 开头 3 秒必须有强钩子（制造好奇/冲突/反差）
2. 节奏紧凑，信息分层递进
3. 每句口播都要有对应画面描述
4. 结尾给出引导互动的话术（评论/关注）
5. 总时长控制在 60 秒内

输出 JSON：
{
  "title": "视频标题",
  "duration_seconds": 总时长秒数,
  "orientation": "竖屏 9:16 或 横屏 16:9",
  "hook": "开头钩子话术（一句话）",
  "scenes": [
    {
      "no": 1,
      "time": "0-3s",
      "scene": "画面描述（含运镜、字幕、特效）",
      "voiceover": "口播台词",
      "on_screen_text": "屏幕文字（可为空）",
      "bgm": "配乐建议"
    }
  ],
  "cta": "结尾引导话术"
}`;

  const r = await chatJson([{ role: 'user', content: prompt }], {
    title: 'string', duration_seconds: 'number', orientation: 'string',
    hook: 'string', scenes: 'array', cta: 'string',
  }, { temperature: 0.8, maxTokens: 3000 });

  return {
    title: r.title,
    content: {
      type: 'video_script',
      title: r.title,
      duration_seconds: Number(r.duration_seconds) || 60,
      orientation: r.orientation || '竖屏 9:16',
      hook: r.hook,
      scenes: Array.isArray(r.scenes) ? r.scenes.slice(0, 12) : [],
      cta: r.cta,
    },
  };
}

const ROUTER = { article: createArticle, image: createImage, video_script: createVideoScript };

/**
 * 执行一次创作任务（同步阻塞，调用方负责异步化）。
 * @param {object} material 素材对象（materials.get 的返回）
 * @param {'article'|'image'|'video_script'} type
 * @returns {Promise<{title:string, content:object}>}
 */
export async function createFromMaterial(material, type) {
  const fn = ROUTER[type];
  if (!fn) throw new Error(`不支持的创作类型: ${type}`);
  return fn(material);
}

export function contentTypeLabel(type) {
  return TYPES[type] || type;
}

// 快速验证 LLM 配置
export async function pingLLM() {
  const r = await chat([{ role: 'user', content: '只回复 OK' }], { maxTokens: 10, temperature: 0 });
  return r.trim().toUpperCase().includes('OK');
}
