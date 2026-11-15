import { launch, PHOTO_PAGE } from '../src/browser.mjs';
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const H = { 'Content-Type': 'application/json' };
  const post = async (u, b) => JSON.parse(await (await fetch('https://webapi.5181688.com' + u, { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(b) })).text());

  const me = (await post('/web/workgroup/v2/currentuser', {})).data;
  const myId = (me && (me.user_id || me.userID || (me.user && me.user.user_id))) || '';
  const treeRaw = await post('/web/department/v2/tree', { groupID, userID: myId, enableQuitUser: false, departmentIDList: [0] });
  const root = treeRaw.data || {};
  const user = (await post('/web/workgroup/v3/query/group', { group_id: groupID, only_in_group: 0 })).data;

  const mk = (o) => ({
    filter: {
      searchKeywords: [], mediaType: null, sourceType: null,
      times: [{ start: '2026-11-15 00:00:00', end: '2026-11-15 23:59:59' }],
      userIDList: o.users || [], excludeUserIDList: [], departmentIDList: o.depts || ['0'],
      watermarks: [], locations: [], useSegment: true, useSynonym: false,
      useSuggestedSearch: true, suggestedSearchWords: [], locationRecommend: {},
      excludeKeywords: [], existWatermark: 0, labelIDs: [], labelMatchAll: false, untaggedOnly: false,
    },
    isPreciseSearch: false, isAscSort: false, groupID, lastPageCond: '',
  });

  const all = (await post('/v5/workgroup/photos', mk({}))).payload.total;
  const depts = root.department.map((d) => ({ id: d.id, name: d.name, num: d.num }));
  const byDept = [];
  for (const d of depts.slice(0, 4)) {
    const t = (await post('/v5/workgroup/photos', mk({ depts: [d.id] }))).payload.total;
    byDept.push({ id: d.id, name: d.name, num: d.num, total: t });
  }
  const sampleUser = user.user_list[0];
  const byUser = (await post('/v5/workgroup/photos', mk({ users: [sampleUser.user_id] }))).payload.total;

  return {
    myId: myId || '(空)',
    treeKeys: Object.keys(root),
    groupName: user.group_name, memberCount: user.user_list.length,
    rootMemberCount: root.member.length, rootId: root.departmentRoute[0].id,
    depts, byDept,
    sampleUser: { name: sampleUser.nickname, total: byUser },
    all,
  };
});
console.log(JSON.stringify(out, null, 2));
await ctx.close();
