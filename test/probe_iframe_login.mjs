import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const PROFILE = path.join(DIR, '..', '.browser-profile');

// 起一个本地页面，用 iframe 嵌入 5181688（模拟"在扩展页里嵌网站"）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-frame-'));
fs.writeFileSync(
  path.join(tmp, 'index.html'),
  '<!doctype html><meta charset="utf-8"><body style="margin:0"><h3 style="font:14px sans-serif">third-party iframe test</h3><iframe src="https://www.5181688.com/photo/all" style="width:1000px;height:700px;border:0"></iframe></body>',
);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(tmp, 'index.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true });

// ① 先确认同一浏览器里你已登录（顶层打开站点）
const top = ctx.pages()[0] ?? (await ctx.newPage());
await top.goto('https://www.5181688.com/photo/all', { waitUntil: 'domcontentloaded' });
await top.waitForTimeout(4000);
const topLogged = !/login|passport/i.test(top.url());

// ② cookie 属性（解释机制用）
const cookies = await ctx.cookies(['https://www.5181688.com', 'https://webapi.5181688.com']);
const cookieInfo = cookies.map((c) => ({
  name: c.name.slice(0, 28), domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly,
  secure: c.secure, session: c.expires === -1, expiresIn: c.expires === -1 ? null : Math.round(c.expires - Date.now() / 1000),
}));

// ③ 第三方 iframe 里还认不认登录
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const frame = page.frames().find((f) => f.url().includes('5181688'));
let frameInfo = { found: false };
if (frame) {
  const txt = await frame.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
  const gid = await frame.evaluate(() => localStorage.getItem('group_id')).catch(() => null);
  frameInfo = { found: true, url: frame.url(), hasGroupID: !!gid, text: txt.replace(/\s+/g, ' ').slice(0, 80) };
}

console.log(JSON.stringify({ topLogged, topUrl: top.url(), cookies: cookieInfo, frame: frameInfo }, null, 2));
await ctx.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
