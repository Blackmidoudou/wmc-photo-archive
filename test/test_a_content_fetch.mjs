import { launch, PHOTO_PAGE } from '../src/browser.mjs';

const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// 复刻 content.js 的请求方式：页面上下文 + credentials:include
const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const body = {
    filter: {
      searchKeywords: [], mediaType: null, sourceType: null,
      times: [{ start: '2026-11-15 00:00:00', end: '2026-11-15 23:59:59' }],
      userIDList: [], excludeUserIDList: [], departmentIDList: ['0'],
      watermarks: [], locations: [], useSegment: true, useSynonym: false,
      useSuggestedSearch: true, suggestedSearchWords: [], locationRecommend: {},
      excludeKeywords: [], existWatermark: 0, labelIDs: [], labelMatchAll: false, untaggedOnly: false,
    },
    isPreciseSearch: false, isAscSort: false, groupID, lastPageCond: '',
  };
  try {
    const res = await fetch('https://webapi.5181688.com/v5/workgroup/photos', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, err: text.slice(0, 200) };
    const j = JSON.parse(text);
    const p = j.payload || {};
    return {
      ok: j.status === 0, status: res.status, statusField: j.status,
      total: p.total, got: (p.photos || []).length,
      first: (p.photos || [])[0] && {
        person: p.photos[0].userNickname, time: p.photos[0].time,
        media: !!(p.photos[0].largeURL || p.photos[0].videoURL),
      },
      cursor: (p.lastPageCond || '').slice(0, 12),
      groupID,
    };
  } catch (e) {
    return { ok: false, err: 'fetch 抛错: ' + e.message };
  }
});

console.log('结果:', JSON.stringify(out, null, 2));
await ctx.close();
process.exit(out.ok ? 0 : 1);
