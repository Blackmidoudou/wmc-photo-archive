import { launch, PHOTO_PAGE } from '../src/browser.mjs';

const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const H = { 'Content-Type': 'application/json' };
  const post = async (url, body) => {
    const res = await fetch('https://webapi.5181688.com' + url, {
      method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(body),
    });
    return JSON.parse(await res.text());
  };
  const getJson = async (url) => {
    const res = await fetch('https://webapi.5181688.com' + url, { credentials: 'include' });
    return JSON.parse(await res.text());
  };
  const wms = (await getJson('/v4/workgroup/watermarks?group_id=' + groupID)).data.payload;

  const mk = (watermarks) => ({
    filter: {
      searchKeywords: [], mediaType: null, sourceType: null,
      times: [{ start: '2026-11-15 00:00:00', end: '2026-11-15 23:59:59' }],
      userIDList: [], excludeUserIDList: [], departmentIDList: ['0'],
      watermarks, locations: [], useSegment: true, useSynonym: false,
      useSuggestedSearch: true, suggestedSearchWords: [], locationRecommend: {},
      excludeKeywords: [], existWatermark: 0, labelIDs: [], labelMatchAll: false, untaggedOnly: false,
    },
    isPreciseSearch: false, isAscSort: false, groupID, lastPageCond: '',
  });

  const base = await post('/v5/workgroup/photos', mk([]));
  const baseTotal = base.payload.total;

  const rows = [];
  for (const w of wms) {
    if (!w.group_watermark_id && w.watermark_base_id !== '0') continue; // 先测团队模板
    const r = await post('/v5/workgroup/photos', mk(w.group_watermark_id ? [w.group_watermark_id] : []));
    rows.push({ name: w.name, gid: (w.group_watermark_id || '').slice(0, 8), base: w.watermark_base_id, type: w.type, total: r.payload.total });
  }
  return { baseTotal, rows, teamCount: wms.filter((w) => w.group_watermark_id).length };
});

console.log('区间总数:', out.baseTotal, '| 团队模板数:', out.teamCount);
console.log('\n按模板过滤的结果：');
for (const r of out.rows) console.log(`  ${String(r.name).padEnd(24)} type=${r.type} base=${String(r.base).padEnd(4)} gid=${r.gid || '-'} → ${r.total}`);
await ctx.close();
