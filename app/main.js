// إدارة التسهيلات البنكية — العملية الرئيسية (Electron)
// البيانات تُحفظ في ملف JSON واحد داخل مجلد يختاره المستخدم (يمكن أن يكون مجلداً مشتركاً على الشبكة).
// كل عملية حفظ تعيد قراءة الملف من القرص ثم تطبق التغيير على السجل المعني فقط،
// حتى لا يمسح مستخدم تعديلات مستخدم آخر يعمل على نفس المجلد.
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, net, safeStorage } = require('electron');
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
    out[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const attr = (s, a) => { const m = s.match(new RegExp('(?:^|\\s)' + a + '="([^"]*)"')); return m ? unxml(m[1]) : null; };
function colIndex(ref) { const l = ref.match(/^[A-Z]+/)[0]; let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; }
function readXlsx(file) {
  const z = unzipEntries(fs.readFileSync(file));
  const get = n => z[n] ? z[n]().toString('utf8') : '';
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

ipcMain.handle('print:pdf', ok(async (_e, name, landscape) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return false;
  const buf = await win.webContents.printToPDF({
    pageSize: 'A4', landscape: !!landscape, printBackground: true,
    margins: { top: 0.4, bottom: 0.5, left: 0.4, right: 0.4 },
    displayHeaderFooter: true, headerTemplate: '<div></div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;font-family:Tahoma;color:#555"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  fs.writeFileSync(r.filePath, buf); shell.openPath(r.filePath); return true;
}));
ipcMain.handle('print:direct', ok((_e, landscape) => new Promise((res, rej) => {
  win.webContents.print({ printBackground: true, landscape: !!landscape }, (done, why) => (done || /cancel/i.test(why || '')) ? res(done) : rej(new Error(why)));
})));

// ---------- كتابة ملف Excel (xlsx) بدون مكتبات خارجية ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipFiles(files) {
  const parts = [], cents = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.from(f.data, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cents.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cents), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const xesc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
// sheets: [{name, rows:[[...]], totalRows:[index...]}]; الصف الأول عناوين
function buildXlsx(sheets) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>`
    + `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
    + `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E6B5B"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3F1ED"/></patternFill></fill></fills>`
    + `<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="9">`
    + `<xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`
    + `<xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="3" applyNumberFormat="1"/>`
    + `<xf fontId="2" fillId="3" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="2" fillId="3" applyNumberFormat="1" applyFont="1" applyFill="1"/><xf numFmtId="165" fontId="2" fillId="3" applyNumberFormat="1" applyFont="1" applyFill="1"/><xf numFmtId="3" fontId="2" fillId="3" applyNumberFormat="1" applyFont="1" applyFill="1"/>`
    + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const files = [], used = new Set();
  const names = sheets.map((sh, i) => { let n = String(sh.name || ('Sheet' + (i + 1))).replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31) || 'Sheet'; while (used.has(n)) n = n.slice(0, 28) + '_' + i; used.add(n); return n; });
  sheets.forEach((sh, si) => {
    const rows = sh.rows || [], tot = new Set(sh.totalRows || []), ints = new Set(sh.intCols || []), ncol = Math.max(1, ...rows.map(r => r.length));
    const width = Array.from({ length: ncol }, (_, c) => Math.min(60, Math.max(8, ...rows.map(r => { const v = r[c]; return v == null ? 0 : (typeof v === 'number' ? 14 : String(v).length + 2); }))));
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="${R}"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
    x += `<cols>${width.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>`;
    rows.forEach((r, ri) => {
      const t = tot.has(ri), head = ri === 0;
      x += `<row r="${ri + 1}"${head ? ' ht="30" customHeight="1"' : ''}>`;
      r.forEach((v, ci) => {
        if (v == null || v === '') return; const ref = colName(ci) + (ri + 1);
        if (head) { x += `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`; return; }
        if (typeof v === 'number' && isFinite(v)) { x += `<c r="${ref}" s="${ints.has(ci) ? (t ? 8 : 4) : (t ? 6 : 2)}"><v>${v}</v></c>`; return; }
        const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) { x += `<c r="${ref}" s="${t ? 7 : 3}"><v>${Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 + 25569}</v></c>`; return; }
        x += `<c r="${ref}"${t ? ' s="5"' : ''} t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
      });
      x += `</row>`;
    });
    x += `</sheetData>`;
    if (rows.length > 1) x += `<autoFilter ref="A1:${colName(ncol - 1)}${rows.length}"/>`;
    x += `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: x });
  });
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.map((sh, i) => (sh.rows || []).length > 1 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xesc(names[i]).replace(/'/g, "''")}'!$A$1:$${colName(Math.max(1, ...(sh.rows.map(r => r.length))) - 1)}$${sh.rows.length}</definedName></definedNames>` : '').join('').replace(/<\/definedNames><definedNames>/g, '')}</workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: styles });
  return zipFiles(files);
}
ipcMain.handle('file:xlsx', ok(async (_e, name, sheets) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, buildXlsx(sheets));
  shell.openPath(r.filePath); return true;
}));

// ---------- التحديثات من GitHub ----------
const UPDATE_REPO = 'gamalelsayed-hub/bank-facilities';
// مستودع عام فيه ملفات التنزيل فقط (بدون كود): لا يحتاج رمز وصول
const RELEASES_REPO = 'gamalelsayed-hub/bank-facilities-releases';
const GH_API = process.env.FAC_UPDATE_API || 'https://api.github.com';
const verParts = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
function cmpVer(a, b) { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; } return 0; }
const repoOf = () => (cfg.updateRepo || UPDATE_REPO).trim();
function getToken() {
  if (cfg.updateTokenEnc) { try { return safeStorage.decryptString(Buffer.from(cfg.updateTokenEnc, 'base64')); } catch { return null; } }
  return cfg.updateToken || null;
}
function setToken(t) {
  delete cfg.updateToken; delete cfg.updateTokenEnc; if (!t) return;
  if (safeStorage.isEncryptionAvailable()) cfg.updateTokenEnc = safeStorage.encryptString(t).toString('base64'); else cfg.updateToken = t;
}
function ghHeaders(accept) { const h = { 'Accept': accept || 'application/vnd.github+json', 'User-Agent': 'bank-facilities-app', 'X-GitHub-Api-Version': '2022-11-28' }; const tk = getToken(); if (tk) h.Authorization = 'Bearer ' + tk; return h; }
ipcMain.handle('update:getCfg', ok(() => ({ repo: repoOf(), hasToken: !!getToken(), auto: cfg.updateAuto !== false, version: app.getVersion() })));
ipcMain.handle('update:setCfg', ok((_e, c) => {
  if ('repo' in c) cfg.updateRepo = (c.repo || '').trim() || undefined;
  if ('token' in c) setToken((c.token || '').trim());
  if ('auto' in c) cfg.updateAuto = !!c.auto;
  saveCfg(); return true;
}));
async function fetchReleases(repo, auth) {
  const h = ghHeaders(); if (!auth) delete h.Authorization;
  let r;
  try { r = await net.fetch(`${GH_API}/repos/${repo}/releases?per_page=30`, { headers: h }); }
  catch (e) { throw new Error('تعذّر الاتصال بـ GitHub. تأكد من الإنترنت.'); }
  if (r.status === 404) return null;
  if (r.status === 401) throw new Error('رمز وصول GitHub غير صالح أو منتهي.');
  if (r.status === 403) throw new Error('رفض GitHub الطلب (حد الطلبات أو صلاحية الرمز). حاول لاحقاً.');
  if (!r.ok) throw new Error('رد GitHub غير متوقع: ' + r.status);
  const list = await r.json();
  return list.filter(x => !x.draft && !x.prerelease && /^v?\d+\.\d+\.\d+$/.test(x.tag_name)).sort((a, b) => cmpVer(b.tag_name, a.tag_name))[0] || false;
}
ipcMain.handle('update:check', ok(async () => {
  // أولاً مستودع التنزيلات العام، ثم مستودع الكود (يحتاج رمزاً إذا كان خاصاً)
  let rel = null, source = 'public';
  const pub = await fetchReleases(RELEASES_REPO, false);
  let priv = null;
  try { priv = await fetchReleases(repoOf(), true); } catch (e) { if (!pub) throw e; }
  if (pub && (!priv || cmpVer(pub.tag_name, priv.tag_name) >= 0)) rel = pub;
  else if (priv) { rel = priv; source = 'private'; }
  if (pub === null && priv === null) throw new Error(getToken() ? 'لم أجد المستودع. تأكد من اسمه ومن أن رمز الوصول يملك صلاحية عليه.' : 'لم أجد مستودع التحديثات. إذا كان مستودع الكود خاصاً ولم يُنشأ مستودع التنزيلات العام، أضف رمز وصول من الإعدادات ← التحديثات.');
  if (!rel) return { current: app.getVersion(), latest: null };
  const asset = (rel.assets || []).find(a => /\.zip$/i.test(a.name));
  return { current: app.getVersion(), latest: rel.tag_name.replace(/^v/i, ''), newer: cmpVer(rel.tag_name, app.getVersion()) > 0, notes: rel.body || '', date: rel.published_at, source,
    asset: asset ? { id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url } : null, page: rel.html_url };
}));
function extractZip(zipBuf, dest) {
  const z = unzipEntries(zipBuf);
  for (const name of Object.keys(z)) {
    if (name.includes('..') || path.isAbsolute(name)) continue;
    const target = path.join(dest, name);
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, z[name]());
  }
}
function writable(dir) { const t = path.join(dir, '.write-test-' + process.pid); try { fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true; } catch { return false; } }
ipcMain.handle('update:install', ok(async (_e, info) => {
  if (!info || !info.asset) throw new Error('لا يوجد ملف تحديث في هذا الإصدار.');
  const usePriv = info.source === 'private' && getToken();
  const url = usePriv ? `${GH_API}/repos/${repoOf()}/releases/assets/${info.asset.id}` : info.asset.url;
  const hh = ghHeaders('application/octet-stream'); if (!usePriv) delete hh.Authorization;
  const r = await net.fetch(url, { headers: hh });
  if (!r.ok) throw new Error('فشل تنزيل التحديث: ' + r.status);
  const total = +r.headers.get('content-length') || info.asset.size || 0; const reader = r.body.getReader(); const chunks = []; let got = 0, lastSent = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); got += value.length;
    if (got - lastSent > 1 << 20) { lastSent = got; win?.webContents.send('update:progress', { got, total }); } }
  win?.webContents.send('update:progress', { got, total, extracting: true });
  const tmp = path.join(app.getPath('temp'), 'bank-facilities-update-' + Date.now());
  const ext = path.join(tmp, 'x'); fs.mkdirSync(ext, { recursive: true });
  extractZip(Buffer.concat(chunks), ext);
  const exeName = path.basename(process.execPath);
  let src = ext; const sub = fs.readdirSync(ext).find(n => fs.existsSync(path.join(ext, n, 'resources', 'app', 'main.js')));
  if (sub) src = path.join(ext, sub);
  if (!fs.existsSync(path.join(src, 'resources', 'app', 'main.js'))) throw new Error('ملف التحديث لا يحتوي نسخة صالحة من البرنامج.');
  const srcExe = fs.readdirSync(src).find(n => /\.exe$/i.test(n)) || exeName;
  const dst = path.dirname(process.execPath);
  if (process.platform !== 'win32' || !app.isPackaged) return { restart: false, staged: src };
  if (srcExe !== exeName) fs.renameSync(path.join(src, srcExe), path.join(src, exeName));
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const ps = `$ErrorActionPreference='Stop'
$p=${process.pid}
while(Get-Process -Id $p -ErrorAction SilentlyContinue){Start-Sleep -Milliseconds 400}
Start-Sleep -Milliseconds 600
$ok=$false
for($i=0;$i -lt 20 -and -not $ok;$i++){try{Copy-Item -Path (Join-Path ${q(src)} '*') -Destination ${q(dst)} -Recurse -Force;$ok=$true}catch{Start-Sleep -Milliseconds 700}}
Start-Process -FilePath 'explorer.exe' -ArgumentList ('"'+(Join-Path ${q(dst)} ${q(exeName)})+'"')
Start-Sleep -Seconds 2
Remove-Item -Recurse -Force ${q(tmp)} -ErrorAction SilentlyContinue`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const { spawn } = require('child_process');
  if (writable(dst)) {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    // مجلد البرنامج يحتاج صلاحية مسؤول (مثل Program Files): يظهر طلب موافقة ويندوز مرة واحدة
    const outer = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${enc}'`;
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  setTimeout(() => app.quit(), 1500);
  return { restart: true, admin: !writable(dst) };
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
