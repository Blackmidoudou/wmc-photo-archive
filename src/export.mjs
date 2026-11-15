// 导出器：按日期区间拉取「全部照片」列表，按 人名/日期 归档下载。
//
// 做法：复用你已登录的浏览器会话，调用网页自己用的那个列表接口
// （POST https://webapi.5181688.com/v5/workgroup/photos，游标分页），
// 再把 largeURL / videoURL 下载到本地。
//
// 不修改任何过滤条件之外的东西，也不绕过"需会员"标记：
// temporaryPhotoThaw.isRestricted 为 true 的照片会被跳过并计入报告。
import fs from 'node:fs';
import path from 'node:path';
import { launch, PHOTO_PAGE, OUT_DIR } from './browser.mjs';

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {
    from: null,
    to: null,
    outDir: OUT_DIR,
    jobs: 4,
    limit: 0,
    dryRun: false,
    headed: false,
    name: null,
    pageDelay: 400,
    noWatermark: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--from') out.from = next();
    else if (a === '--to') out.to = next();
    else if (a === '--out') out.outDir = path.resolve(next());
    else if (a === '--jobs') out.jobs = Math.max(1, Math.min(8, Number(next()) || 4));
    else if (a === '--limit') out.limit = Number(next()) || 0;
    else if (a === '--name') out.name = next();
    else if (a === '--page-delay') out.pageDelay = Number(next()) || 400;
    else if (a === '--no-watermark') out.noWatermark = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
用法:
  npm run export -- --from 2026-11-01 --to 2026-11-15 [选项]

必填:
  --from YYYY-MM-DD    起始日期（含）
  --to   YYYY-MM-DD    结束日期（含）

可选:
  --out DIR            输出目录（默认 ./photos）
  --name 张三          只导出某个人
  --limit N            只处理前 N 条（试跑用）
  --jobs N             同时下载数（默认 4，最大 8）
  --page-delay MS      翻页间隔（默认 400ms）
  --no-watermark       文件名不带水印名称
  --dry-run            只统计不下载
  --headed             显示浏览器窗口（调试用）
`);
      process.exit(0);
    }
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 工具 ----------
const TZ = 'Asia/Shanghai';
const fmtDate = (ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const fmtTime = (ms) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));

function safeName(s) {
  return String(s || '未命名')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名';
}

// 文件名：姓名 日期 时间 水印名称.ext（与平台导出的命名规则一致）
const usedNames = new Set();
function buildFileName(item, wm, dirKey) {
  const person = safeName(item.userNickname);
  const date = fmtDate(item.time);
  const time = fmtTime(item.time).replace(/:/g, '_');
  const wmPart = wm ? ` ${safeName(wm)}` : '';
  const base = `${person} ${date} ${time}${wmPart}`;
  const key0 = `${dirKey}/${base}.${extOf(item)}`;
  const name = usedNames.has(key0) ? `${base} ${item.seq}.${extOf(item)}` : `${base}.${extOf(item)}`;
  usedNames.add(`${dirKey}/${name}`);
  return name;
}

function extOf(item) {
  const url = item.videoURL || item.largeURL || '';
  const fromUrl = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  const fromFile = String(item.file || '').match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
  return (fromFile || 'jpg').toLowerCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 简单的并发池 */
function createPool(size, handler) {
  const queue = [];
  let active = 0;
  const idleWaiters = [];
  const settleIfIdle = () => {
    if (active === 0 && queue.length === 0) {
      while (idleWaiters.length) idleWaiters.shift()();
    }
  };
  const pump = () => {
    while (active < size && queue.length) {
      const item = queue.shift();
      active++;
      Promise.resolve()
        .then(() => handler(item))
        .catch(() => {})
        .finally(() => {
          active--;
          pump();
          settleIfIdle();
        });
    }
    settleIfIdle();
  };
  return {
    push(item) {
      queue.push(item);
      pump();
    },
    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },
  };
}

// ---------- 下载 ----------
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

async function downloadTo(url, dest, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, Referer: 'https://www.5181688.com/' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`body too small (${buf.length}B)`);
      const tmp = `${dest}.part`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return buf.length;
    } catch (e) {
      if (attempt === tries) throw e;
      await sleep(800 * attempt);
    }
  }
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);

  if (!args.from || !args.to || !DATE_RE.test(args.from) || !DATE_RE.test(args.to)) {
    console.error('请用 --from YYYY-MM-DD --to YYYY-MM-DD 指定日期区间。加 --help 看用法。');
    process.exit(1);
  }
  if (args.from > args.to) {
    console.error('起始日期不能晚于结束日期。');
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const manifestPath = path.join(args.outDir, '_manifest.jsonl');

  // 已下载清单 → 断点续传
  const done = new Set();
  if (fs.existsSync(manifestPath)) {
    for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.seq) done.add(String(m.seq));
      } catch {}
    }
  }

  const stats = {
    pages: 0,
    seen: 0,
    downloaded: 0,
    bytes: 0,
    skippedExisting: 0,
    skippedRestricted: 0,
    failed: 0,
    byPerson: new Map(),
    byDay: new Map(),
    failures: [],
  };
  const addPerson = (name, n = 1) => stats.byPerson.set(name, (stats.byPerson.get(name) || 0) + n);
  const addDay = (day, n = 1) => stats.byDay.set(day, (stats.byDay.get(day) || 0) + n);

  const ctx = await launch({ headless: !args.headed });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // 抓到应用自己的列表请求，作为模板（含鉴权头、过滤条件）
  let template = null;
  page.on('request', (req) => {
    if (template) return;
    if (!/\/v5\/workgroup\/photos$/.test(req.url())) return;
    if (req.method() !== 'POST') return;
    try {
      template = { url: req.url(), headers: req.headers(), body: JSON.parse(req.postData() || '{}') };
    } catch {}
  });

  console.log(`\n打开照片列表页并读取接口模板…（区间 ${args.from} ~ ${args.to}）`);
  await page.goto(PHOTO_PAGE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 40 && !template; i++) await page.waitForTimeout(500);

  if (!template) {
    console.error('没抓到列表接口。请确认登录态有效（npm run login），或用 --headed 观察一下。');
    await ctx.close();
    process.exit(4);
  }

  const groupID = template.body.groupID;
  console.log('接口模板已获取，groupID:', groupID);

  // 用浏览器上下文的请求能力发请求（与页面共享 cookie，且不受 CORS 限制）
  const dropHeaders = /^(host|content-length|connection|accept-encoding|cookie|sec-.*|:.*)$/i;
  const headers = Object.fromEntries(Object.entries(template.headers).filter(([k]) => !dropHeaders.test(k)));

  const baseFilter = template.body.filter ?? {};
  const makeBody = (cursor) => ({
    ...template.body,
    groupID,
    lastPageCond: cursor || '',
    filter: {
      ...baseFilter,
      times: [{ start: `${args.from} 00:00:00`, end: `${args.to} 23:59:59` }],
      userIDList: [],
      excludeUserIDList: [],
      departmentIDList: ['0'],
      mediaType: null,
      searchKeywords: [],
    },
  });

  // ---------- 水印名称（用于「姓名 日期 时间 水印名称.ext」命名） ----------
  // 列表接口只返回 watermarkBaseID，拿不到单张照片的模板名。
  // 但 watermarks 筛选字段可用 {watermarkBaseID, groupWatermarkID} 反查，
  // 且各模板互斥、数量之和等于区间总数 —— 据此可精确到每一张。
  const wmName = new Map(); // seq -> 水印名称
  let wmGlobal = null; // 整个区间只有一种水印时，直接套用
  let wmNote = '未启用';

  const postList = async (body) => {
    const r = await ctx.request.post(template.url, { headers, data: body, timeout: 60_000 });
    const j = JSON.parse(await r.text());
    if (j.status !== 0) throw new Error(`水印反查失败 status=${j.status}`);
    return j.payload || {};
  };
  const withWm = (cursor, wmFilter) => {
    const b = makeBody(cursor);
    return { ...b, filter: { ...b.filter, watermarks: wmFilter ? [wmFilter] : [] } };
  };

  if (!args.noWatermark) {
    try {
      const defsRes = await ctx.request.get(
        `https://webapi.5181688.com/v4/workgroup/watermarks?group_id=${encodeURIComponent(groupID)}`,
        { headers, timeout: 30_000 },
      );
      const defs = JSON.parse(await defsRes.text())?.data?.payload || [];

      const cands = [];
      const seenBase = new Set();
      for (const w of defs) {
        if (w.group_watermark_id) {
          cands.push({
            name: w.name,
            filter: { watermarkBaseID: w.watermark_base_id, groupWatermarkID: w.group_watermark_id },
          });
        }
      }
      for (const w of defs) {
        if (w.group_watermark_id || w.type === 1) continue;
        if (seenBase.has(w.watermark_base_id)) continue;
        seenBase.add(w.watermark_base_id);
        cands.push({ name: w.name, filter: { watermarkBaseID: w.watermark_base_id } });
      }

      const rangeTotal = (await postList(makeBody(''))).total || 0;
      const hit = [];
      let covered = 0;
      for (const c of cands) {
        const t = (await postList(withWm('', c.filter))).total || 0;
        if (t > 0) {
          c.total = t;
          hit.push(c);
          covered += t;
        }
        if (covered >= rangeTotal) break;
        await sleep(args.pageDelay);
      }

      if (hit.length === 1) {
        wmGlobal = hit[0].name;
        wmNote = `全部为「${wmGlobal}」`;
      } else if (hit.length > 1) {
        for (const c of hit) {
          let cur = '';
          const seen = new Set();
          while (true) {
            const p = await postList(withWm(cur, c.filter));
            for (const ph of p.photos || []) wmName.set(String(ph.seq), c.name);
            const next = p.lastPageCond || '';
            if (!(p.photos || []).length || !next || next === cur || seen.has(next)) break;
            seen.add(next);
            cur = next;
            await sleep(args.pageDelay);
          }
        }
        wmNote = `${hit.length} 种水印，逐张映射 ${wmName.size}/${rangeTotal} 条`;
      } else {
        wmNote = '未匹配到水印模板（将不带水印名）';
      }
    } catch (e) {
      wmNote = `解析失败，将不带水印名（${e.message}）`;
    }
  }
  console.log(`水印名称：${wmNote}`);

  const watermarkOf = (item) => wmGlobal || wmName.get(String(item.seq)) || '';

  const pool = createPool(args.jobs, async (job) => {
    const { item, dest, wm, fileName } = job;
    try {
      const size = await downloadTo(item.videoURL || item.largeURL, dest);
      stats.downloaded++;
      stats.bytes += size;
      fs.appendFileSync(
        manifestPath,
        JSON.stringify({
          seq: String(item.seq),
          person: item.userNickname,
          userID: item.userID,
          time: item.time,
          date: fmtDate(item.time),
          mediaType: item.mediaType,
          watermark: wm || '',
          file: path.relative(args.outDir, dest),
          saveName: item.saveName,
        }) + '\n',
      );
    } catch (e) {
      stats.failed++;
      stats.failures.push({ seq: item.seq, url: item.videoURL || item.largeURL, err: String(e.message || e) });
    }
  });

  let cursor = '';
  let processed = 0;
  const seenCursors = new Set();
  while (true) {
    let payload;
    try {
      const res = await ctx.request.post(template.url, { headers, data: makeBody(cursor), timeout: 60_000 });
      const text = await res.text();
      if (!res.ok()) throw new Error(`HTTP ${res.status()}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      if (json.status !== 0) throw new Error(`status=${json.status} msg=${json.msg || ''}`);
      payload = json.payload;
    } catch (e) {
      console.error(`\n第 ${stats.pages + 1} 页请求失败：${e.message}`);
      break;
    }

    const photos = payload.photos || [];
    stats.pages++;
    stats.seen += photos.length;

    for (const item of photos) {
      processed++;
      if (args.limit && processed > args.limit) break;
      const restricted =
        (item.temporaryPhotoThaw && item.temporaryPhotoThaw.isRestricted) || item.isLimitViewByPhotoCount;
      if (restricted) {
        stats.skippedRestricted++;
        continue;
      }
      if (args.name && item.userNickname !== args.name) continue;

      const nickname = safeName(item.userNickname);
      const date = fmtDate(item.time);
      const seq = String(item.seq);
      const wm = watermarkOf(item);
      const fileName = buildFileName(item, wm, `${nickname}/${date}`);
      const dest = path.join(args.outDir, nickname, date, fileName);

      addPerson(nickname);
      addDay(date);

      if (done.has(seq) && fs.existsSync(dest)) {
        stats.skippedExisting++;
        continue;
      }
      if (args.dryRun) continue;
      pool.push({ item, dest, wm, fileName });
    }

    process.stdout.write(
      `\r第 ${stats.pages} 页 | 已处理 ${processed}/${payload.total ?? '?'} | 下载 ${stats.downloaded} | 已存在 ${stats.skippedExisting} | 受限 ${stats.skippedRestricted} | 失败 ${stats.failed}   `,
    );

    if (args.limit && processed >= args.limit) break;

    const next = payload.lastPageCond || '';
    if (!photos.length || !next || next === cursor || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
    await sleep(args.pageDelay);
  }

  await pool.drain();
  process.stdout.write('\n');
  await ctx.close().catch(() => {});

  // ---------- 报告 ----------
  console.log('\n==================== 完成 ====================');
  console.log(`日期区间：${args.from} ~ ${args.to}`);
  if (args.dryRun) console.log('（dry-run：没有真正下载）');
  console.log(`处理 ${processed} 条，下载 ${stats.downloaded} 个，${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`跳过：已存在 ${stats.skippedExisting}，需会员 ${stats.skippedRestricted}，失败 ${stats.failed}`);
  if (stats.byDay.size > 1 || args.dryRun) {
    const days = [...stats.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`\n按天（${days.length} 天）：`);
    for (const [d, n] of days) console.log(`  ${d}  ${String(n).padStart(5, ' ')} 张`);
    console.log('');
  }
  console.log(`涉及 ${stats.byPerson.size} 人：`);
  const sorted = [...stats.byPerson.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted.slice(0, 40)) console.log(`  ${name.padEnd(10, ' ')} ${n}`);
  if (sorted.length > 40) console.log(`  … 另有 ${sorted.length - 40} 人`);
  console.log(`输出目录：${args.outDir}`);

  if (stats.failures.length) {
    const failPath = path.join(args.outDir, '_failed.json');
    fs.writeFileSync(failPath, JSON.stringify(stats.failures, null, 2));
    console.log(`失败清单：${failPath}（重跑同一命令会自动补下）`);
  }
}

main().catch(async (e) => {
  console.error('\n出错：', e.stack || e.message);
  process.exit(1);
});
