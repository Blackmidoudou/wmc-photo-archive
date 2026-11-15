// 生成界面截图（桩数据，仅用于预览）
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-shot-'));
const OUTDIR = path.join(DIR, '..', 'docs');

const PEOPLE = [
  ['李娜', '车间'], ['罗勇', '前台'], ['刘洋', '车间'], ['陈静', '前台'],
  ['杨帆', '技术'], ['赵敏', '车间'], ['黄磊', '前台'], ['王芳', '技术'],
  ['吴迪', '前台'], ['徐亮', '车间'], ['张伟', '技术'], ['周涛', '前台'],
];
const DEPTS = ['技术', '车间', '前台', '国悦改装厂'];
const TOTAL = 236;

const swatch = (i) => {
  const hues = [205, 25, 145, 265, 340, 45, 175];
  const h = hues[i % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="hsl(${h} 30% 84%)"/><circle cx="120" cy="92" r="34" fill="hsl(${h} 38% 66%)"/><rect x="18" y="132" width="120" height="8" rx="4" fill="hsl(${h} 25% 72%)"/><rect x="18" y="148" width="80" height="8" rx="4" fill="hsl(${h} 25% 78%)"/></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  deviceScaleFactor: 2,
  viewport: { width: 1300, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.addInitScript(
  ({ PEOPLE, DEPTS, TOTAL, swatchSrc }) => {
    const swatch = eval('(' + swatchSrc + ')');
    const group = {
      group_name: '示例汽车销售服务有限公司',
      vip_info: { expire_time: Math.floor(Date.now() / 1000) + 5 * 86400 },
      user_list: PEOPLE.map(([n, d], i) => ({ user_id: `u${i}`, nickname: n, user_status: 1 })),
    };
    const WM = [
      { name: '示例-索赔照片', group_watermark_id: 'G_A', watermark_base_id: '21', type: 1 },
      { name: '考勤打卡', group_watermark_id: 'G_B', watermark_base_id: '21', type: 1 },
    ];
    const ITEMS = Array.from({ length: TOTAL }, (_, i) => ({
      seq: 777700000 + i,
      userNickname: PEOPLE[i % PEOPLE.length][0],
      userID: `u${i % PEOPLE.length}`,
      time: new Date('2026-11-15T08:30:00+08:00').getTime() + i * 137000,
      mediaType: i % 23 === 0 ? 1 : 0,
      largeURL: swatch(i),
      videoURL: '',
      smallURL: swatch(i),
      temporaryPhotoThaw: { isRestricted: false },
      isLimitViewByPhotoCount: false,
    }));

    const impl = {
      ipContext: () => ({ loggedIn: true, groupID: 'g', group }),
      ipDept: (a) => {
        if (String(a.deptID) === '0') return { department: DEPTS.map((n, i) => ({ id: String(3500 + i), name: n, num: 3 })), member: [] };
        const idx = DEPTS.findIndex((_, i) => String(a.deptID) === String(3500 + i));
        const name = DEPTS[idx];
        return { department: [], member: PEOPLE.map(([n, d], i) => ({ user_id: `u${i}`, _d: d })).filter((m) => m._d === name).map((m) => ({ user_id: m.user_id })) };
      },
      ipWatermarks: () => WM,
      ipList: (a) => {
        let list = ITEMS;
        if (a.userIDs && a.userIDs.length) list = list.filter((x) => a.userIDs.includes(x.userID));
        const wm = (a.watermarks || [])[0];
        if (wm) list = wm.groupWatermarkID === 'G_A' ? list.filter((_, i) => i % 5 !== 0) : list.filter((_, i) => i % 5 === 0);
        const idx = a.cursor ? Number(a.cursor) : 0;
        return {
          total: list.length,
          lastPageCond: idx + 100 < list.length ? String(idx + 100) : '',
          photos: list.slice(idx, idx + 100),
        };
      },
    };

    window.chrome = window.chrome || {};
    window.chrome.tabs = {
      query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }],
      get: async () => ({ id: 7, status: 'complete' }),
      create: async () => ({ id: 7 }),
    };
    const seeded = { 'wmc-groups-v1': { g: { depts: [{ id: 'm:1', name: '索赔组' }, { id: 'm:2', name: '保养组' }], assign: { u0: 'm:1', u2: 'm:2', u4: 'm:1' } } } };
    window.chrome.storage = {
      local: {
        get: async (k) => ({ [k]: seeded[k] }),
        set: async (o) => Object.assign(seeded, o),
      },
    };
    window.chrome.scripting = {
      executeScript: async ({ func, args }) => [{ result: impl[func.name]((args && args[0]) || {}) }],
    };
    window.showDirectoryPicker = async () => ({ name: '团队照片' });
    window.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer });
  },
  { PEOPLE, DEPTS, TOTAL, swatchSrc: swatch.toString() },
);

await page.goto(APP);
await page.waitForTimeout(1000);
await page.click('#btnQuery');
await page.waitForTimeout(2200);
await page.check('#chkAll');
await page.waitForTimeout(300);

fs.mkdirSync(OUTDIR, { recursive: true });
await page.screenshot({ path: path.join(OUTDIR, 'ui-main.png'), fullPage: false });

// 日期弹窗（对照后台截图）
await page.click('#dateBtn');
await page.waitForTimeout(400);
await page.click('#quickCol [data-q="yesterday"]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUTDIR, 'ui-date.png'), fullPage: false });
await page.click('#dateDlg [data-close]');
await page.waitForTimeout(200);

await page.click('#memberBtn');
await page.waitForTimeout(500);
await page.click('#mTree input[data-dept="api:3501"]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUTDIR, 'ui-members.png'), fullPage: false });
await page.click('#memberDlg [data-close]');
await page.waitForTimeout(200);

await page.click('#groupBtn');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUTDIR, 'ui-groups.png'), fullPage: false });
await page.click('#groupDlg [data-close]');
await page.waitForTimeout(200);

await page.click('#grid .cell:nth-child(2) .thumb-wrap');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUTDIR, 'ui-viewer.png'), fullPage: false });

await page.click('#vClose');
await page.waitForTimeout(300);
await page.click('#btnDownload');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUTDIR, 'ui-download.png'), fullPage: false });

console.log('screenshots written to', OUTDIR);
await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
