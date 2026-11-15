// 浏览器会话管理：使用本机 Chrome + 独立 profile 目录。
// 登录态保存在 .browser-profile/ 里，由你自己扫码/输密码产生，
// 脚本只是复用这个会话，不伪造、不改写任何登录信息。
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

const SRC_DIR = path.dirname(url.fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SRC_DIR, '..');
export const PROFILE_DIR = path.join(ROOT, '.browser-profile');
export const OUT_DIR = path.join(ROOT, 'photos');
export const PROBE_DIR = path.join(ROOT, 'probe');

export const SITE = 'https://www.5181688.com';
export const PHOTO_PAGE = `${SITE}/photo/all`;

/** 启动一个持久化会话的 Chrome（同一个 profile 可以复用登录态） */
export async function launch({ headless = false, slowMo = 0 } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    slowMo,
    viewport: { width: 1500, height: 950 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  ctx.setDefaultTimeout(30_000);
  return ctx;
}

/** 看起来还在登录页/被踢回登录页 */
export function looksLoggedOut(pageUrl) {
  return /passport|\/login|signin|wxlogin/i.test(pageUrl);
}

/** 从 profile 的 localStorage/cookie 里判断是否已登录（启发式，只用于提示） */
export async function loginHint(page) {
  try {
    const cookies = await page.context().cookies(SITE);
    const names = cookies.map((c) => c.name);
    const lsCount = await page.evaluate(() => {
      try {
        return Object.keys(window.localStorage).length;
      } catch {
        return 0;
      }
    });
    return { url: page.url(), cookies: names, localStorageKeys: lsCount };
  } catch {
    return { url: page.url(), cookies: [], localStorageKeys: 0 };
  }
}

/** 简单的终端等待：回车继续（给不方便自动判定的场景兜底） */
export function waitForEnter(tip) {
  return new Promise((resolve) => {
    process.stdout.write(tip);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}
