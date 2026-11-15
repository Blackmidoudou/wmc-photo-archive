import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-fresh-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-frame3-'));
fs.writeFileSync(path.join(tmp, 'index.html'),
  '<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="f" src="https://www.5181688.com/photo/all" style="width:1200px;height:800px;border:0"></iframe></body>');
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(tmp, 'index.html'))); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

const frame = page.frames().find((f) => f.url().includes('5181688'));
// 点「扫码登录」标签
await frame.click('text=扫码登录').catch((e) => console.log('点击失败:', e.message));
await page.waitForTimeout(5000);

const info = {
  frames: page.frames().map((f) => f.url()),
  hasQrImg: await frame.evaluate(() => !!document.querySelector('img[src*="qr"], canvas, [class*="qrcode"], [class*="qr"]')).catch(() => null),
  text: await frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)).catch(() => ''),
};
await page.screenshot({ path: path.join(DIR, '..', 'probe', 'iframe-qr.png') }).catch(() => {});
console.log(JSON.stringify(info, null, 2));
await ctx.close(); server.close();
fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(PROFILE, { recursive: true, force: true });
