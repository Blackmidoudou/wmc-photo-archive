import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-fresh-')); // 全新 = 未登录

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-frame2-'));
fs.writeFileSync(
  path.join(tmp, 'index.html'),
  '<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px sans-serif"><h3>扩展页里嵌登录（模拟）</h3><iframe id="f" src="https://www.5181688.com/photo/all" style="width:1200px;height:760px;border:0"></iframe></body>',
);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(tmp, 'index.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

const frames = page.frames().map((f) => f.url());
const siteFrame = page.frames().find((f) => f.url().includes('5181688'));
let detail = { frames };
if (siteFrame) {
  detail.text = await siteFrame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 220)).catch((e) => 'ERR ' + e.message);
  detail.hasPhoneInput = await siteFrame.evaluate(() => !!document.querySelector('input[placeholder*="手机"], input[type="tel"]')).catch(() => null);
  detail.hasWxLogin = await siteFrame.evaluate(() => !!document.querySelector('script[src*="wxLogin"], [class*="wx"], iframe[src*="weixin"]')).catch(() => null);
}
// 微信 SDK 的二维码 iframe 是否被拒
detail.weixinFrames = frames.filter((u) => /weixin|open\.weixin/.test(u));
await page.screenshot({ path: path.join(DIR, '..', 'probe', 'iframe-login.png'), fullPage: false }).catch(() => {});
console.log(JSON.stringify(detail, null, 2));
await ctx.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
