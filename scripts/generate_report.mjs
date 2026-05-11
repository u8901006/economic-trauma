import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

const API_BASE = process.env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
const PRIMARY_MODEL = 'glm-5-turbo';
const FALLBACK_MODELS = ['glm-4.7', 'glm-4.7-flash'];
const DEDUP_FILE = 'data/summarized_pmids.json';

const SYSTEM_PROMPT = `你是「經濟創傷」(Economic Trauma) 跨領域研究的資深學者與科學傳播者。你的任務是：
1. 從提供的醫學、公共衛生、心理學、神經科學、社會學文獻中，篩選出與經濟創傷最相關的論文
2. 經濟創傷涵蓋：財務壓力、債務、失業、貧窮、住房不穩定、食物不安全、經濟虐待、醫療財務毒性、衰退/緊縮、社會不平等，及其對創傷壓力、心理健康、壓力生物學的影響
3. 對每篇論文進行繁體中文摘要、分類、PICO 分析
4. 評估其臨床/政策實用性（高/中/低）
5. 生成適合醫療專業人員與社會科學研究者閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP Picks（最重要/最影響實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const VALID_TAGS = [
  '財務壓力', '債務與破產', '失業與就業不穩', '貧窮與剝奪',
  '住房不穩定', '食物不安全', '經濟虐待', '醫療財務毒性',
  '衰退與緊縮', '社會不平等', '稀缺心理學', '壓力生物學',
  '神經科學', '創傷與壓力', '憂鬱症', '焦慮症', 'PTSD',
  '自殺風險', '物質使用', '失眠與睡眠', '兒童發展',
  '家庭壓力模式', '介入與政策', '神經影像學', '異常負荷',
  '老人精神醫學', '移民與難民', '復原與韌性', '公共衛生',
];

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = firstNewline >= 0 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/,'').trim();
  }
  try { return JSON.parse(cleaned); } catch {}
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  return null;
}

function loadPapers(inputPath) {
  const raw = inputPath === '-'
    ? readFileSync(0, 'utf-8')
    : readFileSync(inputPath, 'utf-8');
  return JSON.parse(raw);
}

function loadSummarizedPmids() {
  if (!existsSync(DEDUP_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DEDUP_FILE, 'utf-8')).pmids || [];
  } catch { return []; }
}

function saveSummarizedPmids(existing, newPmids) {
  const merged = [...new Set([...existing, ...newPmids])];
  const data = { pmids: merged, lastUpdated: new Date().toISOString() };
  const dir = dirname(DEDUP_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DEDUP_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

async function analyzePapers(apiKey, papersData) {
  const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const dateStr = papersData.date || tz;
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新經濟創傷相關文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點，聚焦經濟創傷面向",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床/政策意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施或暴露因子",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "財務壓力": 3,
    "憂鬱症": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${VALID_TAGS.join('、')}
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const basePayload = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 50000,
  };

  const modelsToTry = [PRIMARY_MODEL, ...FALLBACK_MODELS];

  for (const model of modelsToTry) {
    const payload = { ...basePayload, model };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(480000),
        });

        if (resp.status === 429) {
          const wait = 60 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait}s...`);
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error(`[ERROR] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
          if (resp.status === 429) {
            const wait = 60 * (attempt + 1);
            await new Promise(r => setTimeout(r, wait * 1000));
            continue;
          }
          break;
        }

        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || '';
        const result = tryParseJson(text);

        if (!result) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}`);
          if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        console.error(`[INFO] Analysis complete: ${(result.top_picks || []).length} top picks, ${(result.all_papers || []).length} total`);
        return result;
      } catch (e) {
        if (e.name === 'TimeoutError') {
          console.error(`[WARN] ${model} timed out on attempt ${attempt + 1}`);
        } else {
          console.error(`[ERROR] ${model} failed: ${e.message}`);
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  console.error('[ERROR] All models and attempts failed');
  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const parts = dateStr.split('-');
  const dateDisplay = parts.length === 3
    ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`
    : dateStr;

  const summary = escapeHtml(analysis.market_summary || '');
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHtml = '';
  for (const pick of topPicks) {
    const tags = (pick.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = pick.clinical_utility || '中';
    const utilClass = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    const pico = pick.pico || {};
    const picoHtml = Object.keys(pico).length ? `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome || '-')}</span></div>
            </div>` : '';
    topPicksHtml += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${pick.rank || ''}</span>
            <span class="emoji-icon">${pick.emoji || '\u{1F4C4}'}</span>
            <span class="${utilClass}">${escapeHtml(util)}實用性</span>
          </div>
          <h3>${escapeHtml(pick.title_zh || pick.title_en || '')}</h3>
          <p class="journal-source">${escapeHtml(pick.journal || '')} \u00b7 ${escapeHtml(pick.title_en || '')}</p>
          <p>${escapeHtml(pick.summary || '')}</p>
          ${picoHtml}
          <div class="card-footer">
            ${tags}
            <a href="${escapeHtml(pick.url || '#')}" target="_blank" rel="noopener">\u95b1\u8b80\u539f\u6587 \u2192</a>
          </div>
        </div>`;
  }

  let allPapersHtml = '';
  for (const paper of allPapers) {
    const tags = (paper.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = paper.clinical_utility || '中';
    const utilClass = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    allPapersHtml += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji || '\u{1F4C4}'}</span>
            <span class="${utilClass} utility-sm">${escapeHtml(util)}</span>
          </div>
          <h3>${escapeHtml(paper.title_zh || paper.title_en || '')}</h3>
          <p class="journal-source">${escapeHtml(paper.journal || '')}</p>
          <p>${escapeHtml(paper.summary || '')}</p>
          <div class="card-footer">
            ${tags}
            <a href="${escapeHtml(paper.url || '#')}" target="_blank" rel="noopener">PubMed \u2192</a>
          </div>
        </div>`;
  }

  const keywordsHtml = keywords.map(k => `<span class="keyword">${escapeHtml(k)}</span>`).join('');
  let topicBarsHtml = '';
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    topicBarsHtml = Object.entries(topicDist).map(([topic, count]) => {
      const widthPct = Math.round((count / maxCount) * 100);
      return `
            <div class="topic-row">
              <span class="topic-name">${escapeHtml(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    }).join('');
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Economic Trauma \u00b7 \u7d93\u6fdf\u5275\u50b7\u7814\u7a76\u6587\u737b\u65e5\u5831 \u00b7 ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} \u7d93\u6fdf\u5275\u50b7\u7814\u7a76\u6587\u737b\u65e5\u5831\uff0c\u7531 AI \u81ea\u52d5\u5f59\u6574 PubMed \u6700\u65b0\u8ad6\u6587"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; animation: fadeUp 0.5s ease 0.4s both; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">\u{1F4CA}</div>
    <div class="header-text">
      <h1>Economic Trauma \u00b7 \u7d93\u6fdf\u5275\u50b7\u7814\u7a76\u6587\u737b\u65e5\u5831</h1>
      <div class="header-meta">
        <span class="badge badge-date">\u{1F4C5} ${dateDisplay}</span>
        <span class="badge badge-count">\u{1F4CA} ${totalCount} \u7bc7\u6587\u737b</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>\u{1F4CB} \u4eca\u65e5\u6587\u737b\u8d8b\u52e2</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\u2b50</span>\u4eca\u65e5\u7cbe\u9078 TOP Picks</div>${topPicksHtml}</div>` : ''}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\u{1F4DA}</span>\u5176\u4ed6\u503c\u5f97\u95dc\u6ce8\u7684\u6587\u737b</div>${allPapersHtml}</div>` : ''}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">\u{1F4CA}</span>\u4e3b\u984c\u5206\u4f48</div>${topicBarsHtml}</div>` : ''}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">\u{1F3F7}\uFE0F</span>\u95dc\u9375\u5b57</div><div class="keywords">${keywordsHtml}</div></div>` : ''}

  <div class="clinic-banner">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">\u{1F3E5}</span>
      <span class="clinic-name">\u674e\u653f\u6d0b\u8eab\u5fc3\u8a3a\u6240\u9996\u9801</span>
      <span class="clinic-arrow">\u2192</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">\u{1F4E8}</span>
      <span class="clinic-name">\u8a02\u95b1\u96fb\u5b50\u5831</span>
      <span class="clinic-arrow">\u2192</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">\u2615</span>
      <span class="clinic-name">Buy Me a Coffee</span>
      <span class="clinic-arrow">\u2192</span>
    </a>
  </div>

  <footer>
    <span>\u8cc7\u6599\u4f86\u6e90\uff1aPubMed \u00b7 \u5206\u6790\u6a21\u578b\uff1a${PRIMARY_MODEL}</span>
    <span><a href="https://github.com/u8901006/economic-trauma">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: '', output: '' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': opts.input = args[++i]; break;
      case '--output': opts.output = args[++i]; break;
      case '--api-key': opts.apiKey = args[++i]; break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const apiKey = opts.apiKey || process.env.ZHIPU_API_KEY || '';
  if (!apiKey) {
    console.error('[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key');
    process.exit(1);
  }
  if (!opts.input || !opts.output) {
    console.error('[ERROR] --input and --output are required');
    process.exit(1);
  }

  const papersData = loadPapers(opts.input);
  const existingPmids = loadSummarizedPmids();
  const newPmids = (papersData.papers || []).map(p => p.pmid).filter(Boolean);

  let analysis;
  if (!papersData.papers || papersData.papers.length === 0) {
    console.error('[WARN] No new papers, generating empty report');
    const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    analysis = {
      date: tz,
      market_summary: '\u4eca\u65e5 PubMed \u66ab\u7121\u65b0\u7684\u7d93\u6fdf\u5275\u50b7\u76f8\u95dc\u6587\u737b\u66f4\u65b0\u3002\u8acb\u660e\u5929\u518d\u67e5\u770b\u3002',
      top_picks: [], all_papers: [], keywords: [], topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(apiKey, papersData);
    if (!analysis) {
      console.error('[ERROR] Analysis failed, cannot generate report');
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  const outDir = dirname(opts.output);
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(opts.output, html, 'utf-8');
  console.error(`[INFO] Report saved to ${opts.output}`);

  if (newPmids.length > 0) {
    saveSummarizedPmids(existingPmids, newPmids);
    console.error(`[INFO] Updated dedup file with ${newPmids.length} new PMIDs`);
  }
}

main().catch(e => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
