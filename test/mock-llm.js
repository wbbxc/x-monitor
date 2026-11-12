// 测试用 mock LLM 服务器：模拟 OpenAI 兼容 /chat/completions
// 用于在无真实 API Key 时验证 分析/创作 全流程的 JSON 契约
import http from 'node:http';

const RESPONSE = {
  suitable: true,
  score: 88,
  title: '【测试】AI 智能体正在重塑软件开发流程',
  summary: '这是一条由 mock LLM 生成的测试素材摘要，用于验证流水线 JSON 契约。',
  category: '行业动态',
  tags: ['AI Agent', '软件开发', '效率工具'],
  suggested_types: ['article', 'image', 'video_script'],
  reason: '测试用分析结果',
  // creator: article
  read_minutes: 6,
  body: '## 引言\n\nAI 智能体正在重塑软件开发流程，这是一个重要的行业信号。\n\n## 主体\n\n- 第一点：自动化程度显著提升\n- 第二点：团队协作方式改变\n\n## 总结\n\n未来属于善于使用 AI 的团队。',
  // creator: image
  concept: '未来开发者在云端工作流中与 AI 智能体协作的画面',
  prompt_zh: '赛博朋克风格的开发者工作台，全息屏幕，AI 智能体以光流形态穿梭于代码之间，蓝色主色调，电影级布光',
  prompt_en: 'cyberpunk developer workspace, holographic screens, AI agent as streams of light flowing through code, blue color palette, cinematic lighting, 8k',
  negative_prompt: '低质量，模糊，文字错误',
  style: '赛博朋克 / 3D 渲染',
  aspect_ratio: '16:9',
  usage_suggestion: '作为文章封面图或视频封面',
  // creator: video_script
  duration_seconds: 45,
  orientation: '竖屏 9:16',
  hook: '你的程序员同事，可能很快要被 AI 取代了。',
  scenes: [
    { no: 1, time: '0-3s', scene: '特写：程序员敲键盘，屏幕上 AI 自动补全代码', voiceover: '你的程序员同事，可能很快要被 AI 取代了。', on_screen_text: 'AI 正在改变一切', bgm: '紧张电子乐' },
    { no: 2, time: '3-15s', scene: '全景：AI 智能体在多个任务间切换', voiceover: '但取代他的不是 AI，而是会用 AI 的人。', on_screen_text: '', bgm: '节奏渐进' },
    { no: 3, time: '15-45s', scene: '采访式口播 + 数据图表动画', voiceover: '掌握智能体工作流，让你的效率翻倍。', on_screen_text: '效率 x10', bgm: '积极向上' },
  ],
  cta: '评论区聊聊你正在用 AI 做什么？关注我，看更多 AI 实战。',
};

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : {};
  const wantsJson = parsed.response_format?.type === 'json_object';

  let content;
  if (wantsJson) {
    content = JSON.stringify(RESPONSE);
  } else {
    content = 'OK';
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});

server.listen(3999, () => console.log('mock-llm listening on :3999'));
