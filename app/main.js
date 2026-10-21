// إدارة التسهيلات البنكية — العملية الرئيسية (Electron)
// البيانات تُحفظ في ملف JSON واحد داخل مجلد يختاره المستخدم (يمكن أن يكون مجلداً مشتركاً على الشبكة).
// كل عملية حفظ تعيد قراءة الملف من القرص ثم تطبق التغيير على السجل المعني فقط،
// حتى لا يمسح مستخدم تعديلات مستخدم آخر يعمل على نفس المجلد.
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const DATA_NAME = 'facilities-data.json';
const CFG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let cfg = {};
let win = null;
let lastWriteMtime = 0;
let watching = null;

function loadCfg() {
  cfg = { dataDir: path.join(app.getPath('documents'), 'إدارة التسهيلات البنكية') };
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8'))); } catch {}
}
function saveCfg() {
  fs.mkdirSync(path.dirname(CFG_FILE()), { recursive: true });
  fs.writeFileSync(CFG_FILE(), JSON.stringify(cfg, null, 2));
}
const dataFile = () => path.join(cfg.dataDir, DATA_NAME);
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

function emptyData() {
  return { version: 2, loans: {}, banks: {}, settings: {} };
}
function readData() {
  const f = dataFile();
  if (!fs.existsSync(f)) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const fresh = emptyData();
    writeData(fresh);
    return fresh;
  }
  const txt = fs.readFileSync(f, 'utf8');
  const d = JSON.parse(txt);
  d.loans ||= {}; d.banks ||= {}; d.settings ||= {};
  return d;
}
function writeData(d) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const f = dataFile();
  const tmp = f + '.tmp-' + process.pid + '-' + Date.now();
  d.savedAt = new Date().toISOString();
  d.savedBy = userName();
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, f);
  try { lastWriteMtime = fs.statSync(f).mtimeMs; } catch {}
}
function backup() {
  try {
    const f = dataFile(); if (!fs.existsSync(f)) return;
    const dir = path.join(cfg.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'facilities-' + today() + '.json');
    if (!fs.existsSync(target)) fs.copyFileSync(f, target);
    const files = fs.readdirSync(dir).filter(n => /^facilities-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    while (files.length > 60) fs.unlinkSync(path.join(dir, files.shift()));
  } catch {}
}
function userName() { try { return os.userInfo().username; } catch { return 'user'; } }

function watch() {
  if (watching) fs.unwatchFile(watching);
  watching = dataFile();
  fs.watchFile(watching, { interval: 3000 }, (cur) => {
    if (!cur.mtimeMs || Math.abs(cur.mtimeMs - lastWriteMtime) < 1) return;
    lastWriteMtime = cur.mtimeMs;
    try { win?.webContents.send('data:changed', readData()); } catch {}
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600,
    title: 'إدارة التسهيلات البنكية',
    backgroundColor: '#F3F6F5',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function ok(fn) {
  return async (...a) => { try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } };
}

ipcMain.handle('data:load', ok(() => ({ data: readData(), dataDir: cfg.dataDir, user: userName(), version: app.getVersion(), loginItem: app.getLoginItemSettings().openAtLogin })));
ipcMain.handle('data:batch', ok((_e, ops) => {
  const d = readData();
  for (const op of ops) {
    if (op.col === 'settings') { d.settings = op.doc; continue; }
    d[op.col] ||= {};
    if (op.del) delete d[op.col][op.id]; else d[op.col][op.id] = op.doc;
  }
  writeData(d);
  return d;
}));
ipcMain.handle('file:save', ok(async (_e, name, content) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, content, 'utf8');
  shell.showItemInFolder(r.filePath);
  return true;
}));
ipcMain.handle('dir:choose', ok(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'اختر مجلد حفظ البيانات', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  const target = path.join(dir, DATA_NAME);
  if (!fs.existsSync(target)) {
    const m = await dialog.showMessageBox(win, { type: 'question', buttons: ['نقل البيانات الحالية', 'إلغاء'], defaultId: 0, cancelId: 1,
      message: 'المجلد لا يحتوي بيانات.', detail: 'سيتم نسخ البيانات الحالية إلى المجلد الجديد واستخدامه من الآن.' });
    if (m.response !== 0) return null;
    fs.copyFileSync(dataFile(), target);
  } else {
    const m = await dialog.showMessageBox(win, { type: 'question', buttons: ['استخدام بيانات المجلد', 'إلغاء'], defaultId: 0, cancelId: 1,
      message: 'المجلد يحتوي ملف بيانات بالفعل.', detail: 'سيعمل البرنامج على البيانات الموجودة في هذا المجلد (مثلاً مجلد مشترك مع المحاسب). بياناتك الحالية تبقى في المجلد القديم.' });
    if (m.response !== 0) return null;
  }
  backup();
  cfg.dataDir = dir; saveCfg(); watch(); backup();
  return { data: readData(), dataDir: cfg.dataDir };
}));
ipcMain.handle('dir:open', ok(() => shell.openPath(cfg.dataDir)));
ipcMain.handle('backup:export', ok(async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), 'نسخة-التسهيلات-' + today() + '.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.copyFileSync(dataFile(), r.filePath); return true;
}));
ipcMain.handle('backup:import', ok(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'اختر ملف النسخة الاحتياطية', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const d = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  if (!d || typeof d.loans !== 'object' || typeof d.banks !== 'object') throw new Error('الملف ليس نسخة احتياطية صالحة من البرنامج');
  const m = await dialog.showMessageBox(win, { type: 'warning', buttons: ['استبدال البيانات', 'إلغاء'], defaultId: 1, cancelId: 1,
    message: 'استبدال كل البيانات الحالية بالنسخة المختارة؟', detail: 'تُحفظ نسخة من البيانات الحالية في مجلد backups قبل الاستبدال.' });
  if (m.response !== 0) return null;
  const dir = path.join(cfg.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(dataFile(), path.join(dir, 'before-import-' + Date.now() + '.json'));
  writeData(d); return readData();
}));
ipcMain.handle('app:loginItem', ok((_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return app.getLoginItemSettings().openAtLogin; }));
// ---------- قراءة ملف Excel (xlsx) بدون مكتبات خارجية ----------
function unzipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('الملف ليس ملف Excel (xlsx) صالحاً');
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = {};
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28), start = off + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    out[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const attr = (s, a) => { const m = s.match(new RegExp('(?:^|\\s)' + a + '="([^"]*)"')); return m ? unxml(m[1]) : null; };
function colIndex(ref) { const l = ref.match(/^[A-Z]+/)[0]; let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; }
function readXlsx(file) {
  const z = unzipEntries(fs.readFileSync(file));
  const get = n => z[n] ? z[n]() : '';
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => unxml(t[1])).join(''));
  const rels = {}; for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) rels[attr(m[1], 'Id')] = attr(m[1], 'Target');
  const sheets = {};
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name'), rid = attr(m[1], 'r:id'); let t = rels[rid] || ''; t = t.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = get('xl/' + t); const rows = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r'); if (!ref) continue; const type = attr(c[1], 't'), body = c[2] || '';
      const r = +ref.match(/\d+/)[0] - 1, ci = colIndex(ref); let v = null;
      const vm = body.match(/<v>([\s\S]*?)<\/v>/);
      if (type === 's') v = vm ? shared[+vm[1]] : null;
      else if (type === 'inlineStr') v = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => unxml(t[1])).join('');
      else if (type === 'str' || type === 'e') v = vm ? unxml(vm[1]) : null;
      else if (type === 'b') v = vm ? vm[1] === '1' : null;
      else v = vm ? +vm[1] : null;
      (rows[r] ||= [])[ci] = v;
    }
    sheets[name] = Array.from(rows, x => x ? Array.from(x, y => y ?? null) : []);
  }
  return sheets;
}
ipcMain.handle('xlsx:import', ok(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'اختر ملف Excel للاستيراد', filters: [{ name: 'Excel', extensions: ['xlsx'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { file: path.basename(r.filePaths[0]), sheets: readXlsx(r.filePaths[0]) };
}));
ipcMain.handle('xlsx:template', ok(async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), 'نموذج-استيراد-التسهيلات.xlsx'), filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.copyFileSync(path.join(__dirname, 'template.xlsx'), r.filePath); shell.showItemInFolder(r.filePath); return true;
}));

ipcMain.handle('app:notify', ok((_e, title, body) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body }); n.on('click', () => { win?.show(); win?.focus(); }); n.show(); return true;
}));

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('sa.facilities.manager');
    Menu.setApplicationMenu(null);
    loadCfg();
    try { readData(); } catch (e) { dialog.showErrorBox('تعذّر فتح ملف البيانات', String(e.message || e) + '\n' + dataFile()); }
    backup(); watch(); createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
