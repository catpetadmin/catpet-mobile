// v62: CatPet phone page. Same steps as "สร้างน้องจากรูป" on the computer, all in the phone's browser:
// photos + name / food / toy / skill / personality -> Master -> sprite sheet -> cut (app/sheetcut.js) -> repair poses
// -> upload as an online pet (Supabase, same SQL rules as the app). The computer then downloads it.
// v68.1: the pictures are made by the CatPet server (AI Studio, SQL 011 + Edge Function 'ai-job', the owner's OpenAI key),
// exactly like the computer: users pay diamonds, Admin / Dev may tick "free". No OpenAI key on the phone any more.
// Kept on this phone (localStorage): server URL + anon key (public), the login session, "free" (staff). Photos and
// pictures live in memory only.
'use strict';
const $ = (id) => document.getElementById(id);
const SH = window.CatPetShared, CUT = SH.SheetCut;
const T = window.CATPET_TEST || {};                         // tests only: { pollMs, busyMs }
const PLATFORM = 'web', VERSION = SH.version;
const SLOTS = ['front', 'side', 'back'];
const BG = { green: { hex: '#00FF00', name: 'pure bright green', rgb: [0, 255, 0] }, magenta: { hex: '#FF00FF', name: 'pure magenta', rgb: [255, 0, 255] } };
const MAX_EDIT = 10, EDIT_SIZE = 1024;

// ---------- storage ----------
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('catpet.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('catpet.' + k); else localStorage.setItem('catpet.' + k, JSON.stringify(v)); } catch (e) {} }
};
store.set('openai', null); store.set('ai', null);           // v68.1: a key / AI settings kept by an older page are removed

// ---------- session state (memory only) ----------
let S = null;
const newSession = () => ({ photos: {}, master: null, bg: 'green', sheet: null, cut: null, orig: {} });

// ---------- errors / busy ----------
class AppError extends Error { constructor(m, kind = 'error', detail = '') { super(m); this.kind = kind; this.detail = detail; } }
function showErr(e) {
  const box = $('err');
  if (!e) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = e.message + (e.detail ? '\n(รายละเอียด: ' + String(e.detail).slice(0, 300) + ')' : '');
  box.hidden = false; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
let run = null, wake = null;
async function busy(text, fn, { long = false } = {}) {
  if (run) return null;
  showErr(null);
  run = new AbortController();
  $('busyText').textContent = text; $('busy').hidden = false; $('cancelRun').hidden = !long; $('busyHint').hidden = !long;
  try { if (long && navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }   // keep the screen on
  try { return await fn(run.signal); }
  catch (e) { if (e.kind !== 'cancel' && e.name !== 'AbortError') showErr(e); return null; }
  finally { run = null; $('busy').hidden = true; try { if (wake) await wake.release(); } catch (e) {} wake = null; }
}
$('cancelRun').onclick = () => { if (run) run.abort(); };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && run && navigator.wakeLock && !wake) navigator.wakeLock.request('screen').then((w) => (wake = w)).catch(() => {});
});
// ---------- server (Supabase over plain HTTPS, like app/online.js) ----------
function jwtRole(k) { try { return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch (e) { return null; } }
function checkServer(url, anonKey) {
  url = String(url || '').trim().replace(/\/+$/, ''); anonKey = String(anonKey || '').trim();
  let u; try { u = new URL(url); } catch (e) { throw new AppError('ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง'); }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new AppError('ที่อยู่เซิร์ฟเวอร์ต้องขึ้นต้นด้วย https://');
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(anonKey) && !/^sb_publishable_[\w-]{10,}$/.test(anonKey)) throw new AppError('รูปแบบ anon key ไม่ถูกต้อง (ใช้ anon / publishable key เท่านั้น)');
  if (/service_role/.test(jwtRole(anonKey) || '')) throw new AppError('นี่คือ service_role key ห้ามใส่ ใช้ anon key แทน');
  return { url, anonKey };
}
const server = () => store.get('server');
const session = () => store.get('session');
async function sb(method, p, { body, headers = {}, auth = true, raw = false, timeout = 60000 } = {}) {
  const c = server(); if (!c) throw new AppError('ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์');
  if (auth) await freshSession();
  const h = { apikey: c.anonKey, Authorization: 'Bearer ' + (auth ? session().access_token : c.anonKey), ...headers };
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof FormData) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let res;
  try { res = await fetch(c.url + p, { method, headers: h, body, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new AppError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ตรวจอินเทอร์เน็ต)', 'net'); }
  if (raw && res.ok) return res;
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (res.ok) return data;
  const msg = (data && (data.message || data.msg || data.error_description || data.error)) || text.slice(0, 200) || res.statusText;
  if (res.status === 401 && auth) { store.set('session', null); render(); throw new AppError('การล็อกอินหมดอายุ กรุณาล็อกอินใหม่', 'auth'); }
  if (res.status === 429) throw new AppError('ส่งคำขอถี่เกินไป รอสักครู่แล้วลองใหม่', 'rate');
  if (data && data.message && /[฀-๿]/.test(data.message)) throw new AppError(data.message, 'rule');   // Thai sentences from our SQL
  let hint = '';
  if (/otp|token has expired|invalid/i.test(msg) && p.startsWith('/auth/')) hint = ': รหัสไม่ถูกต้องหรือหมดอายุ กดส่งรหัสใหม่';
  throw new AppError(`เซิร์ฟเวอร์แจ้งข้อผิดพลาด (${res.status})${hint}`, 'api', msg);
}
async function freshSession() {
  const s = session(); if (!s || !s.refresh_token) throw new AppError('ยังไม่ได้ล็อกอิน', 'auth');
  if (s.expires_at && Date.now() < s.expires_at - 60000) return;
  const d = await sb('POST', '/auth/v1/token?grant_type=refresh_token', { auth: false, body: { refresh_token: s.refresh_token } })
    .catch((e) => { if (e.kind !== 'net') { store.set('session', null); render(); } throw e.kind === 'net' ? e : new AppError('การล็อกอินหมดอายุ กรุณาล็อกอินใหม่', 'auth'); });
  store.set('session', toSession(d));
}
function toSession(d) {
  if (!d || !d.access_token || !d.refresh_token) throw new AppError('ล็อกอินไม่สำเร็จ', 'auth');
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, email: d.user && d.user.email };
}
const rpc = (fn, args = {}) => sb('POST', '/rest/v1/rpc/' + fn, { body: args });

// ---------- AI Studio (v68.1): the CatPet server makes the pictures, like app/aistudio.js on the computer ----------
let srv = null, usedDia = 0;                                // srv = ai_studio_state (+ reason when off)
const studioReset = () => { srv = null; }, studioKnown = () => !!srv;   // (render() has its own "srv" = the server address)
const freeOn = () => !!(srv && srv.staff && store.get('staffFree') !== false);
const price = (k) => (freeOn() ? 0 : srv && srv.price && srv.price[k] != null ? srv.price[k] : 0);
const REASON = { off: 'บัญชีนี้ยังสร้างน้องด้วย AI ไม่ได้ (ยังไม่เปิดให้ทุกคน)', no011: 'เซิร์ฟเวอร์ยังไม่มี AI Studio (ผู้ดูแลระบบ)', net: 'ต่อเน็ตไม่ได้ ตอนนี้สร้างน้องด้วย AI ไม่ได้',
  update: 'กรุณาโหลดหน้านี้ใหม่ (มีเวอร์ชันใหม่)', error: 'ตรวจ AI Studio ไม่ได้' };
const studioReason = () => (!srv ? 'กำลังตรวจ AI Studio…' : (REASON[srv.reason] || REASON.error) + (srv.reason === 'error' && srv.error ? ': ' + srv.error : ''));
async function refreshStudio() {
  try { srv = await rpc('ai_studio_state', { p_platform: PLATFORM, p_version: VERSION }); srv.reason = srv.on ? null : 'off'; }
  catch (e) {
    srv = { on: false, error: e.message, reason: e.kind === 'net' ? 'net' : /ai_studio_state|could not find|PGRST202|does not exist/i.test(e.message + ' ' + (e.detail || '')) ? 'no011' : /อัพเดต/.test(e.message) ? 'update' : 'error' };
  }
  renderStudio();
}
function renderStudio() {
  const on = !!(srv && srv.on), box = $('srvInfo');
  $('freeRow').hidden = !(on && srv.staff); $('freeChk').checked = freeOn();
  box.classList.toggle('off', !on);
  box.textContent = !on ? studioReason() : freeOn() ? `สร้างฟรี (${srv.role === 'admin' ? 'Admin' : 'Dev'}) ไม่หักเพชร ไม่มีเพดานต่อวัน`
    : `ราคา: ภาพ Master ${price('chibi')} 💎 · sprite sheet ${price('sheet')} 💎 · แก้ท่าละ ${price('edit')} 💎` + (srv.daily_cap != null ? ` · วันนี้ใช้ไป ${srv.today || 0}/${srv.daily_cap} งาน` : '') +
      ` · มี ${srv.diamond || 0} 💎 · ถ้าสร้างไม่สำเร็จ คืนเพชรให้อัตโนมัติ`;
  for (const id of ['goMaster', 'reMaster', 'goSheet', 'reSheet']) $(id).disabled = !on;
  syncSel(); setSpent();
}
function setSpent() { $('spent').textContent = freeOn() ? 'สร้างฟรี' : `ใช้ไปแล้วสำหรับตัวนี้ ${usedDia} 💎 · เหลือ ${(srv && srv.diamond) || 0} 💎`; }
function needDia(n) {
  if (!(srv && srv.on)) { showErr(new AppError(studioReason())); return false; }
  if (freeOn()) return true;
  const have = (srv && srv.diamond) || 0;
  if (have < n) { showErr(new AppError(`เพชรไม่พอ ต้องใช้ ${n} 💎 มี ${have} 💎`)); return false; }
  return true;
}
const diaAsk = (n, what) => (freeOn() ? `${what} (สร้างฟรี ไม่หักเพชร)` : `${what} ใช้ ${n} 💎 (มี ${(srv && srv.diamond) || 0} 💎)\nถ้าสร้างไม่สำเร็จ คืนเพชรให้อัตโนมัติ`);
const pause = (ms, signal) => new Promise((ok, no) => {
  if (signal.aborted) return no(new AppError('ยกเลิกแล้ว', 'cancel'));
  const t = setTimeout(ok, ms); signal.addEventListener('abort', () => { clearTimeout(t); no(new AppError('ยกเลิกแล้ว', 'cancel')); }, { once: true });
});
// one picture: ai_job_submit (diamonds taken, same UUID = same job) -> pictures to the Edge Function -> wait -> download + delete
async function studioRun(kind, images, params, signal) {
  const id = crypto.randomUUID(), t0 = Date.now();
  let sub;
  for (let tries = 0; ; tries++) {
    try { sub = await rpc('ai_job_submit', { p_job: id, p_kind: kind, p_params: params, p_inputs: images.length, p_platform: PLATFORM, p_version: VERSION, ...(freeOn() ? { p_free: true } : {}) }); break; }
    catch (e) { if (e.kind !== 'net' || tries >= 2) throw e; await pause(3000 * (tries + 1), signal); }
  }
  let job = sub.job; srv.diamond = sub.diamond; renderStudio();
  const cancel = async (msg) => {
    try { const r = await rpc('ai_job_cancel', { p_job: id }); job = r.job; srv.diamond = r.diamond; renderStudio(); } catch (e) {}
    return job && job.status === 'running' ? new AppError('หยุดรอแล้ว แต่งานนี้กำลังสร้างอยู่บนเซิร์ฟเวอร์ (ใช้เพชรไปแล้ว)') : new AppError(msg, msg === 'ยกเลิกแล้ว' ? 'cancel' : 'error');
  };
  for (let tries = 0; ; tries++) {
    if (signal.aborted) throw await cancel('ยกเลิกแล้ว');
    const fd = new FormData(); fd.append('job', id);
    images.forEach((b, i) => fd.append('image', b, `in_${i + 1}.${b.type === 'image/png' ? 'png' : 'jpg'}`));
    let r;
    try { r = await sb('POST', '/functions/v1/ai-job', { body: fd, timeout: 90000 }); }
    catch (e) {
      if (e.kind === 'net' && tries < 3) { await pause(3000 * (tries + 1), signal).catch(() => {}); continue; }
      const why = /[฀-๿]/.test(e.detail || '') ? e.detail : /not.?found|404/i.test(e.message + ' ' + (e.detail || '')) ? 'เซิร์ฟเวอร์ยังไม่ได้ติดตั้ง AI Studio (แจ้งผู้ดูแลระบบ)' : e.message;
      throw await cancel(why + ' (คืนเพชรแล้ว ถ้ายังไม่ได้เริ่มสร้าง)');
    }
    if (r && r.status === 'busy') {
      if (Date.now() - t0 > 12 * 60000) throw await cancel('คิว AI ยาวเกินไป ลองใหม่ภายหลัง (คืนเพชรแล้ว)');
      try { await pause(T.busyMs != null ? T.busyMs : Math.max(1, r.retry_after || 10) * 1000, signal); } catch (e) { throw await cancel('ยกเลิกแล้ว'); }
      continue;
    }
    if (r && r.job) job = r.job;
    break;
  }
  while (!['done', 'failed', 'cancelled'].includes(job.status)) {
    try { await pause(T.pollMs || 4000, signal); } catch (e) { throw await cancel('ยกเลิกแล้ว'); }
    if (Date.now() - t0 > 13 * 60000) throw new AppError('รอนานเกินไป ถ้างานไม่สำเร็จ เซิร์ฟเวอร์จะคืนเพชรให้เอง');
    try { const st = await rpc('ai_job_status', { p_jobs: [id] }); if (st.jobs && st.jobs[0]) job = st.jobs[0]; srv.diamond = st.diamond; } catch (e) { if (e.kind !== 'net') throw e; }
  }
  if (job.status !== 'done') { renderStudio(); throw new AppError(job.error || 'สร้างภาพไม่สำเร็จ คืนเพชรให้แล้ว', 'failed'); }
  const res = await sb('GET', '/storage/v1/object/authenticated/ai-results/' + job.result, { raw: true, timeout: 120000 });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) throw new AppError('ภาพที่ได้จากเซิร์ฟเวอร์เปิดไม่ได้');
  sb('DELETE', '/storage/v1/object/ai-results', { body: { prefixes: [job.result] } }).catch(() => {});   // not kept on the server
  srv.today = (srv.today || 0) + 1; usedDia += job.price || 0; renderStudio();
  return { png: new Blob([buf], { type: 'image/png' }), price: job.price || 0 };
}
const paidText = (r) => (r.price ? `ใช้ ${r.price} 💎 · ` : 'สร้างฟรี · ');

// ---------- pictures (canvas) ----------
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toBlob = (c, type = 'image/png', q) => new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new AppError('สร้างไฟล์ภาพไม่ได้'))), type, q));
async function bitmapOf(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { const url = URL.createObjectURL(blob); try { const im = new Image(); im.src = url; await im.decode(); return im; } finally { URL.revokeObjectURL(url); } }
}
async function photoFrom(file) {                           // like the app: at most 1536 px, PNG stays PNG
  if (file.size > 30 * 1024 * 1024) throw new AppError('ไฟล์รูปใหญ่เกิน 30MB');
  const im = await bitmapOf(file), w = im.width, h = im.height, k = Math.min(1, 1536 / Math.max(w, h));
  const c = canvas(Math.round(w * k), Math.round(h * k)); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const png = file.type === 'image/png';
  return toBlob(c, png ? 'image/png' : 'image/jpeg', 0.9);
}
async function greenShare(blob) {                          // strongly green pixels in the middle -> magenta background instead
  const im = await bitmapOf(blob), W = 96, H = Math.max(1, Math.round(96 * im.height / im.width));
  const c = canvas(W, H), g = c.getContext('2d'); g.drawImage(im, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data; let n = 0, gr = 0;
  for (let y = Math.floor(H * 0.15); y < H * 0.85; y++) for (let x = Math.floor(W * 0.2); x < W * 0.8; x++) { const i = (y * W + x) * 4; n++; if (d[i + 1] > d[i + 2] + 40 && d[i + 1] > d[i] + 40) gr++; }
  return n ? gr / n : 0;
}
// the cutter works on BGRA bitmaps { w, h, data } (Electron's toBitmap order); the browser gives RGBA
function bgraOf(imageData) { const d = new Uint8ClampedArray(imageData.data); for (let i = 0; i < d.length; i += 4) { const r = d[i]; d[i] = d[i + 2]; d[i + 2] = r; } return { w: imageData.width, h: imageData.height, data: d }; }
async function bgraOfBlob(blob) { const im = await bitmapOf(blob), c = canvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0); return bgraOf(g.getImageData(0, 0, c.width, c.height)); }
async function pngOfBgra(bm) {
  const c = canvas(bm.w, bm.h), g = c.getContext('2d'), id = g.createImageData(bm.w, bm.h), s = bm.data, d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = s[i + 2]; d[i + 1] = s[i + 1]; d[i + 2] = s[i]; d[i + 3] = s[i + 3]; }
  g.putImageData(id, 0, 0); return toBlob(c);
}
async function poseOnBackground(png) {                     // the pose centred on the key colour, ~60% of a square (as the app does)
  const im = await bitmapOf(png), f = (EDIT_SIZE * 0.6) / Math.max(im.width, im.height);
  const c = canvas(EDIT_SIZE, EDIT_SIZE), g = c.getContext('2d'), [r, gg, b] = BG[S.bg].rgb;
  g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(0, 0, EDIT_SIZE, EDIT_SIZE);
  const w = Math.round(im.width * f), h = Math.round(im.height * f); g.imageSmoothingQuality = 'high';
  g.drawImage(im, (EDIT_SIZE - w) >> 1, (EDIT_SIZE - h) >> 1, w, h); return toBlob(c);
}
const urlOf = (blob) => URL.createObjectURL(blob);

// ---------- screens ----------
const show = (id) => { $(id).hidden = false; $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); };
const hideFrom = (n) => { for (let i = n; i <= 3; i++) $('step' + i).hidden = true; };
function render() {
  const srv = server(), sess = session(), consent = store.get('consent') === true;
  $('secServer').hidden = !!srv;
  $('secLogin').hidden = !srv || !!(sess && sess.refresh_token);
  const ready = !!(srv && sess && sess.refresh_token);
  $('logoutBtn').hidden = !ready;
  $('who').textContent = ready ? `ล็อกอินเป็น ${sess.email || ''}` : 'สร้างน้องจากรูป แล้วส่งขึ้นออนไลน์ให้คอมดึงไปใช้';
  $('secAI').hidden = !ready;
  if (!ready) studioReset(); else if (!studioKnown()) refreshStudio();
  $('secConsent').hidden = !ready || consent;
  $('step1').hidden = !ready || !consent || !$('secDone').hidden;
  renderStudio();
}
// server from the computer's link: #s=<base64url of {"url":..,"anonKey":..}> (the fragment never reaches a web server)
(function serverFromLink() {
  const m = /[#&]s=([\w-]+)/.exec(location.hash); if (!m) return;
  try { const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))))); const c = checkServer(j.url, j.anonKey); if (!server() || server().url !== c.url) store.set('session', null); store.set('server', c); }
  catch (e) { setTimeout(() => showErr(new AppError('ลิงก์ตั้งค่าเซิร์ฟเวอร์ไม่ถูกต้อง: ' + e.message)), 0); }
  history.replaceState(null, '', location.pathname + location.search);
})();
$('srvSave').onclick = () => { try { store.set('server', checkServer($('srvUrl').value, $('srvKey').value)); store.set('session', null); showErr(null); render(); } catch (e) { showErr(e); } };
$('sendCode').onclick = () => busy('กำลังส่งรหัส…', async () => {
  const email = $('email').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('อีเมลไม่ถูกต้อง');
  await sb('POST', '/auth/v1/otp', { auth: false, body: { email, create_user: true } });
  $('codeRow').hidden = false; $('verifyRow').hidden = false; $('code').focus();
});
$('verify').onclick = () => busy('กำลังยืนยัน…', async () => {
  const code = $('code').value.replace(/\s/g, ''); if (!/^\d{6,10}$/.test(code)) throw new AppError('รหัสต้องเป็นตัวเลข');
  const d = await sb('POST', '/auth/v1/verify', { auth: false, body: { type: 'email', email: $('email').value.trim().toLowerCase(), token: code } });
  store.set('session', toSession(d));
  await rpc('ensure_profile', { p_display_name: null });
  render();
});
$('logoutBtn').onclick = async () => { try { await sb('POST', '/auth/v1/logout', {}); } catch (e) {} store.set('session', null); srv = null; render(); };
$('freeChk').onchange = () => { store.set('staffFree', $('freeChk').checked); renderStudio(); };   // v68.1: Admin / Dev only (the server checks)
$('consentChk').onchange = () => { $('consentOk').disabled = !$('consentChk').checked; };
$('consentOk').onclick = () => { store.set('consent', true); render(); };

// ---------- step 1: photos ----------
for (const el of document.querySelectorAll('.slot')) {
  const slot = el.dataset.slot, input = el.querySelector('input');
  input.onchange = () => busy('กำลังเปิดรูป…', async () => {
    const f = input.files && input.files[0]; input.value = ''; if (!f) return;
    S.photos[slot] = await photoFrom(f);
    el.querySelector('img').src = urlOf(S.photos[slot]); el.classList.add('has');
    S.master = null; S.cut = null; hideFrom(2);
  });
  el.querySelector('.x').onclick = (e) => { e.preventDefault(); e.stopPropagation(); delete S.photos[slot]; el.classList.remove('has'); el.querySelector('img').removeAttribute('src'); hideFrom(2); };
}
const fields = () => ({ name: $('fName').value.trim(), food: $('fFood').value, toy: $('fToy').value, skill: $('fSkill').value, persona: $('fPersona').value });
async function makeMaster(chained = false) {
  return busy((chained ? 'ขั้นที่ 1/2: ' : '') + 'กำลังสร้างภาพ Master (ประมาณ 30-90 วินาที)…', async (signal) => {
    const photos = SLOTS.map((k) => S.photos[k]).filter(Boolean);
    if (!photos.length) throw new AppError('ถ่ายหรือเลือกรูปต้นแบบอย่างน้อย 1 รูป');
    let share = 0; for (const p of photos) share = Math.max(share, await greenShare(p));
    S.bg = share > 0.06 ? 'magenta' : 'green';
    const r = await studioRun('chibi', photos, { bg: S.bg, persona: fields().persona.slice(0, 200) }, signal);
    S.master = r.png; S.cut = null;
    $('masterImg').src = urlOf(r.png);
    $('masterInfo').textContent = paidText(r) + `พื้นหลัง sprite sheet จะใช้สี${S.bg === 'magenta' ? 'ชมพู (ตัวละครมีสีเขียวมาก)' : 'เขียว'}`;
    hideFrom(3); show('step2');
    return true;
  }, { long: true });
}
// v62.1: "สร้างภาพเคลื่อนไหว" = Master, then the sprite sheet right away (one cost question for both)
async function makeAll() {
  const n = price('chibi') + price('sheet');
  if (!needDia(n) || !confirm(diaAsk(n, freeOn() ? 'สร้างภาพเคลื่อนไหว: ภาพ Master แล้วต่อด้วย sprite sheet' : `สร้างภาพเคลื่อนไหว: ภาพ Master (${price('chibi')} 💎) แล้วต่อด้วย sprite sheet (${price('sheet')} 💎)\nรวม`) + '\nใช้เวลารวม 2-4 นาที เปิดหน้าจอค้างไว้\n\nทำต่อไหม?')) return;
  if (await makeMaster(true)) await makeSheet(true);
}
$('goMaster').onclick = () => makeAll();
$('reMaster').onclick = () => { if (needDia(price('chibi')) && confirm(diaAsk(price('chibi'), 'สร้างภาพ Master ใหม่') + '\n\nทำต่อไหม?')) makeMaster(false); };

// ---------- step 2 -> sheet -> cut ----------
async function makeSheet(chained = false) {
  if (!chained && (!needDia(price('sheet')) || !confirm(diaAsk(price('sheet'), 'สร้าง sprite sheet') + '\nใช้เวลา 1-3 นาที เปิดหน้าจอค้างไว้\n\nทำต่อไหม?'))) return;
  await busy((chained ? 'ขั้นที่ 2/2: ' : '') + 'กำลังสร้าง sprite sheet (อาจใช้ 1-3 นาที)…', async (signal) => {
    if (!S.master) throw new AppError('ยังไม่มีภาพ Master');
    const f = fields();
    const r = await studioRun('sheet', [S.master], { bg: S.bg, food: f.food.slice(0, 120), toy: f.toy.slice(0, 120), skill: f.skill.slice(0, 120), persona: f.persona.slice(0, 200) }, signal);
    S.sheet = r.png;
    $('busyText').textContent = 'กำลังตัดเป็นท่า…';
    await new Promise((ok) => setTimeout(ok, 30));
    await cutSheetNow(r);
  }, { long: true });
}
async function cutSheetNow(r) {
  $('sheetImg').src = urlOf(S.sheet);
  const lines = [r.price ? `ใช้ ${r.price} 💎 สำหรับ sheet นี้` : 'สร้าง sheet นี้ฟรี'];
  S.cut = null; S.orig = {}; selected.clear();
  try {
    const bm = await bgraOfBlob(S.sheet);
    if (bm.w < 600 || bm.h < 600 || bm.w > 4096 || bm.h > 4096) throw new AppError(`ขนาดภาพ ${bm.w}×${bm.h} ไม่เหมาะ ต้องอยู่ระหว่าง 600 ถึง 4096 px`);
    const r = CUT.cutSheet(bm), files = {};
    for (const [k, p] of Object.entries(r.poses)) if (SH.KNOWN.includes(k)) files[k] = { png: await pngOfBgra(p), w: p.w, h: p.h };
    S.cut = files; lines.push(...(r.warnings || []).map((x) => x.replace('ตรวจในหน้า "ปรับขนาดท่า"', 'ปรับได้ในคอมหลังดาวน์โหลด (Pets > ปรับขนาดท่า)')));
  } catch (e) { lines.push('ตัดภาพไม่ได้: ' + e.message + ' · ลองกด "สร้าง sheet ใหม่"'); }
  const w = $('cutWarn'); w.textContent = ''; for (const x of lines) { const d = document.createElement('div'); d.textContent = x; w.appendChild(d); } w.hidden = !lines.length;
  renderGallery();
  $('editBox').hidden = !S.cut; $('upload').disabled = !S.cut;
  show('step3');
}
$('goSheet').onclick = () => makeSheet(false);      // (not the click event: that would skip the cost question)
$('reSheet').onclick = () => makeSheet(false);

// ---------- step 3: repair poses ----------
const selected = new Set();
function figure(k) {
  const p = S.cut[k], f = document.createElement('figure'); f.dataset.k = k;
  const im = document.createElement('img'); im.src = urlOf(p.png); im.alt = k;
  const cap = document.createElement('figcaption'); cap.textContent = k; f.append(im, cap);
  if (S.orig[k]) {
    const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'แก้แล้ว';
    const u = document.createElement('button'); u.className = 'undo'; u.type = 'button'; u.textContent = '↺'; u.setAttribute('aria-label', 'กลับไปใช้ภาพเดิม');
    u.onclick = (e) => { e.stopPropagation(); S.cut[k] = S.orig[k]; delete S.orig[k]; f.replaceWith(figure(k)); };
    f.append(t, u);
  }
  if (selected.has(k)) f.classList.add('sel');
  f.onclick = () => { if (run) return; if (selected.has(k)) selected.delete(k); else selected.add(k); f.classList.toggle('sel', selected.has(k)); syncSel(); };
  return f;
}
function renderGallery() { const g = $('gallery'); g.textContent = ''; if (S.cut) for (const k of Object.keys(S.cut)) g.appendChild(figure(k)); syncSel(); }
function syncSel() {
  $('selCount').textContent = selected.size ? `เลือก ${selected.size} ภาพ` : 'ยังไม่ได้เลือก';
  $('selCount').classList.toggle('ok', selected.size > 0); $('editGo').disabled = !selected.size || !(srv && srv.on);
}
$('selNone').onclick = () => { selected.clear(); renderGallery(); };
$('editGo').onclick = async () => {
  const text = $('editText').value.trim().slice(0, 600), keys = [...selected];
  if (!text) { $('editText').focus(); return showErr(new AppError('พิมพ์อธิบายว่าจะแก้อะไร')); }
  if (keys.length > MAX_EDIT) return showErr(new AppError(`แก้ได้ครั้งละไม่เกิน ${MAX_EDIT} ภาพ`));
  const n = keys.length * price('edit');
  if (!needDia(n) || !confirm(diaAsk(n, freeOn() ? `แก้ ${keys.length} ภาพ` : `แก้ ${keys.length} ภาพ ภาพละ ${price('edit')} 💎\nรวม`) + '\n\nทำต่อไหม?')) return;
  await busy(`กำลังแก้ ${keys.length} ภาพ (ภาพละประมาณ 20-60 วินาที)…`, async (signal) => {
    let ok = 0, failure = null;
    for (const k of keys) {
      try {
        const images = [await poseOnBackground(S.cut[k].png)]; if (S.master) images.push(S.master);
        const r = await studioRun('edit', images, { bg: S.bg, pose: k, change: text }, signal);
        const ref = await bgraOfBlob((S.orig[k] || S.cut[k]).png), bm = CUT.cutOne(await bgraOfBlob(r.png), ref);
        if (!S.orig[k]) S.orig[k] = S.cut[k];
        S.cut[k] = { png: await pngOfBgra(bm), w: bm.w, h: bm.h }; selected.delete(k); ok++;
      } catch (e) {
        failure = new AppError(`แก้ ${k} ไม่สำเร็จ: ${e.message}`, e.kind, e.detail);
        if (['cancel', 'rule', 'auth', 'net'].includes(e.kind)) break;   // rule = no diamonds / daily cap
      }
    }
    renderGallery();
    const w = $('cutWarn'), d = document.createElement('div'); d.textContent = `แก้สำเร็จ ${ok} จาก ${keys.length} ภาพ`; w.appendChild(d); w.hidden = false;
    if (failure) throw failure;
  }, { long: true });
};

// ---------- upload as an online pet (pet_register + storage, like app/online.js putOnline) ----------
async function sha256hex(blob) { const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
$('upload').onclick = async () => {
  const name = $('fName').value.trim().slice(0, 40);
  if (!name) { $('fName').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('fName').focus(); return showErr(new AppError('ตั้งชื่อน้องในขั้นที่ 1 ก่อนส่งขึ้นออนไลน์')); }
  if (!S.cut || !S.cut.idle_01) return showErr(new AppError('ยังไม่มีภาพท่าทาง (ต้องมี idle_01)'));
  if (!confirm(`ส่ง ${name} เข้าบัญชี? (${Object.keys(S.cut).length} ท่า) คอมทุกเครื่องที่ล็อกอินบัญชีนี้จะได้น้องตัวนี้เอง เพื่อนยังไม่เห็นจนกว่าจะติ๊ก "ให้เพื่อนเห็น" ในหน้า Pets ที่คอม`)) return;   // v74 (C2)
  await busy('กำลังส่งขึ้นออนไลน์…', async () => {
    const keys = Object.keys(S.cut).sort();
    const args = { p_name: name, p_files: keys, p_tweaks: { hand: 'auto', face: 'auto', scale: null }, p_hash: await sha256hex(S.cut.idle_01.png) };
    let reg; try { reg = await rpc('pet_register', { ...args, p_shared: false }); }   // v74: friends do not see it until ticked (owner 2026-11-27)
    catch (e) { if (!/p_shared|PGRST202|could not find/i.test(String(e && e.message))) throw e; reg = await rpc('pet_register', args); }   // server without 015
    try {
      for (let i = 0; i < keys.length; i++) {
        $('busyText').textContent = `กำลังส่งขึ้นออนไลน์ ${i + 1} / ${keys.length}…`;
        await sb('POST', `/storage/v1/object/pets/${reg.id}/${reg.version}/${keys[i]}.png`, { body: S.cut[keys[i]].png, headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' } });
      }
    } catch (e) {                                          // all or nothing (as the app does)
      try { await sb('DELETE', '/storage/v1/object/pets', { body: { prefixes: keys.map((k) => `${reg.id}/${reg.version}/${k}.png`) } }); await rpc('pet_remove', { p_pet: reg.id }); } catch (x) {}
      throw e;
    }
    $('doneText').textContent = `${name} ขึ้นออนไลน์แล้ว (${keys.length} ท่า)` + (reg.duplicate ? ' · ภาพ idle_01 นี้มีคนอื่นนำขึ้นออนไลน์ไว้ก่อน ถ้าไม่ใช่น้องของคุณเอง กรุณาเอาออก' : '');
    hideFrom(1); $('secDone').hidden = false; $('secDone').scrollIntoView({ behavior: 'smooth' });
  }, { long: true });
};
$('again').onclick = () => {
  S = newSession();
  for (const el of document.querySelectorAll('.slot')) { el.classList.remove('has'); el.querySelector('img').removeAttribute('src'); }
  for (const id of ['fName', 'fFood', 'fToy', 'fSkill', 'fPersona', 'editText']) $(id).value = '';
  $('secDone').hidden = true; hideFrom(2); usedDia = 0; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
};

S = newSession();
render();
window.__mobile = { get S() { return S; }, get srv() { return srv; }, store };       // tests
