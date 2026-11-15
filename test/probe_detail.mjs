import { launch, PHOTO_PAGE } from '../src/browser.mjs';

const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const hits = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!u.includes('webapi') && !u.includes('/api/')) return;
  if (/sentry|abtest|ca\/v1\/log|xiaohei-claw/.test(u)) return;
  try {
    const t = (res.headers()['content-type'] || '').toLowerCase();
    if (!t.includes('json')) return;
    const body = await res.text();
    if (!/watermark/i.test(body) && !/水印/.test(body)) return;
    hits.push({ url: u.replace('https://webapi.5181688.com', ''), len: body.length, body });
  } catch {}
});

await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// 点第一张照片，触发详情
const imgs = page.locator('img[src*="net-cloud"]');
const n = await imgs.count();
console.log('页面图片数:', n);
if (n) {
  await imgs.first().click({ force: true }).catch((e) => console.log('点击失败', e.message));
  await page.waitForTimeout(4000);
}

console.log('\n=== 含 watermark 的接口 ===');
for (const h of hits) {
  console.log('\n' + h.url, `(${h.len}B)`);
  console.log(h.body.slice(0, 700).replace(/\s+/g, ' '));
}
await ctx.close();
