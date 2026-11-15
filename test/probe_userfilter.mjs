import { launch, PHOTO_PAGE } from '../src/browser.mjs';
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const H = { 'Content-Type': 'application/json' };
  const post = async (u, b) => JSON.parse(await (await fetch('https://webapi.5181688.com' + u, { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(b) })).text());

  const base = (extra) => ({
    filter: {
      searchKeywords: [], mediaType: null, sourceType: null,
      times: [{ start: '2026-11-15 00:00:00', end: '2026-11-15 23:59:59' }],
      userIDList: [], excludeUserIDList: [], departmentIDList: ['0'],
      watermarks: [], locations: [], useSegment: true, useSynonym: false,
      useSuggestedSearch: true, suggestedSearchWords: [], locationRecommend: {},
      excludeKeywords: [], existWatermark: 0, labelIDs: [], labelMatchAll: false, untaggedOnly: false,
      ...extra,
    },
    isPreciseSearch: false, isAscSort: false, groupID, lastPageCond: '',
  });
  const T = async (extra) => (await post('/v5/workgroup/photos', base(extra))).payload.total;

  // 取一页数据，拿真实 userID
  const first = (await post('/v5/workgroup/photos', base({}))).payload.photos;
  const u = first[0];
  const me = (await post('/web/workgroup/v2/currentuser', {})).data;
  const groupUsers = (await post('/web/workgroup/v3/query/group', { group_id: groupID, only_in_group: 0 })).data.user_list;
  const matchNick = groupUsers.find((x) => x.nickname === u.userNickname);

  const res = {
    photoUserID: u.userID,
    photoNick: u.userNickname,
    groupUserID: matchNick && matchNick.user_id,
    sameId: matchNick && matchNick.user_id === u.userID,
    variants: {},
  };
  res.variants.userIDList_photo = await T({ userIDList: [u.userID] });
  res.variants.userIDList_group = matchNick ? await T({ userIDList: [matchNick.user_id] }) : null;
  res.variants.userIDs = await T({ userIDs: [u.userID] });
  res.variants.userIdList = await T({ userIdList: [u.userID] });
  res.variants.excludeUserIDList = await T({ excludeUserIDList: [u.userID] });
  res.variants.withDept0 = await T({ userIDList: [u.userID], departmentIDList: ['0'] });
  res.variants.withDeptEmpty = await T({ userIDList: [u.userID], departmentIDList: [] });
  res.currentUser = { id: (me && (me.user_id || me.userID)), nick: me && (me.nickname || me.user_nickname) };
  return res;
});
console.log(JSON.stringify(out, null, 2));
await ctx.close();
