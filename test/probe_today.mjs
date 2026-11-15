import { launch, PHOTO_PAGE } from '../src/browser.mjs';
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const post = async (body) => JSON.parse(await (await fetch('https://webapi.5181688.com/v5/workgroup/photos', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).text());
  const mk = (from, to) => ({
    filter: {
      searchKeywords: [], mediaType: null, sourceType: null,
      times: [{ start: `${from} 00:00:00`, end: `${to} 23:59:59` }],
      userIDList: [], excludeUserIDList: [], departmentIDList: ['0'], watermarks: [], locations: [],
      useSegment: true, useSynonym: false, useSuggestedSearch: true, suggestedSearchWords: [],
      locationRecommend: {}, excludeKeywords: [], existWatermark: 0, labelIDs: [], labelMatchAll: false, untaggedOnly: false,
    },
    isPreciseSearch: false, isAscSort: false, groupID, lastPageCond: '',
  });
  const res = {};
  for (const d of ['2026-11-14', '2026-11-15', '2026-11-16']) {
    const r = await post(mk(d, d));
    res[d] = r.payload ? r.payload.total : `status=${r.status}`;
  }
  return res;
});
console.log('按日期的照片总数：', JSON.stringify(out, null, 2));
await ctx.close();
