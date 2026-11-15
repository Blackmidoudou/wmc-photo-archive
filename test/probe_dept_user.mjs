import { launch, PHOTO_PAGE } from '../src/browser.mjs';
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const out = await page.evaluate(async () => {
  const groupID = localStorage.getItem('group_id');
  const H = { 'Content-Type': 'application/json' };
  const post = async (u, b) => JSON.parse(await (await fetch('https://webapi.5181688.com' + u, { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(b) })).text());
  const tree = (userID) => post('/web/department/v2/tree', { groupID, userID, enableQuitUser: false, departmentIDList: [0] });

  const me = (await post('/web/workgroup/v2/currentuser', {})).data;
  const grp = (await post('/web/workgroup/v3/query/group', { group_id: groupID, only_in_group: 0 })).data;
  const firstUid = grp.user_list[0].user_id;

  const withMe = await tree(me.user_id);
  const withFirst = await tree(firstUid);
  const withEmpty = await tree('');
  const shape = (r) => ({
    status: r.status,
    depts: (r.data && r.data.department || []).map((d) => `${d.name}(${d.num})`),
    rootMembers: (r.data && r.data.member || []).length,
    err: r.msg || r.error || '',
  });
  return {
    me: { id: me.user_id, nick: me.nickname },
    firstUid,
    withMe: shape(withMe),
    withFirst: shape(withFirst),
    withEmpty: shape(withEmpty),
  };
});
console.log(JSON.stringify(out, null, 2));
await ctx.close();
