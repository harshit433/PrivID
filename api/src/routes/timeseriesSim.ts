/**
 * Time-series trust/call simulation — HTTP surface.
 *
 * Mounted under /simulation/timeseries (behind the same ENABLE_SIMULATION guard
 * as the rest of /simulation). Drives the background engine and serves a live SSE
 * dashboard + final report.
 *
 *   POST /start     { sim_key, ...params }   → begin a run
 *   POST /stop       { sim_key }             → stop the active run
 *   POST /teardown   { sim_key }             → delete all tsim_ data
 *   GET  /status?sim_key=                    → run status + latest snapshot
 *   GET  /report?sim_key=                    → final evaluation JSON
 *   GET  /stream?sim_key=                    → SSE live metrics
 *   GET  /live?sim_key=                      → self-contained live dashboard (HTML)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { startRun, stopRun, getRun, getReport, DEFAULT_PARAMS, type RunParams } from '../services/simEngine/scheduler';
import { teardownSim } from '../services/simEngine/teardown';

export const timeseriesRouter = Router();

const SIM_KEY = process.env.SIMULATION_KEY ?? 'privid-sim-2024';

function keyOk(req: Request): boolean {
  const key = req.body?.sim_key ?? req.query?.sim_key;
  return key === SIM_KEY;
}
function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!keyOk(req)) return res.status(401).json({ ok: false, error: 'Invalid simulation key.' });
  next();
}

function parseParams(body: any): Partial<RunParams> {
  const out: Partial<RunParams> = {};
  const num = (v: any) => (v == null ? undefined : Number(v));
  if (num(body.accounts) !== undefined) out.accounts = Math.max(10, Math.min(2000, num(body.accounts)!));
  if (num(body.virtual_days) !== undefined) out.virtual_days = Math.max(1, Math.min(60, num(body.virtual_days)!));
  if (num(body.wall_minutes) !== undefined) out.wall_minutes = Math.max(1, Math.min(60, num(body.wall_minutes)!));
  if (num(body.step_hours) !== undefined) out.step_hours = Math.max(1, Math.min(24, num(body.step_hours)!));
  if (num(body.recompute_every_hours) !== undefined) out.recompute_every_hours = Math.max(1, Math.min(48, num(body.recompute_every_hours)!));
  if (num(body.seed) !== undefined) out.seed = num(body.seed)!;
  if (body.keep_data !== undefined) out.keep_data = body.keep_data === true || body.keep_data === 'true';
  return out;
}

timeseriesRouter.post('/start', requireKey, (req: Request, res: Response) => {
  try {
    const run = startRun(parseParams(req.body ?? {}));
    res.json({ ok: true, run_id: run.run_id, status: run.status, params: run.params });
  } catch (e: any) {
    res.status(409).json({ ok: false, error: e?.message ?? String(e) });
  }
});

timeseriesRouter.post('/stop', requireKey, (_req: Request, res: Response) => {
  res.json({ ok: true, stopped: stopRun() });
});

timeseriesRouter.post('/teardown', requireKey, async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ ok: true, ...(await teardownSim()) }); } catch (e) { next(e); }
});

timeseriesRouter.get('/status', requireKey, (_req: Request, res: Response) => {
  const run = getRun();
  if (!run) return res.json({ ok: true, status: 'idle' });
  res.json({
    ok: true, run_id: run.run_id, status: run.status, params: run.params,
    virtual_day: run.virtual_day, progress: run.progress, error: run.error,
    snapshot: run.last_snapshot,
  });
});

timeseriesRouter.get('/report', requireKey, (_req: Request, res: Response) => {
  const report = getReport();
  if (!report) return res.status(404).json({ ok: false, error: 'No run/report available yet.' });
  res.json({ ok: true, report });
});

timeseriesRouter.get('/stream', requireKey, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as any).flushHeaders?.();

  const run = getRun();
  const send = (payload: unknown) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ } };
  if (run?.last_snapshot) send(run.last_snapshot);
  const onTick = (payload: unknown) => send(payload);
  run?.emitter.on('tick', onTick);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15_000);
  req.on('close', () => { clearInterval(ping); run?.emitter.off('tick', onTick); });
});

timeseriesRouter.get('/live', (req: Request, res: Response) => {
  // Page itself is not secret; the SSE/API calls it makes still require sim_key.
  const key = encodeURIComponent(String(req.query.sim_key ?? ''));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LIVE_HTML.replace('__SIM_KEY__', key));
});

// External script (same-origin) — required because Helmet CSP blocks inline scripts.
timeseriesRouter.get('/live.js', (req: Request, res: Response) => {
  const key = String(req.query.sim_key ?? '');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(
    LIVE_JS
      .replace('__SIM_KEY__', JSON.stringify(key))
      .replace('__DEFAULTS__', JSON.stringify(DEFAULT_PARAMS)),
  );
});

const LIVE_HTML = /* html */ `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>TrustRoute — Time-Series Simulation</title>
<style>
  :root{--bg:#0b0f14;--panel:#141b24;--line:#22303c;--txt:#e6edf3;--dim:#8b9aa8;--good:#22c55e;--bad:#ef4444;--warn:#f59e0b;--acc:#38bdf8}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:700}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:16px 20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .card .v{font-size:26px;font-weight:800;margin-top:4px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 20px 20px}
  @media(max-width:820px){.row{grid-template-columns:1fr}}
  .box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
  .box h2{font-size:12px;margin:0 0 10px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
  canvas{width:100%;height:220px;display:block}
  .bar{display:flex;align-items:center;gap:8px;margin:5px 0}
  .bar .lbl{width:120px;color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar .track{flex:1;height:14px;background:#0c1218;border-radius:7px;overflow:hidden}
  .bar .fill{height:100%;border-radius:7px}
  .bar .num{width:34px;text-align:right;font-variant-numeric:tabular-nums}
  button{background:var(--acc);color:#001018;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
  button.ghost{background:transparent;color:var(--txt);border:1px solid var(--line)}
  input{background:#0c1218;border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:6px 8px;width:64px}
  .pill{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
  label{color:var(--dim);font-size:12px;display:inline-flex;gap:6px;align-items:center}
  .muted{color:var(--dim)}
</style></head><body>
<header>
  <h1>⚡ TrustRoute Time-Series Simulation</h1>
  <span id="status" class="pill" style="background:#1f2937">idle</span>
  <span class="muted">virtual day <b id="vday">0</b> · <span id="prog">0%</span></span>
  <span style="flex:1"></span>
  <label>accts <input id="p_accounts" type="number"></label>
  <label>days <input id="p_days" type="number"></label>
  <label>mins <input id="p_mins" type="number"></label>
  <button id="startBtn">Start run</button>
  <button id="stopBtn" class="ghost">Stop</button>
</header>
<div class="grid">
  <div class="card"><div class="k">Detection rate</div><div class="v" id="m_det" style="color:var(--good)">–</div></div>
  <div class="card"><div class="k">False positives</div><div class="v" id="m_fp" style="color:var(--bad)">–</div></div>
  <div class="card"><div class="k">Under review</div><div class="v" id="m_rev" style="color:var(--warn)">–</div></div>
  <div class="card"><div class="k">Bad detected</div><div class="v" id="m_bad">–</div></div>
  <div class="card"><div class="k">Total calls</div><div class="v" id="m_calls">–</div></div>
  <div class="card"><div class="k">Blocks</div><div class="v" id="m_blocks">–</div></div>
</div>
<div class="row">
  <div class="box"><h2>Detection vs false-positive over time</h2><canvas id="chart" width="700" height="220"></canvas>
    <div class="muted" style="margin-top:6px"><span style="color:var(--good)">■</span> detection %  <span style="color:var(--bad)">■</span> false-positive %</div></div>
  <div class="box"><h2>Mean trust score by persona</h2><div id="personas"></div></div>
</div>
<div class="row"><div class="box" style="grid-column:1/-1"><h2>Tier distribution</h2><div id="tiers"></div></div></div>
<script src="live.js?sim_key=__SIM_KEY__"></script></body></html>`;

const LIVE_JS = /* js */ `
const KEY=__SIM_KEY__; const D=__DEFAULTS__;
const $=id=>document.getElementById(id);
$("p_accounts").value=D.accounts; $("p_days").value=D.virtual_days; $("p_mins").value=D.wall_minutes;
const BADP=new Set(["mass_spammer","scammer","harasser","reformed","sleeper"]);
const TIERC={anonymous:"#64748b",basic:"#38bdf8",verified:"#22c55e",premium:"#a855f7"};
let hist=[];
function color(p){return BADP.has(p)?"#ef4444":"#22c55e"}
function bars(el,obj,max,fmt,colf){const box=$(el);box.innerHTML="";Object.keys(obj).sort().forEach(k=>{const v=obj[k];const pct=Math.max(0,Math.min(100,(v/max)*100));box.insertAdjacentHTML("beforeend",
  '<div class="bar"><div class="lbl">'+k+'</div><div class="track"><div class="fill" style="width:'+pct+'%;background:'+colf(k)+'"></div></div><div class="num">'+fmt(v)+'</div></div>')})}
function draw(){const c=$("chart"),x=c.getContext("2d");const W=c.width,H=c.height;x.clearRect(0,0,W,H);
  x.strokeStyle="#22303c";x.beginPath();x.moveTo(30,H-20);x.lineTo(W-6,H-20);x.moveTo(30,6);x.lineTo(30,H-20);x.stroke();
  if(hist.length<2)return;const n=hist.length;const px=i=>30+(i/(n-1))*(W-40);const py=v=>H-20-(v/100)*(H-30);
  const series=(key,col)=>{x.strokeStyle=col;x.lineWidth=2;x.beginPath();hist.forEach((h,i)=>{const y=py(h[key]||0);i?x.lineTo(px(i),y):x.moveTo(px(i),y)});x.stroke()};
  series("detection_rate","#22c55e");series("false_positive_rate","#ef4444")}
function apply(s){
  if(s.status)$("status").textContent=s.status;
  if(s.event==="done")$("status").textContent="done";
  if(s.day!=null)$("vday").textContent=s.day;
  if(s.progress!=null)$("prog").textContent=Math.round(s.progress*100)+"%";
  if(s.detection_rate!=null){$("m_det").textContent=s.detection_rate+"%";$("m_fp").textContent=s.false_positive_rate+"%";
    $("m_rev").textContent=s.under_review;$("m_bad").textContent=s.bad_detected+"/"+s.bad_total;
    $("m_calls").textContent=(s.total_calls||0).toLocaleString();$("m_blocks").textContent=s.total_blocks||0;
    hist.push({detection_rate:s.detection_rate,false_positive_rate:s.false_positive_rate});draw()}
  if(s.persona_means)bars("personas",s.persona_means,100,v=>v,color);
  if(s.tiers)bars("tiers",s.tiers,Math.max(1,Object.values(s.tiers).reduce((a,b)=>a+b,0)),v=>v,k=>TIERC[k]||"#38bdf8")}
let es=null;
function openStream(){if(es)es.close();es=new EventSource("stream?sim_key="+encodeURIComponent(KEY));es.onmessage=e=>{try{apply(JSON.parse(e.data))}catch(_){}}}
$("startBtn").onclick=async()=>{hist=[];const body={sim_key:KEY,accounts:+$("p_accounts").value,virtual_days:+$("p_days").value,wall_minutes:+$("p_mins").value};
  const r=await fetch("start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const j=await r.json();
  if(!j.ok){alert(j.error||"start failed");return}$("status").textContent="seeding";openStream()};
$("stopBtn").onclick=()=>fetch("stop",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sim_key:KEY})});
(async()=>{const r=await fetch("status?sim_key="+encodeURIComponent(KEY));const j=await r.json();if(j.snapshot)apply(j.snapshot);if(["running","recomputing","seeding"].includes(j.status)){$("status").textContent=j.status;openStream()}})();
`;
