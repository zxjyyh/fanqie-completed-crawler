/**
 * 番茄每日完结小说抓取 · 本地 Web UI 服务
 *
 * 用法:
 *   node ui_server.js            # 启动并自动打开浏览器 (默认端口 8787)
 *   node ui_server.js --no-open  # 不自动打开浏览器
 *   PORT=9000 node ui_server.js  # 指定端口
 *
 * 页面中选择日期 → 点击"开始抓取" → 实时查看进度 → 表格展示结果 / 下载 JSON。
 * 同时只允许一个抓取任务；历史结果(output/*.json)可随时回看。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { runCrawl } = require('./fanqie_daily_completed');

const PORT = Number(process.env.PORT) || 8787;
const OUT_DIR = path.resolve(process.env.OUTPUT_DIR || './output');
const UI_HTML = path.join(__dirname, 'ui.html');
const AUTO_OPEN = !process.argv.includes('--no-open') && !process.env.NO_OPEN;

// ------------------------------------------------------------
// 任务状态（单任务）
// ------------------------------------------------------------

let job = null; // { date, startedAt, running, events[], result, error, source }
const sseClients = new Set();

function broadcast(ev) {
  if (job) {
    job.events.push(ev);
    if (job.events.length > 900) job.events.splice(0, job.events.length - 900);
  }
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
}

async function startJob(params, source = 'manual') {
  if (job && job.running) return false;
  job = { date: params.date || null, startedAt: Date.now(), running: true, events: [], result: null, error: null, source };
  broadcast({ type: 'job-start', date: params.date || '(北京今天)', source });

  runCrawl({ ...params, onProgress: broadcast })
    .then(r => {
      job.result = { date: r.output.fetch_date, total: r.output.total_count, stats: r.output.stats, outPath: r.outPath };
    })
    .catch(e => {
      job.error = e.message;
      broadcast({ type: 'job-error', message: e.message });
    })
    .finally(() => {
      job.running = false;
      if (source === 'auto') {
        schedule.lastRun = {
          date: job.result?.date ?? null,
          ok: !job.error,
          total: job.result?.total ?? null,
          at: new Date().toISOString(),
        };
        saveSchedule();
      }
      broadcast({ type: 'job-end', ok: !job.error, result: job.result, error: job.error, source });
    });
  return true;
}

// ------------------------------------------------------------
// 定时调度器（北京时间，配置持久化到 scheduler_config.json）
// ------------------------------------------------------------

const SCHED_FILE = process.env.SCHED_FILE
  ? path.resolve(process.env.SCHED_FILE)
  : path.join(__dirname, 'scheduler_config.json');
const SCHED_DEFAULT = { enabled: false, time: '23:50', lastRunDate: null, lastRun: null };

let schedule = (() => {
  try { return { ...SCHED_DEFAULT, ...JSON.parse(fs.readFileSync(SCHED_FILE, 'utf-8')) }; }
  catch { return { ...SCHED_DEFAULT }; }
})();

function saveSchedule() {
  try { fs.writeFileSync(SCHED_FILE, JSON.stringify(schedule, null, 2)); } catch {}
}

// 用 UTC+8 偏移构造"北京时间对象"，其 getUTC* 方法读出的就是北京的时/分/日
function beijingNow() { return new Date(Date.now() + 8 * 3600e3); }

function nextRunText() {
  const now = beijingNow();
  const [H, M] = schedule.time.split(':').map(Number);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), H, M));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 16).replace('T', ' ');
}

function scheduleTick() {
  if (!schedule.enabled) return;
  const now = beijingNow();
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);
  if (hhmm !== schedule.time || schedule.lastRunDate === today) return;
  if (job && job.running) return; // 有任务在跑，下一分钟再试
  schedule.lastRunDate = today;
  saveSchedule();
  console.log(`[调度] 定时任务触发 (${schedule.time})`);
  startJob({}, 'auto').then(started => {
    if (!started) { schedule.lastRunDate = null; saveSchedule(); }
  });
}

setInterval(scheduleTick, 30 * 1000);

// ------------------------------------------------------------
// 路由
// ------------------------------------------------------------

function sendJson(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function listHistory() {
  let files = [];
  try { files = fs.readdirSync(OUT_DIR).filter(f => /^fanqie_completed_\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch {}
  return files.sort().reverse().map(f => {
    const date = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
    let total = null, fetchTime = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf-8'));
      total = j.total_count; fetchTime = j.fetch_time;
    } catch {}
    return { date, total, fetchTime };
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(UI_HTML));
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/status') {
      sendJson(res, 200, {
        running: !!(job && job.running),
        date: job?.date ?? null,
        startedAt: job?.startedAt ?? null,
        result: job?.result ?? null,
        error: job?.error ?? null,
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('\n');
      // 回放当前任务的事件，便于刷新后恢复现场
      if (job) {
        res.write(`data: ${JSON.stringify({ type: 'replay-start', running: job.running, date: job.date })}\n\n`);
        for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (!job.running) {
          res.write(`data: ${JSON.stringify({ type: 'job-end', ok: !job.error, result: job.result, error: job.error, replay: true })}\n\n`);
        }
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/run') {
      const body = await readBody(req);
      const params = {};
      if (body.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          sendJson(res, 400, { error: '日期格式应为 YYYY-MM-DD' });
          return;
        }
        params.date = body.date;
      }
      if (Number.isFinite(+body.delay)) params.delay = +body.delay;
      if (Number.isFinite(+body.detailDelay)) params.detailDelay = +body.detailDelay;
      if (Number.isFinite(+body.maxPages)) params.maxPages = +body.maxPages;

      const started = await startJob(params);
      if (!started) {
        sendJson(res, 409, { error: '已有任务正在运行，请等待完成' });
        return;
      }
      sendJson(res, 202, { ok: true });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/history') {
      sendJson(res, 200, { files: listHistory() });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/schedule') {
      sendJson(res, 200, {
        enabled: schedule.enabled,
        time: schedule.time,
        lastRun: schedule.lastRun,
        nextRun: schedule.enabled ? nextRunText() : null,
        running: !!(job && job.running),
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/schedule') {
      const body = await readBody(req);
      if (typeof body.enabled === 'boolean') schedule.enabled = body.enabled;
      if (body.time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) {
          sendJson(res, 400, { error: '时间格式应为 HH:MM（24 小时制，北京时间）' });
          return;
        }
        schedule.time = body.time;
      }
      saveSchedule();
      sendJson(res, 200, {
        enabled: schedule.enabled,
        time: schedule.time,
        lastRun: schedule.lastRun,
        nextRun: schedule.enabled ? nextRunText() : null,
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/result') {
      const date = u.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, { error: 'date 参数应为 YYYY-MM-DD' });
        return;
      }
      const fp = path.join(OUT_DIR, `fanqie_completed_${date}.json`);
      if (!fs.existsSync(fp)) {
        sendJson(res, 404, { error: `没有找到 ${date} 的结果文件` });
        return;
      }
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (u.searchParams.get('download') === '1') {
        headers['Content-Disposition'] = `attachment; filename="fanqie_completed_${date}.json"`;
      }
      res.writeHead(200, headers);
      res.end(fs.readFileSync(fp));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`番茄每日完结小说抓取 UI 已启动: ${url}`);
  console.log(`输出目录: ${OUT_DIR} | 调度配置: ${SCHED_FILE}`);
  console.log('按 Ctrl+C 停止服务');
  if (AUTO_OPEN) {
    exec(`cmd /c start "" "${url}"`, () => {});
  }
});

// 优雅退出（Docker stop / Ctrl+C）：立即响应，避免 10s 强杀
function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在退出...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
