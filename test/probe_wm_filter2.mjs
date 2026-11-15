import { launch, PHOTO_PAGE } from '../src/browser.mjs';
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const post = async (body) => {
    const res = await fetch('https://webapi.5181688.com/v5/workgroup/photos', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await res.text();
  };
  const getJson = async (u) => JSON.parse(await (await fetch('https://webapi.5181688.com' + u, { credentials: 'include' })).text());
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

  const t1 = await post(mk([]));
  const sample = wms.find((w) => w.group_watermark_id);
  const t2 = await post(mk([sample.group_watermark_id]));
  const t3 = await post(mk([sample.name]));
  return {
    teamTemplate: sample.name, sampleGid: sample.group_watermark_id,
    unfiltered: t1.slice(0, 120),
    withGid: t2.slice(0, 300),
    withName: t3.slice(0, 200),
  };
});
console.log(JSON.stringify(out, null, 2));
await ctx.close();
