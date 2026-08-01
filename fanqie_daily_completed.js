/**
 * 番茄小说 · 每日新增完结小说抓取工具（核心模块，CLI / UI 共用）
 *
 * 【可行方案】（2026-07-31 实测验证）
 * 1. 书库 API（同源，页面内 fetch 由 bdms SDK 自动附加 a_bogus 签名）：
 *      GET fanqienovel.com/api/author/library/book_list/v0/
 *          ?page_count=18&page_index=N&gender=-1&category_id=-1
 *          &creation_status=0&word_count=-1&book_type=-1&sort=1
 *    - creation_status=0 → 只要已完结的书
 *    - sort=1            → 按最后更新时间倒序（实测验证，近似单调递减）
 *    - page_count 上限实测 100，但 page_index>0 时分页不稳定，固定用 18（官网原生值）
 *    - 注意：book_name / word_count / read_count 是自定义字体加密的乱码，
 *      但 book_id、author、last_chapter_time、thumb_url 是明文
 * 2. 书籍信息 API（同源，轻量 JSON，实测明文齐全）：
 *      GET fanqienovel.com/api/book/info?bookId={id}
 *    返回明文 bookName / authorName / creationStatus / wordNumber / readCount /
 *    lastChapterTitle / lastPublishTime / categoryV2 / abstract，
 *    用于补全书名并二次校验 creationStatus === '0'。
 *    （早期版本曾用详情页 page.goto 提取 SSR 数据，约 270 次页面加载后
 *      即触发风控；改用此 API 后无页面加载，压力小一个量级）
 *
 * 【口径说明】番茄不公开"标记完结的时间"，本工具抓取的是：
 *    「已完结 且 最后章节更新时间在当天」的小说。
 *    完结后当天又更新番外/修订的书也会命中（无法区分）；
 *    反之，完结于 D 日但 D 日后又有番外更新的书，回填 D 日时会漏。
 *    => 建议每天定时运行（如每晚 23:55），口径最准。
 *
 * 命令行用法:
 *   npm install puppeteer
 *   node fanqie_daily_completed.js                    # 今天（北京时间）
 *   node fanqie_daily_completed.js --date 2026-07-30  # 指定日期
 *   node fanqie_daily_completed.js --output ./data     # 指定输出目录
 *   node fanqie_daily_completed.js --delay 700         # 列表请求间隔(ms)
 *
 * 模块用法（供 UI 服务调用）:
 *   const { runCrawl } = require('./fanqie_daily_completed');
 *   const result = await runCrawl({ date: '2026-07-31', onProgress: e => {...} });
 *
 * 输出: output/fanqie_completed_YYYY-MM-DD.json
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ============================================================
// 命令行参数
// ============================================================

function parseArgs() {
  const args = { date: null, output: './output', delay: 600, detailDelay: 350, maxPages: 200 };
  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '--date':        args.date = process.argv[++i]; break;
      case '--output':      args.output = process.argv[++i]; break;
      case '--delay':       args.delay = parseInt(process.argv[++i]); break;
      case '--detail-delay': args.detailDelay = parseInt(process.argv[++i]); break;
      case '--max-pages':   args.maxPages = parseInt(process.argv[++i]); break;
    }
  }
  return args;
}

// ============================================================
// 日期工具（固定按北京时间 UTC+8）
// ============================================================

function getDayRange(dateStr) {
  let date = dateStr;
  if (!date) {
    // 用 UTC+8 偏移求"北京今天"，不受系统时区影响
    date = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日期格式错误: ${date}，应为 YYYY-MM-DD`);
  }
  const startTs = Date.parse(date + 'T00:00:00+08:00') / 1000;
  const endTs = startTs + 86400;
  return { startTs, endTs, dateStr: date };
}

function tsToStr(ts) {
  return new Date(Number(ts) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 在读人数格式化：12345 → 1.2万
function formatReadCount(rc) {
  const n = parseInt(rc) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

// ============================================================
// Chrome 路径探测
// ============================================================

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // undefined → 用 puppeteer 自带浏览器
}

// ============================================================
// Step 1: 书库 API 翻页收集候选（在 /library 页面内 fetch，bdms 自动签名）
// ============================================================

const PAGE_COUNT = 18; // 官网原生值，实测分页最稳定

async function fetchLibraryPage(page, pageIndex) {
  return page.evaluate(async (pi, pc) => {
    try {
      const u = `/api/author/library/book_list/v0/?page_count=${pc}&page_index=${pi}` +
                `&gender=-1&category_id=-1&creation_status=0&word_count=-1&book_type=-1&sort=1`;
      const r = await fetch(u);
      const j = await r.json();
      if (j.code !== 0) return { ok: false, code: j.code, message: j.message };
      const list = (j.data?.book_list || []).map(b => ({
        book_id: String(b.book_id || ''),
        author: b.author || '',                       // 明文
        last_chapter_time: Number(b.last_chapter_time) || 0,
        thumb_uri: b.thumb_uri || '',                 // 封面路径（拼无签名稳定链接用）
        thumb_url: b.thumb_url || '',                 // 封面签名临时链接（数小时后过期，仅兜底）
      })).filter(b => b.book_id && b.last_chapter_time);
      return { ok: true, books: list, has_more: !!j.data?.has_more };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }, pageIndex, PAGE_COUNT);
}

async function collectCandidates(page, startTs, endTs, args, emit) {
  const candidates = new Map();
  let apiCalls = 0, scanned = 0;

  for (let pi = 0; pi < args.maxPages; pi++) {
    const res = await fetchLibraryPage(page, pi);
    apiCalls++;

    if (!res.ok) {
      emit({ type: 'log', message: `[警告] 第 ${pi} 页请求失败: ${res.message || res.error || 'code=' + res.code}` });
      if (pi === 0) throw new Error('书库 API 首页即失败，可能被风控，请稍后重试');
      break; // 中途失败：用已收集的数据继续，避免全盘作废
    }
    if (res.books.length === 0) break;

    scanned += res.books.length;
    let pageMin = Infinity, pageMax = 0, hits = 0;

    for (const b of res.books) {
      pageMin = Math.min(pageMin, b.last_chapter_time);
      pageMax = Math.max(pageMax, b.last_chapter_time);
      if (b.last_chapter_time >= startTs && b.last_chapter_time < endTs) {
        if (!candidates.has(b.book_id)) {
          candidates.set(b.book_id, b);
          hits++;
        }
      }
    }

    emit({
      type: 'collect',
      page: pi + 1, pageBooks: res.books.length, hits, candidates: candidates.size,
      scanned, pageMin: tsToStr(pageMin), pageMax: tsToStr(pageMax),
    });

    // 整页最旧的一本仍 >= 目标日开始 → 继续翻；否则可以停
    if (pageMin < startTs) break;
    if (!res.has_more) break;
    await sleep(args.delay);
  }

  return { candidates: [...candidates.values()], apiCalls, scanned };
}

// 封面：无签名稳定链接（实测 200，长期有效），签名链接仅兜底
function stableCover(cand) {
  if (cand.thumb_uri) return `https://p3-novel.byteimg.com/${cand.thumb_uri}~tplv-resize:200:260.image`;
  return cand.thumb_url || '';
}

// ============================================================
// Step 2: 书籍信息 API 补全明文 + 二次校验（同源 fetch，自动签名）
// ============================================================

async function fetchBookInfo(page, bookId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await page.evaluate(async (bid) => {
      try {
        const r = await fetch(`/api/book/info?bookId=${bid}`);
        if (r.status !== 200) return { ok: false, status: r.status };
        const j = await r.json();
        if (j.code !== 0 || !j.data?.bookName) return { ok: false, code: j.code, message: j.message };
        const d = j.data;
        let categories = [];
        try { categories = (JSON.parse(d.categoryV2 || '[]')).map(c => c.Name).filter(Boolean); } catch {}
        return {
          ok: true,
          title: d.bookName,
          author: d.authorName || d.author || '',
          creation_status: String(d.creationStatus),   // '0'=已完结
          word_count: Number(d.wordNumber) || 0,
          read_count: String(d.readCount ?? '0'),
          last_chapter_title: d.lastChapterTitle || '',
          last_publish_time: Number(d.lastPublishTime) || 0,
          categories,
          description: (d.abstract || '').trim(),
        };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }, bookId);

    if (res.ok) return res;
    // 限流/抖动 → 指数退避
    await sleep(1000 * (attempt + 1));
  }
  return null;
}

// ============================================================
// 主流程（模块入口）
// ============================================================

/**
 * @param {object}   opts
 * @param {string}   [opts.date]        YYYY-MM-DD，缺省为北京今天
 * @param {string}   [opts.output]      输出目录，默认 ./output
 * @param {number}   [opts.delay]       列表翻页间隔 ms，默认 600
 * @param {number}   [opts.detailDelay] 详情调用间隔 ms，默认 350
 * @param {number}   [opts.maxPages]    最多翻页数，默认 200
 * @param {function} [opts.onProgress]  进度回调，事件见 emit 调用处
 * @returns {Promise<{output: object, outPath: string}>}
 */
async function runCrawl(opts = {}) {
  const args = {
    date: opts.date || null,
    output: opts.output || process.env.OUTPUT_DIR || './output',
    delay: opts.delay ?? 600,
    detailDelay: opts.detailDelay ?? 350,
    maxPages: opts.maxPages ?? 200,
  };
  const emit = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  const { startTs, endTs, dateStr } = getDayRange(args.date);
  emit({ type: 'meta', date: dateStr, rangeStart: tsToStr(startTs), rangeEnd: tsToStr(endTs) });

  emit({ type: 'stage', index: 1, name: '启动浏览器' });
  const chromePath = findChrome();
  emit({ type: 'log', message: `Chrome: ${chromePath || '(puppeteer 内置)'}` });
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const listPage = await browser.newPage();
    await listPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    emit({ type: 'stage', index: 2, name: '打开书库页，等待签名 SDK 就绪' });
    await listPage.goto('https://fanqienovel.com/library', { waitUntil: 'networkidle2', timeout: 30000 });
    await listPage.waitForFunction(() => !!window.bdms, { timeout: 15000 });
    await sleep(1500);

    emit({ type: 'stage', index: 3, name: '翻页收集候选（完结 + 按更新时间倒序）' });
    const { candidates, apiCalls, scanned } = await collectCandidates(listPage, startTs, endTs, args, emit);
    emit({ type: 'log', message: `共扫描 ${scanned} 本完结书(${apiCalls} 次请求)，当日命中 ${candidates.length} 本` });

    if (candidates.length === 0) {
      const r = writeOutput(args.output, dateStr, { apiCalls, scanned, detailFailures: 0 }, []);
      emit({ type: 'done', outPath: r.outPath, total: 0, books: [], stats: r.output.stats, date: dateStr });
      return r;
    }

    emit({ type: 'stage', index: 4, name: `调用书籍信息 API 补全明文 (${candidates.length} 本)`, total: candidates.length });
    let detailFails = 0;
    const books = [];

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const d = await fetchBookInfo(listPage, cand.book_id);

      if (!d) {
        detailFails++;
        books.push({
          book_id: cand.book_id,
          title: '', author: cand.author,
          categories: [], word_count: 0, read_count: '0',
          last_chapter_title: '', description: '',
          completion_time: tsToStr(cand.last_chapter_time),
          completion_timestamp: cand.last_chapter_time,
          cover_url: stableCover(cand),
          url: `https://fanqienovel.com/page/${cand.book_id}`,
          _detail_failed: true,
        });
      } else {
        books.push({
          book_id: cand.book_id,
          title: d.title,
          author: d.author || cand.author,
          categories: d.categories,
          word_count: d.word_count,
          read_count: d.read_count,
          last_chapter_title: d.last_chapter_title,
          description: d.description,
          completion_time: tsToStr(cand.last_chapter_time),
          completion_timestamp: cand.last_chapter_time,
          cover_url: stableCover(cand),
          url: `https://fanqienovel.com/page/${cand.book_id}`,
          _verified_completed: d.creation_status === '0',
        });
      }

      emit({ type: 'detail', done: i + 1, total: candidates.length, fails: detailFails });
      await sleep(args.detailDelay);
    }

    // 二次校验：确认 creationStatus===0（详情失败的保留但标记）
    const confirmed = books.filter(b => b._verified_completed || b._detail_failed);
    const rejected = books.length - confirmed.length;
    if (rejected > 0) emit({ type: 'log', message: `二次校验剔除 ${rejected} 本（详情显示非完结）` });

    for (const b of confirmed) {
      delete b._verified_completed;
      delete b._detail_failed;
    }
    confirmed.sort((a, b) => b.completion_timestamp - a.completion_timestamp);

    const r = writeOutput(args.output, dateStr, { apiCalls, scanned, detailFailures: detailFails }, confirmed);
    emit({ type: 'done', outPath: r.outPath, total: confirmed.length, books: confirmed, stats: r.output.stats, date: dateStr });
    return r;
  } finally {
    await browser.close();
  }
}

function writeOutput(dir, dateStr, stats, books) {
  const output = {
    fetch_date: dateStr,
    fetch_time: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    criteria: 'creation_status=0(已完结) 且 last_chapter_time 在当天',
    total_count: books.length,
    stats: {
      api_calls: stats.apiCalls,
      books_scanned: stats.scanned,
      detail_failures: stats.detailFailures,
    },
    books,
  };
  const outDir = path.resolve(dir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `fanqie_completed_${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  return { output, outPath };
}

// ============================================================
// CLI 入口
// ============================================================

function cliProgress(e) {
  switch (e.type) {
    case 'meta':
      console.log('='.repeat(64));
      console.log('番茄小说 · 每日新增完结小说抓取');
      console.log(`目标日期: ${e.date} (北京时间)`);
      console.log(`时间范围: ${e.rangeStart} ~ ${e.rangeEnd}`);
      console.log('口径: 已完结 且 最后章节更新时间在当天');
      console.log('='.repeat(64));
      break;
    case 'stage':
      console.log(`\n[${e.index}/4] ${e.name}...`);
      break;
    case 'log':
      console.log(`  ${e.message}`);
      break;
    case 'collect':
      process.stdout.write(
        `\r  第 ${e.page} 页 | 本页 ${e.pageBooks} 本(${e.pageMax} ~ ${e.pageMin})` +
        ` | 命中 ${e.hits} | 累计候选 ${e.candidates}   `
      );
      break;
    case 'detail':
      process.stdout.write(`\r  ${e.done}/${e.total} (失败 ${e.fails})   `);
      break;
    case 'done':
      console.log(`\n\n保存到: ${e.outPath}`);
      console.log('\n当日完结列表:');
      for (const b of e.books) {
        const wc = b.word_count ? (b.word_count / 10000).toFixed(1) + '万字' : '?';
        const rc = formatReadCount(b.read_count);
        const cat = (b.categories || [])[0] || '-';
        console.log(`  [${cat}] ${b.title} / ${b.author} (${wc} | 在读${rc}) ${b.completion_time}`);
      }
      break;
  }
}

if (require.main === module) {
  const args = parseArgs();
  runCrawl({ ...args, onProgress: cliProgress }).catch(err => {
    console.error('\n执行失败:', err.message);
    process.exit(1);
  });
}

module.exports = { runCrawl, getDayRange, tsToStr };
