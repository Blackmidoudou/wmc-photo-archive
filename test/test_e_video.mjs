// 视频处理测试：视频用 videoURL 播放/下载；平台没给 videoURL 时用首帧快照并明确告知
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-video-'));

const T = 1794738886000;

const ITEMS = [
  { seq: 201, userNickname: '张伟', userID: 'u1', time: T, mediaType: 0, largeURL: 'https://cdn/p.jpg', videoURL: '', smallURL: 'https://cdn/p.jpg?x-oss-process=image/resize,w_300', temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false },
  { seq: 202, userNickname: '张伟', userID: 'u1', time: T + 60000, mediaType: 1, largeURL: 'https://cdn/v1.jpg', videoURL: 'https://cdn/v1.mp4', smallURL: 'https://cdn/v1.jpg?x-oss-process=x', temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false },
  // 视频但平台没给 videoURL：只能用首帧快照告知
  { seq: 203, userNickname: '王芳', userID: 'u2', time: T + 120000, mediaType: 1, largeURL: '', videoURL: '', smallURL: 'https://cdn/v2.jpg?x-oss-process=image/resize,w_300', temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false },
];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1200, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.addInitScript(
  ({ ITEMS }) => {
    window.__written = [];
    const json = (p) => ({ ok: true, status: 200, json: async () => p });
    window.fetch = async (u2, opts) => {
      const u = String(u2);
      if (u.includes('webapi.5181688.com')) {
        if (u.includes('/web/workgroup/v2/currentuser')) {
          return json({ data: { user_id: 'me', groups: [{ group_id: 'g', group_name: '测试团队' }], nickname: '我' } });
        }
        if (u.includes('/web/workgroup/v3/query/group')) {
          return json({ data: { group_name: '测试团队', user_list: [{ user_id: 'u1', nickname: '张伟', user_status: 1 }, { user_id: 'u2', nickname: '王芳', user_status: 1 }] } });
        }
        if (u.includes('/web/department/v2/tree')) return json({ data: { department: [], member: [] } });
        if (u.includes('/v4/workgroup/watermarks')) return json({ data: { payload: [] } });
        if (u.includes('/notvip/count')) return json({ status: 0, isVip: 0, photoCount: 0 });
        if (u.includes('/v5/workgroup/photos')) return json({ status: 0, payload: { total: ITEMS.length, lastPageCond: '', photos: ITEMS } });
        return json({ data: null });
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer };
    };
    window.chrome = window.chrome || {};
    window.chrome.tabs = { query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }], get: async () => ({ id: 7, status: 'complete' }), create: async () => ({ id: 7 }) };
    window.chrome.windows = { create: async () => ({ id: 1 }) };
    window.chrome.scripting = { executeScript: async () => [{ result: {} }] };
    const kv = {};
    window.chrome.storage = { local: { get: async (k) => ({ [k]: kv[k] }), set: async (o) => Object.assign(kv, o) } };
    const mkDir = () => ({
      getDirectoryHandle: async () => mkDir(),
      getFileHandle: async () => ({
        createWritable: async () => ({ write: async () => window.__written.push(1), close: async () => {} }),
      }),
    });
    window.showDirectoryPicker = async () => ({ ...mkDir(), name: 'OUT', requestPermission: async () => 'granted' });
  },
  { ITEMS },
);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(APP);
await page.waitForTimeout(1500);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  → ' + extra : ''}`);
};

check('自动查询包含视频（3 个格子）', (await page.locator('#grid .cell').count()) === 3, String(await page.locator('#grid .cell').count()));
check('视频有「视频」角标', (await page.locator('#grid .badge').count()) === 2, String(await page.locator('#grid .badge').count()));

// 正常视频：能播放
await page.click('#grid .thumb-wrap[data-open="202"]');
await page.waitForTimeout(400);
check('有视频地址的视频可播放', (await page.locator('#vStage video').count()) === 1);
check('播放源是 mp4', ((await page.getAttribute('#vStage video', 'src')) || '').endsWith('.mp4'), await page.getAttribute('#vStage video', 'src'));
await page.click('#vClose');
await page.waitForTimeout(200);

// 无 videoURL 的视频：显示首帧 + 说明，而不是黑屏/乱播
await page.click('#grid .thumb-wrap[data-open="203"]');
await page.waitForTimeout(400);
check('无视频地址时显示说明', (await page.locator('#vStage .v-note').count()) === 1);
check('无视频地址时回落到首帧快照', (await page.locator('#vStage img').count()) === 1);
check('此时不渲染 video 元素', (await page.locator('#vStage video').count()) === 0);
await page.click('#vClose');
await page.waitForTimeout(200);

// 下载：2 个成功，1 个无地址被跳过并报告
await page.check('#chkAll');
await page.waitForTimeout(200);
await page.click('#btnDownload');
await page.waitForTimeout(400);
await page.click('#dlGo');
await page.waitForTimeout(1800);
const written = await page.evaluate(() => window.__written.length);
const log = await page.textContent('#log');
check('下载成功 2 个（图片 + 视频）', written === 2, String(written));
check('无地址的视频被计入并报告', /无可用地址，跳过/.test(log) && /无可用地址 1 张/.test(log), log.split('\n').slice(-3).join(' | '));

check('无 JS 运行时报错', errors.length === 0, errors.join(' | '));

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
