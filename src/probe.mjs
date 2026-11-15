// 第二步：探测
// 在已登录状态下打开照片列表页，把页面发出的所有接口响应记录下来，
// 同时保存页面 HTML 和截图。目的是搞清楚「列表接口长什么样」，
// 之后导出脚本直接照着这个接口翻页，比点 DOM 稳得多。
import fs from 'node:fs';
import path from 'node:path';
import { launch, PHOTO_PAGE, PROBE_DIR, looksLoggedOut } from './browser.mjs';

const MAX_BODY = 300 * 1024;

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.pathname + (x.search ? '?' + x.search.slice(1, 120) : '');
  } catch {
    return u;
  }
}

export async function probe({ headless = false, scrolls = 10 } = {}) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const ctx = await launch({ headless });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const records = [];
  page.on('response', async (res) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (!['xhr', 'fetch', 'document'].includes(type)) return;
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      const isJson = ct.includes('json');
      const rec = {
        method: req.method(),
        url: res.url(),
        status: res.status(),
        type,
        contentType: ct,
        postData: req.postData()?.slice(0, 2000) ?? null,
        body: null,
        bodySize: null,
      };
      if (isJson || res.url().includes('/api/')) {
        try {
          const buf = await res.body();
          rec.bodySize = buf.length;
          if (buf.length <= MAX_BODY) rec.body = buf.toString('utf8');
        } catch {
          /* 响应体已不可读 */
        }
      }
      records.push(rec);
    } catch {
      /* 忽略个别失败 */
    }
  });

  console.log('\n正在打开照片列表页并滚动加载…\n');
  await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);

  if (looksLoggedOut(page.url())) {
    console.log('⚠️ 当前会话未登录（被跳到了登录页），请先运行 npm run login');
    await ctx.close();
    process.exit(3);
  }

  // 滚动触发懒加载 / 无限滚动，同时多抓几页数据用于确认分页参数
  const body = page.locator('body');
  for (let i = 1; i <= scrolls; i++) {
    await body.evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.waitForTimeout(1500);
    process.stdout.write(`\r滚动加载 ${i}/${scrolls}`);
  }
  process.stdout.write('\n');
  await page.waitForTimeout(1500);

  const stamp = ts();
  const html = await page.content().catch(() => '');
  const htmlPath = path.join(PROBE_DIR, `page-${stamp}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const shotPath = path.join(PROBE_DIR, `page-${stamp}.png`);
  await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

  // 按接口路径聚合，方便一眼看出哪个是列表接口
  const groups = new Map();
  for (const r of records) {
    const key = `${r.method} ${shortUrl(r.url)}`;
    const g = groups.get(key) ?? { key, count: 0, statuses: new Set(), hasBody: false, sample: null, url: r.url };
    g.count++;
    g.statuses.add(r.status);
    if (r.body) {
      g.hasBody = true;
      g.sample = g.sample ?? r.body.slice(0, 1200);
    }
    groups.set(key, g);
  }
  const summary = [...groups.values()]
    .map((g) => ({ key: g.key, count: g.count, statuses: [...g.statuses], hasBody: g.hasBody, sample: g.sample, url: g.url }))
    .sort((a, b) => b.count - a.count);

  const report = {
    probedAt: new Date().toISOString(),
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    htmlPath,
    screenshotPath: shotPath,
    requestCount: records.length,
    endpoints: summary,
    records,
  };
  const reportPath = path.join(PROBE_DIR, `capture-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n===== 探测结果 =====');
  console.log('最终 URL：', report.finalUrl);
  console.log('页面标题：', report.title);
  console.log('抓到的接口（按调用次数排序）：');
  for (const e of summary.slice(0, 25)) {
    if (!/^(GET|POST) (\/api|\/work|\/v\d)/.test(e.key)) continue;
    console.log(`  ${e.count}x  [${e.statuses.join(',')}]  ${e.key}`);
  }
  console.log('\n明细文件：', reportPath);
  console.log('截图：', shotPath);
  console.log('\n把 capture 文件里的内容给我（或直接告诉我文件名），我来写导出器。\n');

  await ctx.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  probe({ headless: process.argv.includes('--headless') }).catch((e) => {
    console.error('探测出错：', e.message);
    process.exit(1);
  });
}
