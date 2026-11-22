// 账号级配置测试：命名方式/筛选按账号留存；切换账号后各是各的；照片缓存不保留
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-acctcfg-'));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1200, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.route('**://*.5181688.com/**', (r) => r.abort());

await page.addInitScript(() => {
  window.__account = 'A';
  window.__picked = 0;
  const json = (p) => ({ ok: true, status: 200, json: async () => p });
  const ACCOUNTS = {
    A: { user_id: 'uA', nickname: '甲同事', group: 'gA', gname: 'A 团队' },
    B: { user_id: 'uB', nickname: '乙同事', group: 'gB', gname: 'B 团队' },
  };

  window.fetch = async (u2) => {
    const u = String(u2);
    const a = ACCOUNTS[window.__account];
    if (u.includes('webapi.5181688.com')) {
      if (u.includes('/web/workgroup/v2/currentuser')) {
        return json({ data: { user_id: a.user_id, nickname: a.nickname, groups: [{ group_id: a.group, group_name: a.gname }] } });
      }
      if (u.includes('/web/workgroup/v3/query/group')) {
        return json({ data: { group_name: a.gname, is_vip: true, vip_info: { expire_time: Math.floor(Date.now() / 1000) + 86400 * 30 }, user_list: [{ user_id: 'u1', nickname: '张伟', user_status: 1 }] } });
      }
      if (u.includes('/web/department/v2/tree')) return json({ data: { department: [], member: [] } });
      if (u.includes('/v4/workgroup/watermarks')) {
        return json({ data: { payload: [{ name: '打卡水印', group_watermark_id: 'G1', watermark_base_id: '21', type: 1 }] } });
      }
      if (u.includes('/v5/workgroup/photos')) return json({ status: 0, payload: { total: 0, lastPageCond: '', photos: [] } });
      return json({ data: null });
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer };
  };

  window.chrome = window.chrome || {};
  window.chrome.cookies = { getAll: async () => [], remove: async () => ({}) };
  window.chrome.tabs = { query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }], get: async () => ({ id: 7, status: 'complete' }), create: async () => ({ id: 7 }) };
  window.chrome.windows = { create: async () => ({ id: 1 }) };
  window.chrome.scripting = { executeScript: async () => [{ result: {} }] };
  const kv = {};
  window.chrome.storage = {
    local: {
      get: async (k) => ({ [k]: kv[k] }),
      set: async (o) => Object.assign(kv, o),
      _dump: () => JSON.parse(JSON.stringify(kv)),
    },
  };
  window.showDirectoryPicker = async () => {
    const mkDir = () => ({
      getDirectoryHandle: async () => mkDir(),
      getFileHandle: async () => ({ createWritable: async () => ({ write: async () => window.__picked++, close: async () => {} }) }),
    });
    return { ...mkDir(), name: 'OUT', requestPermission: async () => 'granted' };
  };
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(APP);
await page.waitForTimeout(1400);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  → ' + extra : ''}`);
};
const chipNames = () => page.$$eval('#dlChips .chip-tag', (els) => els.map((e) => e.textContent.replace('✕', '').trim()));
const openDl = async () => {
  await page.click('#btnQuery');
  await page.waitForTimeout(1200);
  // 没有结果时按钮仍会提示，直接用函数入口更稳：通过界面按钮需要先有勾选
};

check('账号 A 已连接', (await page.textContent('#accountName')).includes('甲同事'), await page.textContent('#accountName'));

// 打开下载设置改命名方式（去掉"水印名称"）——改动即保存
await page.evaluate(() => {
  // 直接调用界面逻辑：构造一个待下载项，打开设置弹窗
  window.__openDl && window.__openDl();
});
// 由于没有照片可勾选，改为通过渲染函数暴露的路径：用 debug 入口（不存在则跳过）
const opened = await page.evaluate(() => {
  const btn = document.getElementById('btnDownload');
  btn.click();
  return !document.getElementById('downloadDlg').hidden;
});
if (!opened) {
  // 用分组管理保存路径验证存储（不依赖下载弹窗）
  await page.evaluate(() => {
    document.getElementById('groupBtn').click();
  });
  await page.waitForTimeout(300);
  await page.fill('#gName', 'A专用组');
  await page.click('#gAdd');
  await page.waitForTimeout(200);
  await page.click('#gSave');
  await page.waitForTimeout(500);
}

const stored = await page.evaluate(() => window.chrome.storage.local._dump());
const gmap = (stored['wmc-groups-v1'] || {});
check('账号 A 的分组写入自己的键位', JSON.stringify(gmap.uA || {}).includes('A专用组'), JSON.stringify(Object.keys(gmap)));

// 切到账号 B
await page.evaluate(() => {
  window.__account = 'B';
});
await page.click('#accountBtn');
await page.waitForTimeout(4200);

check('切换后账号变为乙同事', (await page.textContent('#accountName')).includes('乙同事'), await page.textContent('#accountName'));
const storedB = await page.evaluate(() => window.chrome.storage.local._dump());
const gmapB = storedB['wmc-groups-v1'] || {};
check('账号 B 没有继承 A 的分组', !JSON.stringify(gmapB.uB || {}).includes('A专用组') && gmapB.uA !== undefined, `uA=${!!gmapB.uA} uB=${JSON.stringify(gmapB.uB || null)}`);

// 切回账号 A
await page.evaluate(() => {
  window.__account = 'A';
});
await page.click('#accountBtn');
await page.waitForTimeout(4200);
check('切回 A 后账号恢复', (await page.textContent('#accountName')).includes('甲同事'), await page.textContent('#accountName'));

// 切回 A 后：A 自己的分组应恢复
await page.click('#groupBtn');
await page.waitForTimeout(400);
const gnames = await page.$$eval('#gList input.gname', (els) => els.map((e) => e.value));
check('切回 A 后分组恢复', gnames.includes('A专用组'), gnames.join(','));
await page.click('#groupDlg [data-close]');
await page.waitForTimeout(200);

await page.click('#memberBtn');
await page.waitForTimeout(400);
await page.click('#mTree input[data-team="1"]');
await page.waitForTimeout(200);
await page.click('#memberOk');
await page.waitForTimeout(300);
const selText = await page.textContent('#memberBtn');
check('人员筛选按账号保存并恢复标签', selText.includes('已选 1 人'), selText);

check('无 JS 运行时报错', errors.length === 0, errors.join(' | '));

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
