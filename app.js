// v62: CatPet phone page. Same steps as "สร้างน้องจากรูป" on the computer, all in the phone's browser:
// photos + name / food / toy / skill / personality -> Master (OpenAI) -> sprite sheet (OpenAI) -> cut (app/sheetcut.js)
// -> repair poses (OpenAI) -> upload as an online pet (Supabase, same SQL rules as the app). The computer then downloads it.
// Kept on this phone (localStorage): server URL + anon key (public), the login session, the OpenAI key (only if "remember"),
// AI settings. Photos and pictures live in memory only. The OpenAI key goes to api.openai.com only.
'use strict';
const $ = (id) => document.getElementById(id);
const SH = window.CatPetShared, CUT = SH.SheetCut;
const T = window.CATPET_TEST || {};                         // tests only: { oaiBase }
const OAI = T.oaiBase || 'https://api.openai.com/v1';
const SLOTS = ['front', 'side', 'back'];
const BG = { green: { hex: '#00FF00', name: 'pure bright green', rgb: [0, 255, 0] }, magenta: { hex: '#FF00FF', name: 'pure magenta', rgb: [255, 0, 255] } };
const EST = { chibi: 0.3, edit: 0.08 }, SHEET_EST = { '1024x1536': 0.8, '1440x2160': 1.6, '2048x2560': 3 };
const MAX_EDIT = 10, EDIT_SIZE = 1024;

// ---------- storage ----------
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('catpet.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('catpet.' + k); else localStorage.setItem('catpet.' + k, JSON.stringify(v)); } catch (e) {} }
};
let memKey = null;                                         // the OpenAI key when "remember" is off
const openaiKey = () => memKey || store.get('openai');
const aiSet = () => ({ quality: SH.AI_DEFAULTS.quality, sheetSize: SH.AI_DEFAULTS.sheetSize, capUsd: SH.AI_DEFAULTS.capUsd, ...(store.get('ai') || {}) });

// ---------- session state (memory only) ----------
let S = null;
const newSession = () => ({ photos: {}, master: null, bg: 'green', sheet: null, cut: null, orig: {}, spent: 0, unknownCost: false, costs: {} });

// ---------- errors / busy ----------
class AppError extends Error { constructor(m, kind = 'error', detail = '') { super(m); this.kind = kind; this.detail = detail; } }
function showErr(e) {
  const box = $('err');
  if (!e) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = e.message + (e.detail ? '\n(รายละเอียด: ' + String(e.detail).slice(0, 300) + ')' : '');
  box.hidden = false; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (['nokey', 'auth-openai', 'cap'].includes(e.kind)) $('secAI').open = true;
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
const money = (v) => '$' + (v || 0).toFixed(2);
function setSpent() { $('spent').textContent = `ใช้ไปแล้วสำหรับตัวนี้ ${money(S.spent)} (ประมาณ)` + (S.unknownCost ? ' + บางคำขอไม่ทราบราคา' : '') + ` · เพดาน ${money(aiSet().capUsd)}`; }
function budget(what) {
  const est = S.costs[what] || (what === 'sheet' ? SHEET_EST[aiSet().sheetSize] || 0.8 : EST[what]);
  if (S.spent + est > aiSet().capUsd) throw new AppError(`เกินเพดานค่าใช้จ่ายต่อตัว (${money(aiSet().capUsd)}) ใช้ไปแล้ว ${money(S.spent)} ปรับเพดานได้ใน "ตั้งค่า AI"`, 'cap');
}
function spend(what, cost) { if (cost == null) S.unknownCost = true; else { S.spent += cost; S.costs[what] = cost; } setSpent(); }

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
  if (body !== undefined && !(body instanceof Blob) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
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

// ---------- OpenAI (images/edits only), with the app's retries and messages ----------
async function oai(pathname, fd, signal) {
  const key = openaiKey(); if (!key) throw new AppError('ใส่ OpenAI API key ใน "ตั้งค่า AI" ก่อน', 'nokey');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r, j) => { const t = setTimeout(r, attempt * 4000); signal.addEventListener('abort', () => { clearTimeout(t); j(new AppError('ยกเลิกแล้ว', 'cancel')); }, { once: true }); });
    let res;
    try { res = await fetch(OAI + pathname, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal }); }
    catch (e) { if (signal.aborted) throw new AppError('ยกเลิกแล้ว', 'cancel'); last = new AppError('เชื่อมต่อ api.openai.com ไม่ได้ (ถ้าหน้าจอดับหรือสลับแอประหว่างรอ การเชื่อมต่ออาจหลุด ลองใหม่โดยเปิดจอค้างไว้)', 'net'); continue; }
    const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch (e) {}
    if (res.ok) return body;
    const msg = (body && body.error && body.error.message) || text.slice(0, 300) || res.statusText, code = body && body.error && (body.error.code || body.error.type);
    if (res.status === 401) throw new AppError('OpenAI API key ไม่ถูกต้องหรือถูกยกเลิก', 'auth-openai', msg);
    if (res.status === 403) throw new AppError('บัญชีนี้ยังใช้โมเดลนี้ไม่ได้ (อาจต้องทำ Organization Verification ในหน้า OpenAI)', 'forbidden', msg);
    if (res.status === 429 && /quota|billing|credit/i.test(msg + code)) throw new AppError('เครดิต OpenAI หมดหรือยังไม่ได้ตั้งการชำระเงิน', 'quota', msg);
    if (res.status === 400 && /safety|policy|moderation|content/i.test(msg + code)) throw new AppError('OpenAI ปฏิเสธคำขอนี้ตามนโยบายเนื้อหา', 'policy', msg);
    if (res.status === 429 || res.status >= 500) { last = new AppError(`OpenAI ไม่ว่าง (${res.status}) ลองใหม่อีกครั้ง`, 'busy', msg); continue; }
    throw new AppError(`OpenAI แจ้งข้อผิดพลาด (${res.status})`, 'api', msg);
  }
  throw last;
}
function imageCost(u) {
  if (!u || u.output_tokens == null) return null;
  const p = SH.AI_DEFAULTS.price, d = u.input_tokens_details || {};
  const img = d.image_tokens != null ? d.image_tokens : 0, txt = d.text_tokens != null ? d.text_tokens : Math.max(0, (u.input_tokens || 0) - img);
  return (txt * p.textIn + img * p.imageIn + u.output_tokens * p.imageOut) / 1e6;
}
async function editImage({ images, prompt, size }, signal) {
  const fd = new FormData();
  fd.append('model', SH.AI_DEFAULTS.imageModel); fd.append('prompt', prompt); fd.append('size', size);
  fd.append('quality', aiSet().quality); fd.append('background', 'opaque'); fd.append('output_format', 'png'); fd.append('n', '1');
  images.forEach((b, i) => fd.append('image[]', b, `ref_${i + 1}.${b.type === 'image/png' ? 'png' : 'jpg'}`));
  const body = await oai('/images/edits', fd, signal);
  const b64 = body && body.data && body.data[0] && body.data[0].b64_json;
  if (!b64) throw new AppError('OpenAI ไม่ได้ส่งภาพกลับมา', 'api');
  const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { png: new Blob([u8], { type: 'image/png' }), cost: imageCost(body.usage) };
}
const fill = (tpl, v) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (v[k] != null ? String(v[k]) : m));

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
  $('secConsent').hidden = !ready || consent;
  $('step1').hidden = !ready || !consent || !$('secDone').hidden;
  const k = openaiKey(); $('keyBadge').textContent = k ? 'มี key …' + k.slice(-4) + (memKey ? ' (ไม่ได้จำ)' : '') : 'ยังไม่มี key'; $('keyBadge').classList.toggle('ok', !!k);
  if (ready && !k) $('secAI').open = true;
  const a = aiSet(); $('sQuality').value = a.quality; $('sSize').value = a.sheetSize; $('sCap').value = a.capUsd;
  setSpent();
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
$('logoutBtn').onclick = async () => { try { await sb('POST', '/auth/v1/logout', {}); } catch (e) {} store.set('session', null); render(); };
$('keySave').onclick = () => {
  const k = $('keyIn').value.trim(); $('keyIn').value = '';
  if (!/^sk-[\w\-]{20,300}$/.test(k)) return showErr(new AppError('รูปแบบ key ไม่ถูกต้อง (ต้องขึ้นต้นด้วย sk-)'));
  if ($('keyRemember').checked) { store.set('openai', k); memKey = null; } else { store.set('openai', null); memKey = k; }
  showErr(null); render();
};
$('keyDel').onclick = () => { store.set('openai', null); memKey = null; render(); };
for (const id of ['sQuality', 'sSize', 'sCap']) $(id).onchange = () => {
  const cap = Number($('sCap').value); store.set('ai', { quality: $('sQuality').value, sheetSize: $('sSize').value, capUsd: isFinite(cap) && cap >= 0.5 && cap <= 50 ? cap : SH.AI_DEFAULTS.capUsd }); render();
};
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
    budget('chibi');
    let share = 0; for (const p of photos) share = Math.max(share, await greenShare(p));
    S.bg = share > 0.06 ? 'magenta' : 'green';
    const prompt = fill(SH.PROMPTS.chibi, { BG: BG[S.bg].hex, BGNAME: BG[S.bg].name, PERSONALITY: SH.personaLine(fields().persona, false) });
    const r = await editImage({ images: photos, prompt, size: SH.AI_DEFAULTS.chibiSize }, signal);
    spend('chibi', r.cost);
    S.master = r.png; S.cut = null;
    $('masterImg').src = urlOf(r.png);
    $('masterInfo').textContent = (r.cost != null ? `ค่าใช้จ่ายภาพนี้ ${money(r.cost)} · ` : 'ไม่ทราบค่าใช้จ่ายของภาพนี้ · ') + `พื้นหลัง sprite sheet จะใช้สี${S.bg === 'magenta' ? 'ชมพู (ตัวละครมีสีเขียวมาก)' : 'เขียว'}`;
    hideFrom(3); show('step2');
    return true;
  }, { long: true });
}
// v62.1: "สร้างภาพเคลื่อนไหว" = Master, then the sprite sheet right away (one cost question for both)
async function makeAll() {
  const a = aiSet();
  if (!confirm(`สร้างภาพเคลื่อนไหว: ภาพ Master แล้วต่อด้วย sprite sheet (${a.sheetSize}, ${a.quality})\nค่าใช้จ่ายโดยประมาณ: Master $0.2-0.3 + sheet ${SHEET_COST[a.sheetSize] || '$0.4-0.8'}\nใช้เวลารวม 2-4 นาที เปิดหน้าจอค้างไว้\n\nทำต่อไหม?`)) return;
  if (await makeMaster(true)) await makeSheet(true);
}
$('goMaster').onclick = () => makeAll();
$('reMaster').onclick = () => makeMaster(false);

// ---------- step 2 -> sheet -> cut ----------
const SHEET_COST = { '1024x1536': '$0.4-0.8', '1440x2160': '$0.8-1.6', '2048x2560': '$1.5-3' };
async function makeSheet(chained = false) {
  const a = aiSet();
  if (!chained && !confirm(`สร้าง sprite sheet (${a.sheetSize}, ${a.quality})\nค่าใช้จ่ายโดยประมาณ ${SHEET_COST[a.sheetSize] || '$0.4-0.8'} ต่อครั้ง\nใช้เวลา 1-3 นาที เปิดหน้าจอค้างไว้\n\nทำต่อไหม?`)) return;
  await busy((chained ? 'ขั้นที่ 2/2: ' : '') + 'กำลังสร้าง sprite sheet (อาจใช้ 1-3 นาที)…', async (signal) => {
    if (!S.master) throw new AppError('ยังไม่มีภาพ Master');
    budget('sheet');
    const t = (x, d) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : d), f = fields();
    const prompt = fill(SH.PROMPTS.sheet, { FOOD: t(f.food, 'a small fish'), EAT: 'eating happily', TOY: t(f.toy, 'a ball of yarn'), SKILL: t(f.skill, 'a proud spinning victory pose'),
      PERSONALITY: SH.personaLine(f.persona, true), BG: BG[S.bg].hex, BGNAME: BG[S.bg].name });
    const r = await editImage({ images: [S.master], prompt, size: a.sheetSize }, signal);
    spend('sheet', r.cost);
    S.sheet = r.png;
    $('busyText').textContent = 'กำลังตัดเป็นท่า…';
    await new Promise((ok) => setTimeout(ok, 30));
    await cutSheetNow(r.cost);
  }, { long: true });
}
async function cutSheetNow(cost) {
  $('sheetImg').src = urlOf(S.sheet);
  const lines = []; if (cost != null && cost > 0) lines.push(`ค่าใช้จ่าย sheet นี้ ${money(cost)}`);
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
  $('selCount').classList.toggle('ok', selected.size > 0); $('editGo').disabled = !selected.size;
}
$('selNone').onclick = () => { selected.clear(); renderGallery(); };
$('editGo').onclick = async () => {
  const text = $('editText').value.trim().slice(0, 600), keys = [...selected];
  if (!text) { $('editText').focus(); return showErr(new AppError('พิมพ์อธิบายว่าจะแก้อะไร')); }
  if (keys.length > MAX_EDIT) return showErr(new AppError(`แก้ได้ครั้งละไม่เกิน ${MAX_EDIT} ภาพ`));
  if (!confirm(`แก้ ${keys.length} ภาพ ส่งไป OpenAI ${keys.length} คำขอ\nทำต่อไหม?`)) return;
  await busy(`กำลังแก้ ${keys.length} ภาพ (ภาพละประมาณ 20-60 วินาที)…`, async (signal) => {
    let ok = 0, failure = null;
    for (const k of keys) {
      try {
        budget('edit');
        const images = [await poseOnBackground(S.cut[k].png)]; if (S.master) images.push(S.master);
        const prompt = fill(SH.PROMPTS.edit, { POSE: k, CHANGE: text, BG: BG[S.bg].hex, BGNAME: BG[S.bg].name });
        const r = await editImage({ images, prompt, size: EDIT_SIZE + 'x' + EDIT_SIZE }, signal);
        spend('edit', r.cost);
        const ref = await bgraOfBlob((S.orig[k] || S.cut[k]).png), bm = CUT.cutOne(await bgraOfBlob(r.png), ref);
        if (!S.orig[k]) S.orig[k] = S.cut[k];
        S.cut[k] = { png: await pngOfBgra(bm), w: bm.w, h: bm.h }; selected.delete(k); ok++;
      } catch (e) {
        failure = new AppError(`แก้ ${k} ไม่สำเร็จ: ${e.message}`, e.kind, e.detail);
        if (['cancel', 'cap', 'auth-openai', 'quota', 'nokey'].includes(e.kind)) break;
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
  if (!confirm(`ส่ง ${name} ขึ้นออนไลน์? (${Object.keys(S.cut).length} ท่า) เพื่อนของคุณจะเห็น และนับในน้องออนไลน์ของคุณ (สูงสุด 7 ตัว)`)) return;
  await busy('กำลังส่งขึ้นออนไลน์…', async () => {
    const keys = Object.keys(S.cut).sort();
    const reg = await rpc('pet_register', { p_name: name, p_files: keys, p_tweaks: { hand: 'auto', face: 'auto', scale: null }, p_hash: await sha256hex(S.cut.idle_01.png) });
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
  $('secDone').hidden = true; hideFrom(2); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
};

S = newSession();
render();
window.__mobile = { get S() { return S; }, store };       // tests
