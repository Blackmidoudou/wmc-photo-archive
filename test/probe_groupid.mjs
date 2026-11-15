import { launch, PHOTO_PAGE } from '../src/browser.mjs';
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const out = await page.evaluate(async () => {
  const H = { 'Content-Type': 'application/json' };
  const post = async (u, b) => {
    try {
      const r = await fetch('https://webapi.5181688.com' + u, { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(b || {}) });
      return JSON.parse(await r.text());
    } catch (e) { return { __err: e.message }; }
  };
  const lsGid = localStorage.getItem('group_id');
  const me = await post('/web/workgroup/v2/currentuser');
  const space = await post('/web/user/space/info');
  const out = { lsGid, me: me.data ? Object.keys(me.data) : me, space: space.data ? Object.keys(space.data) : space };
  // 在 currentuser / space 里找像 groupID 的 uuid
  const flat = JSON.stringify({ me, space });
  out.uuids = [...new Set((flat.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []))];
  out.meSample = me.data ? JSON.parse(JSON.stringify(me.data)).groupList || me.data.group_list || null : null;
  out.meFull = me.data ? JSON.stringify(me.data).slice(0, 700) : '';
  return out;
});
console.log(JSON.stringify(out, null, 2));
await ctx.close();
