import { readdirSync, writeFileSync } from 'fs';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const files = readdirSync('docs')
  .filter(f => f.startsWith('economic-trauma-') && f.endsWith('.html'))
  .sort()
  .reverse();

const links = files.slice(0, 30).map(name => {
  const date = name.replace('economic-trauma-', '').replace('.html', '');
  let display = date;
  let weekday = '';
  try {
    const d = new Date(date);
    if (!isNaN(d)) {
      display = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      weekday = WEEKDAYS[d.getDay()];
    }
  } catch { /* keep raw */ }
  return `<li><a href="${encodeURI(name)}">\u{1F4C5} ${display}\uFF08\u9031${weekday}\uFF09</a></li>`;
}).join('\n');

const total = files.length;

const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Economic Trauma \u00b7 \u7d93\u6fdf\u5275\u50b7\u7814\u7a76\u6587\u737b\u65e5\u5831</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
  .footer-links { margin-top: 20px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .footer-links a { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; font-size: 13px; color: var(--text); }
  .footer-links a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">\u{1F4CA}</div>
  <h1>Economic Trauma</h1>
  <p class="subtitle">\u7d93\u6fdf\u5275\u50b7\u7814\u7a76\u6587\u737b\u65e5\u5831 \u00b7 \u6bcf\u65e5\u81ea\u52d5\u66f4\u65b0</p>
  <p class="count">\u5171 ${total} \u671f\u65e5\u5831</p>
  <ul>${links}</ul>
  <div class="footer-links">
    <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">\u{1F3E5} \u674e\u653f\u6d0b\u8eab\u5fc3\u8a3a\u6240\u9996\u9801</a>
    <a href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener">\u{1F4E8} \u8a02\u95b1\u96fb\u5b50\u5831</a>
    <a href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener">\u2615 Buy Me a Coffee</a>
  </div>
  <footer>
    <p>Powered by PubMed + Zhipu AI \u00b7 <a href="https://github.com/u8901006/economic-trauma">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

writeFileSync('docs/index.html', html, 'utf-8');
console.log('Index page generated');
