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
  const getJson = async (u) => JSON.parse(await (await fetch('https://webapi.5181688.com' + u, { credentials: 'include' })).text());
  const wms = (await getJson('/v4/workgroup/watermarks?group_id=' + groupID)).data.payload;
  const sample = wms.find((w) => w.group_watermark_id);

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

  const gid = sample.group_watermark_id;
  const base = sample.watermark_base_id;
  const tries = {
    wholeObject: [sample],
    watermarkBaseID: [{ watermarkBaseID: base }],
    snakeBase: [{ watermark_base_id: base }],
    groupWatermarkID: [{ groupWatermarkID: gid }],
    snakeGroup: [{ group_watermark_id: gid }],
    bothCamel: [{ watermarkBaseID: base, groupWatermarkID: gid }],
    baseIdNameCamel: [{ baseID: base, groupID: gid }],
  };
  const res = {};
  for (const [k, v] of Object.entries(tries)) {
    const r = await post(mk(v));
    res[k] = r.error ? { error: String(r.error).slice(0, 90) } : { status: r.status, total: r.payload && r.payload.total };
  }
  return { gid, base, name: sample.name, res };
});
console.log(JSON.stringify(out, null, 2));
await ctx.close();
