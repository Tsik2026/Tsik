/* ============================================================
   «Ведомость Сбербанк» · Комиссия.Финансы — Норильск
   Реестр для импорта в Сбер Бизнес Онлайн (юрлица), формат «Ведомость на счета»
   Автономный модуль: монтируется из App через ref на div
   ============================================================ */
import * as XLSX from "./xlsx-CNerDvZX.js";

const HEADER = ["Счет (20 знаков)","Фамилия","Имя","Отчество","Сумма (разделитель - точка)","Сумма произведенных удержаний (разделитель - точка)"];
const FIELDS = [
  {key:"account", label:"Счёт получателя (20 цифр)"},
  {key:"fio",     label:"ФИО одной строкой"},
  {key:"last",    label:"Фамилия"},
  {key:"first",   label:"Имя"},
  {key:"middle",  label:"Отчество"},
  {key:"role",    label:"Должность (необязательно)"},
  {key:"amount",  label:"Сумма"},
  {key:"deduct",  label:"Удержания (необязательно)"},
];
const RULES = [
  ["last",    /фамили/i],
  ["middle",  /отчеств/i],
  ["first",   /(^|[^а-яa-z])имя([^а-яa-z]|$)/i],
  ["fio",     /фио|получател|сотрудник|работник|член|наименование/i],
  ["account", /сч[её]т|account/i],
  ["role",    /председат|замест|секретарь|должност/i],
  ["deduct",  /удерж|ндфл/i],
  ["amount",  /сумма|выплат|начисл|итог|вознагражд|к\s*оплат/i],
];

const S = { headers: [], matrix: [], mapping: {}, rows: [], fileName: "", appliedSum: 0 };
let root = null;

/* ---------- Windows-1251 ---------- */
const CP = (() => {
  const t = {};
  for (let i = 0; i < 64; i++) { t[0x410 + i] = 0xC0 + i; t[0x430 + i] = 0xE0 + i; }
  const s = {0x401:0xA8,0x451:0xB8,0x2116:0xB9,0xA0:0xA0,0x2013:0x96,0x2014:0x97,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2026:0x85,0x2022:0x95,0xAB:0xAB,0xBB:0xBB};
  for (const k in s) t[k] = s[k];
  return t;
})();
function enc1251(str){
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++){
    const c = str.charCodeAt(i);
    out[i] = c < 128 ? c : (CP[c] !== undefined ? CP[c] : 0x3F);
  }
  return out;
}

/* ---------- нормализация ---------- */
const digits = v => String(v ?? "").replace(/\D/g, "");
function normAmount(v){
  if (typeof v === "number" && isFinite(v)) return v.toFixed(2);
  const s = String(v ?? "").replace(/[\s\u00A0\u202F]/g, "").replace(/руб.*$/i, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n.toFixed(2) : "";
}
function splitFio(fio){
  const p = String(fio ?? "").trim().split(/\s+/).filter(Boolean);
  return { last: p[0] || "", first: p[1] || "", middle: p.slice(2).join(" ") };
}
const RATES = { chair: 63, deputy: 57, secretary: 57, member: 45 };
function mapRole(v){
  const s = String(v || "").toLowerCase();
  if (/председат/.test(s)) return "chair";
  if (/замест/.test(s)) return "deputy";
  if (/секретар/.test(s)) return "secretary";
  return "member";
}
const normFio = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
function collectMembers(){
  if (!S.matrix.length) return [];
  const get = (row, key) => { const i = S.mapping[key]; return (i == null || i < 0) ? "" : row[i]; };
  const out = [];
  for (const row of S.matrix){
    let fio = "";
    if (S.mapping.fio != null && S.mapping.fio >= 0) fio = String(get(row, "fio")).trim();
    else fio = [get(row, "last"), get(row, "first"), get(row, "middle")].map(x => String(x).trim()).filter(Boolean).join(" ");
    if (fio) out.push({ fio, role: mapRole(get(row, "role")) });
  }
  return out;
}
async function updateCommissionMembers(commId, mem){
  const db = window.__db;
  if (!mem.length) throw new Error("не удалось собрать ФИО из файла — проверьте сопоставление колонок");
  const incoming = new Map();
  mem.forEach(m => incoming.set(normFio(m.fio), m.role));
  return db.transaction("rw", db.members, async () => {
    const existing = await db.members.where("commissionId").equals(commId).toArray();
    let upgraded = 0, deleted = 0, updated = 0, added = 0;
    for (const m of existing){
      const key = normFio(m.fio);
      if (m.source === "demo"){
        if (incoming.has(key)){ await db.members.update(m.id, { source: "official", role: incoming.get(key) }); upgraded++; }
        else { await db.members.delete(m.id); deleted++; }
      } else if (incoming.has(key) && m.role !== incoming.get(key)){
        await db.members.update(m.id, { role: incoming.get(key) }); updated++;
      }
    }
    const have = new Set(existing.map(m => normFio(m.fio)));
    const fresh = mem.filter(m => !have.has(normFio(m.fio)))
      .map(m => ({ commissionId: commId, fio: m.fio, role: m.role, status: "нештатный", rate: RATES[m.role] || 45, source: "official" }));
    if (fresh.length) await db.members.bulkAdd(fresh);
    added = fresh.length;
    return { total: mem.length, added, upgraded, deleted, updated };
  });
}
/* ---------- защита счетов от экспоненциальной записи (4,08E+19) ---------- */
function expandNumber(n){
  try { return n.toLocaleString("fullwide", { useGrouping: false }); }
  catch(e){
    let s = String(n);
    if (/e/i.test(s)){
      const parts = s.split(/e/i);
      const a = parts[0].replace(".", "");
      const p = +parts[1] - (parts[0].includes(".") ? parts[0].split(".")[1].length : 0);
      s = a + "0".repeat(Math.max(p, 0));
    }
    return s;
  }
}
function cellFix(v){
  if (typeof v === "number" && isFinite(v) && Math.abs(v) >= 1e15)
    return { v: expandNumber(v), fixed: true, sci: true };
  const m = String(v ?? "").trim().match(/^(\d{1,3}(?:[.,]\d+)?)\s*[eE]\s*\+?\s*(\d{1,3})$/);
  if (m){
    const n = Number(m[1].replace(",", ".")) * Math.pow(10, +m[2]);
    if (isFinite(n)) return { v: expandNumber(n), fixed: true, sci: true };
  }
  return { v, fixed: false, sci: false };
}
function matrixCellFix(matrix){
  let fixed = 0;
  const out = matrix.map(row => row.map(c => {
    const f = cellFix(c === undefined || c === null ? "" : c);
    if (f.fixed) fixed++;
    return f.v;
  }));
  return { matrix: out, fixed };
}
function fixAccounts(rows){
  let fixed = 0, sci = 0;
  const out = rows.map(r => {
    const acc = String(r.account ?? "");
    if (!/^\d{20}$/.test(acc)){
      const f = cellFix(acc);
      if (f.fixed){
        const digitsOnly = String(f.v).replace(/\D/g, "");
        if (digitsOnly !== acc){ fixed++; if (f.sci) sci++; return { ...r, account: digitsOnly, __sci: true }; }
      }
    }
    return r;
  });
  return { rows: out, fixed, sci };
}

/* ---------- умное распознавание: контент-анализ + заголовки ---------- */
function colEvidence(rows, i, tests){
  let acc = 0, amt = 0, fio = 0, uik = 0;
  for (let r = 0; r < tests; r++){
    const v = String(rows[r] ? rows[r][i] ?? "" : "").trim();
    if (!v) continue;
    const d = v.replace(/\D/g, "");
    if (d.length === 20) acc++;
    if (/^\d{1,9}([.,]\d{1,2})?$/.test(v.replace(/[\s\u00A0]/g, "").replace(",", "."))) amt++;
    if (/^[А-ЯЁ][а-яё]+(\s+[А-ЯЁ][а-яё]+)+/.test(v)) fio++;
    if (/^(уик\s*)?№?\s*\d{1,4}$/i.test(v)) uik++;
  }
  const n = Math.max(tests, 1);
  return { acc: acc / n, amt: amt / n, fio: fio / n, uik: uik / n };
}
function smartMapping(headers, rows){
  const tests = Math.min(rows ? rows.length : 0, 30);
  const ev = headers.map((_, i) => colEvidence(rows || [], i, tests));
  const used = new Set();
  const mapping = {}; const conf = {};
  function pick(key, metric, re, minContent){
    let best = -1, bs = 0;
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const hs = re.test(String(h)) ? 0.6 : 0;
      const s = ev[i][metric] * 0.8 + hs;
      if (s > bs){ bs = s; best = i; }
    });
    if (best >= 0 && (ev[best][metric] >= minContent || re.test(String(headers[best])))){
      mapping[key] = best; used.add(best); conf[key] = Math.round(ev[best][metric] * 100);
    }
  }
  pick("account", "acc", /сч[её]т|account/i, 0.5);
  pick("amount", "amt", /сумма|выплат|начисл|итог|вознагражд|к\s*оплат/i, 0.5);
  pick("fio", "fio", /фио|получател|сотрудник|работник|член|наименование/i, 0.4);
  if (mapping.fio == null){
    // раздельные ФИО — по заголовкам
    for (const [key, re] of [["last", /фамили/i], ["first", /(^|[^а-яa-z])имя([^а-яa-z]|$)/i], ["middle", /отчеств/i]]){
      const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h)));
      if (i >= 0){ mapping[key] = i; used.add(i); }
    }
  }
  for (const [key, re] of [["role", /председат|замест|секретарь|должност/i], ["deduct", /удерж|ндфл/i]]){
    const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h)));
    if (i >= 0){ mapping[key] = i; used.add(i); }
  }
  const vals = Object.keys(conf).map(k => conf[k]);
  const confidence = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  return { mapping, confidence };
}
const MAPMEM_KEY = "sbv_mapmem_v1";
function mapMemoryGet(name){
  try{
    const m = JSON.parse(localStorage.getItem(MAPMEM_KEY) || "{}");
    return m[String(name || "").toLowerCase().replace(/\.[^.]+$/, "")] || null;
  }catch(e){ return null; }
}
function mapMemoryPut(name, mapping){
  try{
    const m = JSON.parse(localStorage.getItem(MAPMEM_KEY) || "{}");
    m[String(name || "").toLowerCase().replace(/\.[^.]+$/, "")] = mapping;
    localStorage.setItem(MAPMEM_KEY, JSON.stringify(m));
  }catch(e){}
}
function normFioCase(fio){
  return String(fio || "").split(/\s+/).map(w => {
    if (!w) return w;
    if (w === w.toLowerCase() || w === w.toUpperCase()) return w[0].toUpperCase() + w.slice(1).toLowerCase();
    return w;
  }).join(" ");
}
function filterSmartRows(matrix){
  const out = []; let totalRow = null;
  for (const row of matrix){
    const nonEmpty = row.filter(c => String(c ?? "").trim() !== "");
    if (!nonEmpty.length) continue;
    const first = String(row[0] ?? "").trim();
    if (/^(итог|всего|сумма|общая|результат)/i.test(first) && nonEmpty.length <= 3){
      for (const c of nonEmpty){ const n = parseFloat(String(c).replace(/[\s\u00A0]/g, "").replace(",", ".")); if (isFinite(n) && n > 0) totalRow = n; }
      continue;
    }
    if (nonEmpty.length === 1 && row.length > 1) continue; // мусорные строки
    out.push(row);
  }
  return { rows: out, totalRow };
}

function guessMapping(headers){
  const used = new Set(), mapping = {};
  for (const [key, re] of RULES){
    const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h)));
    if (i >= 0){ mapping[key] = i; used.add(i); }
  }
  return mapping;
}

/* ---------- вспомогательное ---------- */
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function stamp(){ const d = new Date(), p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
function download(name, data, mime){
  const blob = data instanceof Blob ? data : new Blob([data], {type: mime});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
function rowProblems(r){
  const p = [];
  if (!/^\d{20}$/.test(r.account)) p.push("счёт");
  if (!r.last) p.push("фамилия");
  const n = parseFloat(r.amount);
  if (!isFinite(n) || n <= 0) p.push("сумма");
  return p;
}
function totals(){
  let sum = 0, cnt = 0, bad = 0;
  for (const r of S.rows){
    const n = parseFloat(r.amount);
    if (isFinite(n) && n > 0){ sum += n; cnt++; }
    if (rowProblems(r).length) bad++;
  }
  return { sum, cnt, bad };
}

/* ---------- шаблон ---------- */
const CSS = `
.sbv{font-size:14px;line-height:1.45}
.sbv h2{font-size:17px;font-weight:700;margin:0 0 2px}
.sbv .sbv-sub{opacity:.65;font-size:12.5px;margin-bottom:12px}
.sbv .card{border:1px solid rgba(128,140,170,.28);border-radius:12px;padding:14px;margin-bottom:12px;background:rgba(128,140,170,.06)}
.sbv .card h3{font-size:14px;font-weight:700;margin:0 0 10px}
.sbv .num{display:inline-flex;width:22px;height:22px;border-radius:50%;background:#2f6fed;color:#fff;align-items:center;justify-content:center;font-size:12px;margin-right:8px;vertical-align:-6px}
.sbv button{cursor:pointer;border:0;border-radius:9px;padding:9px 14px;font-size:13.5px;font-weight:600;background:#2f6fed;color:#fff}
.sbv button.ghost{background:rgba(128,140,170,.18);color:inherit}
.sbv button:disabled{opacity:.45;cursor:not-allowed}
.sbv button.warnb{background:#b3261e}
.sbv .btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.sbv .maprow{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin:6px 0}
.sbv .maprow label{font-size:12.5px;opacity:.85;display:block;margin-bottom:3px}
.sbv select,.sbv input[type=text]{width:100%;box-sizing:border-box;border:1px solid rgba(128,140,170,.4);border-radius:8px;padding:7px 9px;font-size:13.5px;background:transparent;color:inherit}
.sbv .filebtn{display:inline-block}
.sbv .fileinfo{font-size:12.5px;opacity:.75;margin-top:8px}
.sbv .tablewrap{overflow-x:auto;margin-top:4px}
.sbv table{border-collapse:collapse;width:100%;font-size:13px}
.sbv th,.sbv td{border:1px solid rgba(128,140,170,.25);padding:4px 5px;text-align:left}
.sbv th{font-size:11.5px;opacity:.7;font-weight:600;white-space:nowrap}
.sbv td input{border:0;background:transparent;color:inherit;font-size:13px;width:100%;box-sizing:border-box;padding:3px 4px;border-radius:5px;min-width:64px}
.sbv td input:focus{outline:2px solid #2f6fed;background:rgba(47,111,237,.08)}
.sbv tr.badrow td input{background:rgba(220,60,50,.13)}
.sbv tr.duprow td input{background:rgba(240,170,30,.13)}
.sbv .del{border:0;background:none;color:inherit;opacity:.5;cursor:pointer;font-size:15px;padding:2px 6px}
.sbv .delbtn{background:rgba(220,60,50,.15);color:inherit;border:1px solid rgba(220,60,50,.4)}
.sbv .delbtn:hover{background:rgba(220,60,50,.3);opacity:1}
.sbv-modal{position:fixed;inset:0;background:rgba(10,15,30,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:14px}
.sbv-modal-box{background:var(--card-bg,#fff);color:inherit;border-radius:14px;max-width:860px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.sbv-modal-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(128,140,170,.3)}
.sbv-modal-head .ghost{padding:5px 12px;font-size:12.5px}
.sbv-modal-body{padding:12px 16px;overflow:auto;font-size:13px}
.sbv-modal-body table.pview{border-collapse:collapse;width:100%;margin:6px 0}
.sbv-modal-body table.pview td{border:1px solid rgba(128,140,170,.3);padding:4px 8px;vertical-align:top}
.sbv-modal-body table.pview tr.sp td{border:0;padding:6px 0}
.sbv-modal-body table.pview tr:first-child td{font-weight:700}
.sbv-modal-body .mact{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid rgba(128,140,170,.25)}
.sbv .del:hover{opacity:1}
.sbv .totals{font-size:13.5px;font-weight:700;margin-top:10px}
.sbv .totals .ok{color:#2e9e5b}.sbv .totals .err{color:#d33}
.sbv .hint{font-size:12px;opacity:.6;margin-top:6px}
.sbv .hide{display:none}
.sbv-man ol{padding-left:20px;margin:8px 0}
.sbv-man li{margin-bottom:6px;font-size:13px}
.sbv-man p{font-size:13px;margin:6px 0}
.sbv .reglist{display:flex;flex-direction:column;gap:8px}
.sbv .regitem{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid rgba(128,140,170,.25);border-radius:10px;padding:8px 12px}
.sbv .regmain{font-size:13px;min-width:0}
.sbv .regmeta{font-size:11.5px;opacity:.65}
.sbv .badge{background:rgba(220,60,50,.85);color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.sbv .regbtns{display:flex;gap:6px;flex-shrink:0;align-items:center}
.sbv .regbtns .ghost{padding:5px 10px;font-size:12px}
.sbv .chk{margin:8px 0 0;padding:0;list-style:none;font-size:12.5px}
.sbv .chk li{padding:5px 0 5px 26px;position:relative;border-bottom:1px dashed rgba(128,140,170,.2)}
.sbv .chk li::before{content:"⚠";position:absolute;left:4px}
.sbv .chk li.e::before{content:"✖";color:#d33}
.sbv .chk li.w::before{content:"⚠";color:#c90}
.sbv .regmenu{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(128,140,170,.25)}
.sbv .dropzone{border:2px dashed rgba(128,140,170,.45);border-radius:12px;padding:18px;text-align:center;font-size:13px;opacity:.75;margin-top:10px;transition:all .15s}
.sbv .dropzone.over{border-color:#2f6fed;background:rgba(47,111,237,.1);opacity:1}
.sbv .regmenu button{border:1px solid rgba(128,140,170,.4);background:rgba(128,140,170,.12);color:inherit;border-radius:8px;padding:5px 10px;font-size:12px}`;

const TPL = `
<h2>Ведомость Сбербанк <span style="opacity:.35;font-size:11px;font-weight:400">sberpay29</span> <button type="button" class="ghost" id="sbv-manbtn" style="float:right;padding:5px 12px;font-size:12.5px;font-weight:600">? Инструкция</button></h2>
<div class="sbv-sub">Реестр для импорта в Сбер Бизнес Онлайн (юрлица) · формат «Ведомость на счета»</div>

<div class="card hide sbv-man" id="sbv-man">
  <h3>Как работать с вкладкой</h3>
  <p><b>Назначение:</b> любой Excel/CSV со списком выплат превращается в ведомость для импорта в Сбер Бизнес Онлайн — без ручного набора.</p>
  <ol>
    <li><b>Загрузите файл</b>: .xlsx, .xls, .csv, .txt или фото/скан (.png/.jpg) — текст распознаётся автоматически, включая аккуратный рукописный (после OCR сверьте ведомость вручную). Ведомость сформируется автоматически.</li>
    <li><b>Проверьте распознавание.</b> Если колонки определились неверно — поправьте выпадающие списки и нажмите «Применить» ещё раз.</li>
    <li><b>Обновите справочник УИК (необязательно):</b> выберите комиссию → «Обновить состав» — демонстрационные данные заменятся этим списком.</li>
    <li><b>Проверьте ведомость:</b> тап по ячейке — правка. 🔴 красная строка — ошибка (счёт ≠ 20 цифр, пустая сумма/фамилия), выгрузка заблокирована. 🟡 жёлтая — дубль счёта. Внизу — итоги: получателей и сумма; сверьте со сметой до копейки.</li>
    <li><b>«Обновление списков УИК»</b> — отдельная кнопка: загрузите состав (Excel/CSV/TXT/фото) — по колонке с номером УИК списки всех комиссий обновятся автоматически, демонстрационные данные заменятся.</li>
    <li><b>Реестр файлов</b> (вверху вкладки): каждая загрузка сохраняется — «Открыть» вернёт её ведомость, «Сверка ФИО и счетов» проверит: счёт на разные фамилии, дубли людей, разные счёта одного человека между файлами.</li>
    <li><b>«⬇ Выгрузить в Сбербанк»</b> — файл CSV Windows-1251 (разделитель «;»), родной формат «Ведомость на счета». Запасные варианты: CSV UTF-8, XLSX, образец.</li>
    <li><b>Импорт в банк:</b> Сбер Бизнес Онлайн → Зарплатный проект → Импорт ведомости → сверьте количество получателей и итог по предпросмотру → подпишите.</li>
  </ol>
  <p><b>Правила файла:</b> счёт — ровно 20 цифр (в Сбербанке, в рублях); сумма — с точкой: 15000.00; удержаний нет — стоит 0.00.</p>
  <p><b>Проблемы:</b> кракозябры → качайте CSV-1251 (кнопка по умолчанию); колонки съехали → разделитель «;»; «счёт не найден» → не 20 цифр или другой банк (для карт чужих банков — «Массовые переводы», другой шаблон).</p>
</div>

<div class="card" id="sbv-regcard">
  <h3>Реестр загруженных файлов</h3>
  <div class="btnrow" style="margin-top:0">
    <select id="sbv-formsel" style="flex:1;min-width:170px">
      <option value="sber">Контрольная форма — Сбербанк (ведомость)</option>
      <option value="uik">Контрольная форма — УИК (участковая комиссия)</option>
      <option value="tik">Контрольная форма — ТИК (территориальная комиссия)</option>
    </select>
    <button type="button" id="sbv-regform">Скачать форму</button>
    <button type="button" class="ghost" id="sbv-regview">Просмотр</button>
    <button type="button" class="ghost" id="sbv-regcheck">Сверка ФИО и счетов</button>
    <button type="button" class="ghost" id="sbv-regclear">Очистить реестр</button>
  </div>
  <div class="fileinfo" id="sbv-formnote">Выбранная форма — шаблон: при загрузке файлов суммы автозаполняются по ставкам вознаграждения ЦИК, если в файле есть должности.</div>
  <div id="sbv-reglist" class="reglist"><div class="fileinfo">Пока пусто — загрузите файл, он попадёт в реестр автоматически</div></div>
  <div class="fileinfo hide" id="sbv-checkres" style="margin-top:8px"></div>
</div>

<div class="card">
  <h3>Общий список
    <button type="button" class="ghost" id="sbv-mclear" style="float:right;padding:4px 10px;font-size:12px">Очистить</button></h3>
  <div class="hint" style="margin:0 0 10px">Мастер-список получателей: загрузите Excel/CSV/TXT/фото — строки распознаются автоматически. Содержание и название правятся вручную, всё сохраняется на устройстве.</div>
  <div class="btnrow" style="margin-top:0">
    <label class="filebtn"><input type="file" id="sbv-mfile" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" style="display:none"> <button type="button" class="ghost" id="sbv-mpick">Загрузить список</button></label>
    <input type="text" id="sbv-mname" placeholder="Название файла/списка…" style="flex:1;min-width:150px">
  </div>
  <div class="tablewrap hide" id="sbv-mwrap"><table>
    <thead><tr><th>№</th><th>ФИО</th><th>Счёт</th><th>Сумма</th><th></th></tr></thead>
    <tbody id="sbv-mtbody"></tbody>
  </table></div>
  <div class="btnrow"><button type="button" class="ghost hide" id="sbv-madd">+ Строка</button></div>
  <div class="fileinfo" id="sbv-minfo">Список не загружен</div>
</div>

<div class="card">
  <h3>Обновление списков УИК</h3>
  <div class="hint" style="margin:0 0 10px">Отдельная загрузка актуального состава: демонстрационные данные комиссий заменятся этим списком. Если в файле есть колонка с номером УИК — обновление пройдёт по всем комиссиям автоматически, иначе выберите комиссию вручную.</div>
  <div class="btnrow">
    <label class="filebtn"><input type="file" id="sbv-uikfile" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" style="display:none"> <button type="button" class="ghost" id="sbv-uikpick">Выбрать файл состава</button></label>
    <select id="sbv-uikreg" style="flex:1;min-width:160px"><option value="">— или выбрать из реестра вкладки —</option></select>
    <select id="sbv-uikcomm" style="flex:1;min-width:170px"><option value="">— по колонке УИК в файле —</option></select>
    <button type="button" id="sbv-uikgo">Обновить списки УИК</button>
  </div>
  <div class="fileinfo" id="sbv-uikinfo">Файл не выбран</div>
</div>

<div class="card">
  <h3><span class="num">1</span>Загрузите предварительный список</h3>
  <label class="filebtn"><input type="file" id="sbv-file" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" style="display:none"> <button type="button" id="sbv-pick">Выбрать файл (.xlsx / .xls / .csv)</button></label>
  <div class="fileinfo" id="sbv-fileinfo">Excel (.xlsx/.xls), CSV, TXT или фото/скан (.png/.jpg) — с распознаванием текста, включая аккуратный рукописный</div>
  <div class="dropzone" id="sbv-drop">⬇ Перетащите файл сюда — распознается автоматически</div>
</div>

<div class="card hide" id="sbv-mapcard">
  <h3><span class="num">2</span>Распознавание — проверьте сопоставление колонок</h3>
  <div class="maprow" id="sbv-map"></div>
  <div class="fileinfo hide" id="sbv-conf" style="margin-bottom:8px"></div>
  <div class="btnrow"><button type="button" id="sbv-apply">Применить → сформировать ведомость</button></div>
  <div class="btnrow" style="margin-top:14px;border-top:1px solid rgba(128,140,170,.25);padding-top:12px">
    <div style="width:100%;font-size:13px"><b>Обновить справочник членов УИК</b> <span style="opacity:.6">— заменить демонстрационные данные этим списком</span></div>
    <select id="sbv-comm" style="flex:1;min-width:180px"><option value="">— выберите комиссию —</option></select>
    <button type="button" class="ghost" id="sbv-updcomm">Обновить состав</button>
  </div>
  <div class="fileinfo" id="sbv-updres"></div>
</div>

<div class="card hide" id="sbv-tablecard">
  <h3><span class="num">3</span>Ведомость — проверьте и поправьте вручную</h3>
  <div class="btnrow" style="margin-top:0">
    <select id="sbv-treg" style="flex:1;min-width:170px"><option value="">— открыть список из реестра для правки —</option></select>
    <label class="filebtn"><input type="file" id="sbv-tfile" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" style="display:none"> <button type="button" class="ghost" id="sbv-tpick">Загрузить файл (распознавание + Excel)</button></label>
  </div>
  <div class="tablewrap"><table>
    <thead><tr><th>№</th><th>Счёт (20 цифр)</th><th>Фамилия</th><th>Имя</th><th>Отчество</th><th>Сумма</th><th>Удержания</th><th></th></tr></thead>
    <tbody id="sbv-tbody"></tbody>
  </table></div>
  <div class="btnrow">
    <button type="button" class="ghost" id="sbv-add">+ Строка</button>
    <button type="button" class="ghost hide" id="sbv-mmerge">Подставить из общего списка</button>
    <button type="button" class="ghost" id="sbv-copy">Копировать итоги</button>
    <button type="button" id="sbv-save">Сохранить</button>
    <button type="button" class="warnb" id="sbv-del">Удалить</button>
    <button type="button" class="warnb hide" id="sbv-clear">Очистить всё</button>
  </div>
  <div class="totals" id="sbv-totals"></div>
  <div class="hint" id="sbv-hint">Красная строка — ошибка: счёт ≠ 20 цифр или сумма пустая. Жёлтая — одинаковый счёт у разных получателей.</div>
</div>

<div class="card hide" id="sbv-exportcard">
  <h3><span class="num">4</span>Выгрузка в Сбербанк</h3>
  <div class="btnrow" style="margin-top:0">
    <select id="sbv-expreg" style="flex:1;min-width:180px"><option value="0">— выгрузить текущую ведомость (после автораспознавания) —</option></select>
  </div>
  <div class="btnrow">
    <button type="button" id="sbv-csv1251" style="font-size:15px;padding:12px 22px">⬇ Выгрузить в Сбербанк</button>
  </div>
  <div class="hint">Файл CSV (Windows-1251) в формате «Ведомость на счета» — готов к импорту: Сбер Бизнес Онлайн → Зарплатный проект → Импорт ведомости.</div>
  <div class="btnrow" style="margin-top:4px">
    <button type="button" class="ghost" id="sbv-csvutf">CSV UTF-8</button>
    <button type="button" class="ghost" id="sbv-xlsx">XLSX</button>
    <button type="button" class="ghost" id="sbv-sample">Скачать образец</button>
  </div>
  <div class="hint">Перед подписью в банке сверьте: количество получателей и итоговая сумма обязаны совпасть с предпросмотром в Сбер Бизнес Онлайн.</div>
</div>

<div class="sbv-modal hide" id="sbv-modal">
  <div class="sbv-modal-box">
    <div class="sbv-modal-head"><b id="sbv-mtitle">Просмотр</b><button type="button" class="ghost" data-mclose>Закрыть</button></div>
    <div class="sbv-modal-body" id="sbv-mbody"></div>
  </div>
</div>`;

/* ---------- рендер ---------- */
function renderMap(){
  const m = S.mapping;
  document.getElementById("sbv-map").innerHTML = FIELDS.map(f => {
    const opts = [`<option value="-1">— не брать —</option>`]
      .concat(S.headers.map((h, i) => `<option value="${i}" ${m[f.key] === i ? "selected" : ""}>${esc(h) || ("Колонка " + (i + 1))}</option>`));
    return `<div><label>${f.label}</label><select data-k="${f.key}">${opts.join("")}</select></div>`;
  }).join("");
}
function renderTable(){
  const tb = document.getElementById("sbv-tbody");
  const seen = {};
  S.rows.forEach((r, i) => { if (r.account) seen[r.account] = (seen[r.account] || 0) + 1; });
  tb.innerHTML = S.rows.map((r, i) => `
    <tr data-i="${i}">
      <td>${i + 1}</td>
      <td><input type="text" data-k="account" value="${esc(r.account)}" inputmode="numeric"></td>
      <td><input type="text" data-k="last" value="${esc(r.last)}"></td>
      <td><input type="text" data-k="first" value="${esc(r.first)}"></td>
      <td><input type="text" data-k="middle" value="${esc(r.middle)}"></td>
      <td><input type="text" data-k="amount" value="${esc(r.amount)}" inputmode="decimal"></td>
      <td><input type="text" data-k="deduct" value="${esc(r.deduct)}"></td>
      <td><button type="button" class="del" data-del="${i}" title="Удалить строку">×</button></td>
    </tr>`).join("");
  tb.querySelectorAll("tr").forEach(tr => {
    const i = +tr.dataset.i, r = S.rows[i];
    tr.classList.toggle("badrow", rowProblems(r).length > 0);
    tr.classList.toggle("duprow", rowProblems(r).length === 0 && r.account && seen[r.account] > 1);
  });
  updateTotals();
}
function updateTotals(){
  const t = totals();
  const el = document.getElementById("sbv-totals");
  if (!S.rows.length){ el.innerHTML = ""; return; }
  const sum = t.sum.toFixed(2);
  const delta = S.appliedSum ? t.sum - S.appliedSum : 0;
  el.innerHTML = `Получателей: <b>${t.cnt}</b> из ${S.rows.length} · Итого: <b>${sum} ₽</b>`
    + (t.bad ? ` · <span class="err">ошибок: ${t.bad}</span>` : ` · <span class="ok">готово к выгрузке</span>`)
    + (S.appliedSum && Math.abs(delta) > 0.005 ? ` · Δ от загруженного: ${delta > 0 ? "+" : ""}${delta.toFixed(2)} ₽` : "");
  ["sbv-csv1251","sbv-csvutf","sbv-xlsx"].forEach(id => document.getElementById(id).disabled = t.bad > 0);
  saveDraft();
}

/* ---------- логика ---------- */
/* ---------- мультформатная загрузка: Excel/CSV/TXT/фото (OCR) ---------- */
function parseTextLines(text){
  const rows = [];
  for (const raw of text.split(/\r?\n/)){
    let line = String(raw).replace(/[|*_#„“”"«»<>]/g, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const tokens0 = line.split(" ");
    let account = "";
    const keep = [];
    for (let i = 0; i < tokens0.length; i++){
      const t = tokens0[i];
      if (!account && /^[\d\u00A0]+$/.test(t)){
        let j = i, digits = 0;
        const run = [];
        while (j < tokens0.length && /^[\d\u00A0]+$/.test(tokens0[j])){
          run.push(tokens0[j]); digits += tokens0[j].replace(/\D/g, "").length;
          if (digits >= 20) break;
          j++;
        }
        if (digits === 20){ account = run.join("").replace(/\D/g, ""); i = j; continue; }
      }
      keep.push(t);
    }
    let amount = "";
    for (let i = 0; i < keep.length; i++){
      const c1 = keep[i].replace(/[\s\u00A0]/g, "").replace(",", ".");
      if (/^\d{1,3}$/.test(c1) && i + 1 < keep.length && /[.,]/.test(keep[i + 1])){
        const c2 = keep[i + 1].replace(/[\s\u00A0]/g, "").replace(",", ".");
        if (/^\d{1,6}[.]\d{1,2}$/.test(c2)){ amount = c1 + c2; keep.splice(i, 2); i--; continue; }
      }
      if (!amount && /^\d{1,9}([.]\d{1,2})?$/.test(c1) && /[.,]/.test(keep[i])){ amount = c1; keep.splice(i, 1); i--; }
    }
    if (!amount){
      for (let i = keep.length - 1; i >= 0; i--){
        const clean = keep[i].replace(/[\s\u00A0]/g, "").replace(",", ".");
        if (/^\d{1,6}([.]\d{1,2})?$/.test(clean)){ amount = clean; keep.splice(i, 1); break; }
      }
    }
    while (keep.length && /^\d+$/.test(keep[keep.length - 1].replace(/[\s\u00A0]/g, ""))) keep.pop();
    const fio = keep.join(" ").replace(/^[\-–—.:]+|[\-–—.:]+$/g, "").trim();
    if (fio || account) rows.push([fio, account, amount]);
  }
  return rows;
}
function loadMatrix(headers, matrix, mapping, fileName, kind, infoText){
  const fx = matrixCellFix(matrix);
  matrix = fx.matrix;
  const fa = { fixed: 0 };
  S.headers = headers; S.matrix = matrix; S.fileName = fileName; S.kind = kind;
  if (mapping){ S.mapping = mapping; S.confidence = 100; }
  else {
    const mem = mapMemoryGet(fileName);
    if (mem){ S.mapping = mem; S.confidence = 100; S.fromMemory = true; }
    else {
      const sm = smartMapping(headers, matrix);
      S.mapping = sm.mapping; S.confidence = sm.confidence;
    }
  }
  const cf = document.getElementById("sbv-conf");
  if (cf){
    cf.classList.remove("hide");
    cf.textContent = (S.fromMemory ? "Применено сохранённое сопоставление · " : "Умное распознавание · уверенность: " + S.confidence + "%") + (S.confidence < 60 && !S.fromMemory ? " — проверьте колонки вручную" : "");
  }
  document.getElementById("sbv-fileinfo").textContent = infoText + (fx.fixed ? ` · исправлено ячеек (экспоненциальная запись): ${fx.fixed}` : "");
  renderMap();
  document.getElementById("sbv-mapcard").classList.remove("hide");
  applyMapping();
  const fa2 = fixAccounts(S.rows);
  if (fa2.fixed){ S.rows = fa2.rows; renderTable(); if (fa2.sci) document.getElementById("sbv-fileinfo").textContent += ` · счетов восстановлено из E+ записи: ${fa2.sci} (сверьте вручную)`; }
  pushRegistry();
  autoExcelSave();
}
function autoExcelSave(){
  try{
    if (!S.rows.length) return;
    const nm = (S.fileName || "vedomost").replace(/\.[^.]+$/, "").replace(/[^\w\u0400-\u04FF\-]+/g, "_").slice(0, 40) || "vedomost";
    download(`ved_SBER_${nm}_${stamp()}.xlsx`, xlsxBlob());
  }catch(e){}
}
async function onImage(file){
  const info = document.getElementById("sbv-fileinfo");
  info.textContent = "Распознавание изображения… OCR-модель загружается (первый раз — до 1–2 мин, далее из кэша)";
  try{
    if (!window.Tesseract){
      await new Promise((ok, no) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        s.onload = ok; s.onerror = () => no(new Error("не удалось загрузить OCR-модель — проверьте интернет"));
        document.head.appendChild(s);
      });
    }
    const worker = await Tesseract.createWorker("rus");
    try{
      const { data } = await worker.recognize(file);
      const rows = parseTextLines(data.text);
      if (!rows.length) throw new Error("текст не распознан — сфотографируйте ровнее, светлее, крупнее");
      loadMatrix(["ФИО (распознано)", "Счет", "Сумма"], rows, { fio: 0, account: 1, amount: 2 },
        file.name, "image", `${file.name} · распознано строк: ${rows.length} · сверьте ведомость вручную, OCR может ошибаться`);
    } finally { worker.terminate(); }
  } catch (e){ info.textContent = "Ошибка распознавания: " + e.message; }
}
function onText(text, name){
  const rows = parseTextLines(text);
  if (!rows.length){ document.getElementById("sbv-fileinfo").textContent = "В файле не найдены строки с ФИО/счётом/суммой"; return; }
  loadMatrix(["ФИО", "Счет", "Сумма"], rows, { fio: 0, account: 1, amount: 2 }, name, "text", `${name} · ${rows.length} строк`);
}
async function onFile(file){
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name)) return onImage(file);
  if (name.endsWith(".txt")) return onText(await file.text(), file.name);
  let wb;
  try { wb = XLSX.read(await file.arrayBuffer(), { type: "array" }); }
  catch (e) { document.getElementById("sbv-fileinfo").textContent = "Не удалось прочитать файл: " + e.message; return; }
  let best = null;
  for (const sn of wb.SheetNames){
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
    const rawM = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    for (let r = 0; r < matrix.length; r++){
      for (let c = 0; c < matrix[r].length; c++){
        const rv = rawM[r] ? rawM[r][c] : undefined;
        if (typeof rv === "number" && isFinite(rv) && Math.abs(rv) >= 1e15 && String(matrix[r][c]).replace(/\D/g, "").length !== 20)
          matrix[r][c] = expandNumber(rv);
      }
    }
    if (matrix.length < 2) continue;
    const first = matrix[0].map(c => String(c).trim());
    const looksHeader = first.some(c => /[A-Za-zА-Яа-яЁё]/.test(c));
    const headers = looksHeader ? first : first.map((_, i) => "Колонка " + (i + 1));
    const data = looksHeader ? matrix.slice(1) : matrix;
    const sm = smartMapping(headers, data);
    const filled = Object.keys(sm.mapping).length;
    const score = filled * 1000 + data.length * 2 + sm.confidence;
    if (!best || score > best.score) best = { sn, headers, data, score };
  }
  if (!best){ document.getElementById("sbv-fileinfo").textContent = "В файле нет данных"; return; }
  const smart = filterSmartRows(best.data);
  loadMatrix(best.headers, smart.rows, null, file.name, "table", `${file.name} · ${smart.rows.length} строк · лист «${best.sn}» (выбран автоматически)`);
}
function applyMapping(){
  const get = (row, key) => { const i = S.mapping[key]; return (i == null || i < 0) ? "" : row[i]; };
  S.rows = S.matrix.map(row => {
    const r = {
      account: digits(get(row, "account")),
      last: "", first: "", middle: "",
      amount: normAmount(get(row, "amount")),
      deduct: normAmount(get(row, "deduct")) || "0.00",
      __role: mapRole(get(row, "role")),
    };
    if (S.mapping.fio != null && S.mapping.fio >= 0) Object.assign(r, splitFio(normFioCase(String(get(row, "fio")).trim())));
    else {
      r.last = String(get(row, "last")).trim();
      r.first = String(get(row, "first")).trim();
      r.middle = String(get(row, "middle")).trim();
    }
    return r;
  }).filter(r => r.account || r.last || parseFloat(r.amount) > 0);
  const af = autofillByTemplate(S.rows);
  S.rows = af.rows;
  if (af.filled && document.getElementById("sbv-fileinfo"))
    setTimeout(() => { document.getElementById("sbv-fileinfo").textContent += " · автозаполнение по шаблону " + af.tpl.toUpperCase() + ": сумм по ставкам ЦИК — " + af.filled; }, 60);
  S.appliedSum = S.rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
  document.getElementById("sbv-tablecard").classList.remove("hide");
  document.getElementById("sbv-exportcard").classList.remove("hide");
  document.getElementById("sbv-clear").classList.remove("hide");
  renderTable();
  document.getElementById("sbv-tablecard").scrollIntoView({ behavior: "smooth", block: "start" });
}
function buildLines(src){
  const RR = src || S.rows;
  return RR.map(r => [r.account, r.last, r.first, r.middle, r.amount || "0.00", r.deduct || "0.00"]);
}
function csvText(src){
  const q = v => { v = String(v ?? ""); return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [HEADER.map(q).join(";")].concat(buildLines(src).map(c => c.map(q).join(";"))).join("\r\n");
}
function exportName(){
  const el = document.getElementById("sbv-expreg");
  if (el && +el.value){
    const e = loadReg().find(x => x.id === +el.value);
    if (e) return (e.name || "vedomost").replace(/\.[^.]+$/, "").replace(/[^\w\u0400-\u04FF\-]+/g, "_").slice(0, 30) || "vedomost";
  }
  return (S.fileName || "vedomost").replace(/\.[^.]+$/, "").replace(/[^\w\u0400-\u04FF\-]+/g, "_").slice(0, 30) || "vedomost";
}
function exportRows(){
  const el = document.getElementById("sbv-expreg");
  const id = el ? +el.value : 0;
  if (!id) return S.rows;
  const e = loadReg().find(x => x.id === id);
  return e ? (e.rows || []) : S.rows;
}
function guardRows(rows){
  if (!rows.length){ alert("Ведомость пустая."); return false; }
  let bad = 0; for (const r of rows) if (rowProblems(r).length) bad++;
  if (bad){ alert("Проверка выгрузки: в ведомости " + bad + " строк с ошибками — номер счета должен быть 20 цифр (не экспоненциальная запись), сумма и фамилия не пустые. Исправьте через «Правка» в реестре."); return false; }
  const sci = rows.filter(r => r.__sci).length;
  if (sci && !confirm("Проверка выгрузки: " + sci + " счет(ов) восстановлены из экспоненциальной записи (вида 4,08E+19) — точность последних цифр не гарантирована. Сверьте их с первоисточником. Продолжить выгрузку?")) return false;
  return true;
}
function exportRowsFixed(){
  const el = document.getElementById("sbv-expreg");
  const id = el ? +el.value : 0;
  const fx = fixAccounts(exportRows());
  if (fx.fixed){
    if (id){
      const reg = loadReg();
      const e = reg.find(x => x.id === id);
      if (e){ e.rows = fx.rows; saveReg(reg); renderReg(); }
    }
    document.getElementById("sbv-fileinfo").textContent = "Автопроверка выгрузки: исправлено номеров счетов (E+ запись → полный номер): " + fx.fixed + (fx.sci ? " — сверьте восстановленные вручную" : "");
  }
  return fx.rows;
}
function guard(){
  const t = totals();
  if (t.bad){ alert("В ведомости " + t.bad + " строк с ошибками (красные). Исправьте счёт/фамилию/сумму — банк такой файл не примет."); return false; }
  if (!S.rows.length){ alert("Ведомость пустая."); return false; }
  return true;
}
function sheetFromRows(aoa){
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = 1; r <= range.e.r; r++){
    const acc = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (acc) acc.z = "@";
    for (const c of [4, 5]){
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = "#,##0.00";
    }
  }
  ws["!cols"] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 24 }];
  return ws;
}
function buildLinesX(src){
  const RR = src || S.rows;
  return RR.map(r => [r.account, r.last, r.first, r.middle, parseFloat(r.amount) || 0, parseFloat(r.deduct) || 0]);
}
function xlsxBlob(src){
  const ws = sheetFromRows([HEADER, ...buildLinesX(src)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Ведомость");
  return new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/* ---------- автосохранение черновика ---------- */
const DRAFT_KEY = "sbv_draft_v1";
let draftTimer = null;
function saveDraft(){
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try{
      if (!S.rows.length){ localStorage.removeItem(DRAFT_KEY); return; }
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ rows: S.rows, appliedSum: S.appliedSum, name: S.fileName, date: new Date().toLocaleString("ru-RU") }));
    }catch(e){}
  }, 800);
}
function restoreDraft(){
  try{
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (d && d.rows && d.rows.length){
      S.rows = d.rows; S.appliedSum = d.appliedSum || 0; S.fileName = d.name || "";
      document.getElementById("sbv-tablecard").classList.remove("hide");
      document.getElementById("sbv-exportcard").classList.remove("hide");
      renderTable();
      document.getElementById("sbv-fileinfo").textContent = "Восстановлен черновик от " + (d.date || "") + (d.name ? " · " + d.name : "") + " — продолжайте правку или загрузите новый файл";
    }
  }catch(e){}
}

function mergeFromMaster(){
  if (!M.rows.length){ alert("Общий список пуст — сначала загрузите его."); return; }
  const byFio = new Map(M.rows.map(r => [normFio(r.fio), r]));
  let filled = 0;
  S.rows = S.rows.map(r => {
    const m = byFio.get(normFio([r.last, r.first, r.middle].join(" ")));
    if (!m) return r;
    const nr = { ...r };
    if (!nr.account && m.account){ nr.account = m.account; filled++; }
    if ((!nr.amount || parseFloat(nr.amount) <= 0) && m.amount){ nr.amount = m.amount; filled++; }
    return nr;
  });
  renderTable();
  document.getElementById("sbv-fileinfo").textContent = "Подставлено из общего списка: " + filled + " значений (по совпадению ФИО).";
}
function saveCurrentVed(){
  if (!S.rows.length){ alert("Ведомость пустая — нечего сохранять."); return; }
  let name = S.fileName || "";
  if (!name){
    name = prompt("Название для сохранения в реестре:", "Ведомость " + new Date().toLocaleDateString("ru-RU")) || "";
    if (!name) return;
    S.fileName = name;
  }
  const t = totals();
  const reg = loadReg();
  const ex = reg.find(e => e.name === name);
  const entry = { id: ex ? ex.id : Date.now(), name, date: new Date().toLocaleString("ru-RU"),
    kind: S.kind || "table", rows: S.rows.map(r => { const { __sci, ...rest } = r; return rest; }),
    count: S.rows.length, sum: t.sum.toFixed(2), bad: t.bad };
  const next = ex ? reg.map(e => e.id === ex.id ? entry : e) : [entry, ...reg];
  saveReg(next); renderReg();
  document.getElementById("sbv-fileinfo").textContent = (ex ? "Запись обновлена" : "Сохранено в реестр") + `: «${name}» · ${entry.count} чел. · ${entry.sum} ₽`;
}
function deleteCurrentVed(){
  if (!S.rows.length && !S.fileName){ alert("Нечего удалять."); return; }
  if (!confirm(`Удалить текущую ведомость${S.fileName ? ` «${S.fileName}»` : ""}? Запись в реестре (если есть) тоже будет удалена.`)) return;
  if (S.fileName){
    const reg = loadReg().filter(e => e.name !== S.fileName);
    if (reg.length !== loadReg().length){ saveReg(reg); renderReg(); }
  }
  S.rows = []; S.fileName = ""; S.appliedSum = 0;
  document.getElementById("sbv-tablecard").classList.add("hide");
  document.getElementById("sbv-exportcard").classList.add("hide");
  localStorage.removeItem(DRAFT_KEY);
  document.getElementById("sbv-fileinfo").textContent = "Ведомость удалена. Загрузите файл или откройте запись из реестра.";
}

function copySummary(){
  const t = totals();
  const txt = `Ведомость Сбербанк: получателей ${t.cnt} из ${S.rows.length}, итого ${t.sum.toFixed(2)} ₽` + (t.bad ? `, ошибок: ${t.bad}` : " — готово к выгрузке");
  const done = () => { document.getElementById("sbv-fileinfo").textContent = "Итоги скопированы в буфер обмена."; };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, () => { prompt("Скопируйте вручную:", txt); });
  else prompt("Скопируйте вручную:", txt);
}

/* ---------- общий список (мастер-список получателей) ---------- */
const MASTER_KEY = "sbv_master_v1";
const M = { name: "", rows: [], loaded: false };
function saveMaster(){
  clearTimeout(M.__t);
  M.__t = setTimeout(() => {
    try{
      if (!M.rows.length){ localStorage.removeItem(MASTER_KEY); return; }
      localStorage.setItem(MASTER_KEY, JSON.stringify({ name: M.name, rows: M.rows, date: new Date().toLocaleString("ru-RU") }));
    }catch(e){}
  }, 800);
}
function refreshMergeBtn(){
  const b = document.getElementById("sbv-mmerge");
  if (b) b.classList.toggle("hide", !M.rows.length);
}
function renderMaster(){
  const wrap = document.getElementById("sbv-mwrap");
  const tb = document.getElementById("sbv-mtbody");
  const add = document.getElementById("sbv-madd");
  const info = document.getElementById("sbv-minfo");
  const nameEl = document.getElementById("sbv-mname");
  if (!wrap) return;
  nameEl.value = M.name;
  if (!M.rows.length){ wrap.classList.add("hide"); add.classList.add("hide"); if (!M.loaded) info.textContent = "Список не загружен"; return; }
  M.loaded = true;
  wrap.classList.remove("hide"); add.classList.remove("hide");
  refreshMergeBtn();
  tb.innerHTML = M.rows.map((r, i) => `<tr data-i="${i}">
    <td>${i + 1}</td>
    <td><input type="text" data-k="fio" value="${esc(r.fio)}"></td>
    <td><input type="text" data-k="account" value="${esc(r.account)}" inputmode="numeric"></td>
    <td><input type="text" data-k="amount" value="${esc(r.amount)}" inputmode="decimal"></td>
    <td><button type="button" class="del" data-mdel="${i}" title="Удалить строку">×</button></td>
  </tr>`).join("");
  info.textContent = M.rows.length + " строк · сохранено на устройстве" + (M.__savedate ? " · " + M.__savedate : "");
  saveMaster();
}
function restoreMaster(){
  try{
    const d = JSON.parse(localStorage.getItem(MASTER_KEY));
    if (d && d.rows && d.rows.length){
      M.name = d.name || ""; M.rows = d.rows; M.loaded = true; M.__savedate = d.date || "";
      renderMaster();
    }
  }catch(e){}
}
async function onMasterFile(file){
  const info = document.getElementById("sbv-minfo");
  info.textContent = "Чтение файла…";
  try{
    const { rows, headers, ocr } = await extractRows(file);
    if (!rows.length) throw new Error("не найдены строки с данными");
    const mp = guessMapping(headers);
    const get = (row, key) => { const i = mp[key]; return (i == null || i < 0) ? "" : row[i]; };
    M.rows = rows.map(row => {
      let fio = "";
      if (mp.fio != null && mp.fio >= 0) fio = String(get(row, "fio")).trim();
      else fio = [get(row, "last"), get(row, "first"), get(row, "middle")].map(x => String(x).trim()).filter(Boolean).join(" ");
      return { fio, account: digits(get(row, "account")), amount: normAmount(get(row, "amount")) };
    }).filter(r => r.fio || r.account);
    M.name = file.name; M.loaded = true;
    renderMaster();
    info.textContent = `${file.name} · ${M.rows.length} строк${ocr ? " · OCR (сверьте вручную)" : ""} — содержание и название можно править ниже`;
    try{
      const nm = (file.name || "spisok").replace(/\.[^.]+$/, "").replace(/[^\w\u0400-\u04FF\-]+/g, "_").slice(0, 40) || "spisok";
      const aoa = [["ФИО", "Счет", "Сумма"], ...M.rows.map(r => [r.fio, r.account, r.amount])];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 30 }, { wch: 22 }, { wch: 14 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Список");
      download(`spisok_${nm}_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    }catch(e){}
  }catch(e){ info.textContent = "Ошибка чтения: " + e.message; }
}

function fillTRegSelect(){
  const sel = document.getElementById("sbv-treg");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— открыть список из реестра для правки —</option>' +
    loadReg().map(e => `<option value="${e.id}">${esc(e.name)} · ${e.count} чел.</option>`).join("");
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function fillExpRegSelect(){
  const sel = document.getElementById("sbv-expreg");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="0">— выгрузить текущую ведомость (после автораспознавания) —</option>' +
    loadReg().map(e => `<option value="${e.id}">${esc(e.name)} · ${e.count} чел. · ${e.sum} ₽</option>`).join("");
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function fillUikRegSelect(){
  const sel = document.getElementById("sbv-uikreg");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— или выбрать из реестра вкладки —</option>' +
    loadReg().map(e => `<option value="${e.id}">${esc(e.name)} · ${e.count} чел.</option>`).join("");
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function loadUikFromRegistry(id){
  const info = document.getElementById("sbv-uikinfo");
  const e = loadReg().find(x => x.id === id);
  if (!e){ U.matrix = []; info.textContent = "Файл не выбран"; return; }
  const rows = (e.rows || []).map(r => [[r.last, r.first, r.middle].join(" ").trim(), r.account || "", r.amount || ""]);
  if (!rows.length){ U.matrix = []; info.textContent = "В записи реестра нет строк."; return; }
  U.matrix = rows; U.headers = ["ФИО", "Счет", "Сумма"];
  U.mapping = { fio: 0, account: 1, amount: 2 };
  U.fileName = e.name + " (реестр)";
  U.uikCol = detectUikColumn(U.headers, rows);
  info.textContent = `${e.name} · из реестра · ${rows.length} строк · колонка УИК: ${U.uikCol >= 0 ? '"' + U.headers[U.uikCol] + '"' : "не найдена — выберите комиссию вручную"}`;
}

/* ---------- отдельное обновление списков УИК ---------- */
const U = { headers: [], matrix: [], mapping: {}, uikCol: -1, fileName: "" };
async function extractRows(file){
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name)){
    if (!window.Tesseract){
      await new Promise((ok, no) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        s.onload = ok; s.onerror = () => no(new Error("не удалось загрузить OCR-модель — проверьте интернет"));
        document.head.appendChild(s);
      });
    }
    const worker = await Tesseract.createWorker("rus");
    try{
      const { data } = await worker.recognize(file);
      return { rows: parseTextLines(data.text), headers: ["ФИО (распознано)", "Счет", "Сумма"], ocr: true };
    } finally { worker.terminate(); }
  }
  if (name.endsWith(".txt")) return { rows: parseTextLines(await file.text()), headers: ["ФИО", "Счет", "Сумма"] };
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("в файле нет листов");
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  const rawM = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  for (let r = 0; r < matrix.length; r++){
    for (let c = 0; c < matrix[r].length; c++){
      const rv = rawM[r] ? rawM[r][c] : undefined;
      if (typeof rv === "number" && isFinite(rv) && Math.abs(rv) >= 1e15 && String(matrix[r][c]).replace(/\D/g, "").length !== 20)
        matrix[r][c] = expandNumber(rv);
    }
  }
  if (!matrix.length) throw new Error("файл пустой");
  const first = matrix[0].map(c => String(c).trim());
  const looksHeader = first.some(c => /[A-Za-zА-Яа-яЁё]/.test(c));
  if (looksHeader) return { rows: matrix.slice(1), headers: first };
  return { rows: matrix, headers: first.map((_, i) => "Колонка " + (i + 1)) };
}
function detectUikColumn(headers, rows){
  let best = -1, bestScore = 0;
  headers.forEach((h, i) => {
    let score = /уик|комисси/i.test(String(h)) ? 3 : 0;
    let nums = 0; const tests = Math.min(rows.length, 25);
    for (let r = 0; r < tests; r++){
      if (/^(уик\s*)?№?\s*\d{1,4}$/i.test(String(rows[r][i] ?? "").trim())) nums++;
    }
    score += (nums / tests) * 3;
    if (score > bestScore){ bestScore = score; best = i; }
  });
  return bestScore >= 2 ? best : -1;
}
async function runUikUpdate(){
  const info = document.getElementById("sbv-uikinfo");
  if (!U.matrix.length){ info.textContent = "Сначала выберите файл состава."; return; }
  const db = window.__db;
  if (!db || !db.commissions){ info.textContent = "Нет доступа к базе приложения."; return; }
  const comms = (await db.commissions.toArray()).filter(c => c.level === "UIK");
  const numFromRef = v => { const m = String(v ?? "").match(/\d{1,4}/); return m ? +m[0] : null; };
  const manualId = +document.getElementById("sbv-uikcomm").value || null;
  if (U.uikCol < 0 && !manualId){ info.textContent = "Колонка УИК не найдена — выберите комиссию вручную."; return; }
  const groups = new Map(), skipped = [];
  for (const row of U.matrix){
    const get = k => { const i = U.mapping[k]; return (i == null || i < 0) ? "" : row[i]; };
    let fio = "";
    if (U.mapping.fio != null && U.mapping.fio >= 0) fio = String(get("fio")).trim();
    else fio = [get("last"), get("first"), get("middle")].map(x => String(x).trim()).filter(Boolean).join(" ");
    if (!fio) continue;
    const role = mapRole(get("role"));
    let commId = manualId;
    if (!commId && U.uikCol >= 0){
      const n = numFromRef(row[U.uikCol]);
      if (n != null){
        const c = comms.find(c => c.uikNo === n) || comms.find(c => String(c.code).includes(String(n)));
        commId = c ? c.id : null;
      }
    }
    if (!commId){ skipped.push(fio); continue; }
    if (!groups.has(commId)) groups.set(commId, []);
    groups.get(commId).push({ fio, role });
  }
  if (!groups.size){ info.textContent = "Не удалось сопоставить ни одного человека с комиссией." + (skipped.length ? " Без УИК: " + skipped.slice(0, 5).join(", ") : ""); return; }
  info.textContent = "Обновление " + groups.size + " комиссий…";
  const lines = [];
  for (const [cid, mem] of groups){
    const c = comms.find(x => x.id === cid);
    try{
      const st = await updateCommissionMembers(cid, mem);
      lines.push(`${c ? c.code : cid}: ${st.total} чел. — добавлено ${st.added}, демо→актуальные ${st.upgraded}, демо удалено ${st.deleted}, роли ${st.updated}`);
    }catch(e){ lines.push(`${c ? c.code : cid}: ошибка — ${e.message}`); }
  }
  if (skipped.length) lines.push("Без совпавшей комиссии (" + skipped.length + "): " + skipped.slice(0, 6).join(", ") + (skipped.length > 6 ? "…" : ""));
  info.innerHTML = "Готово.<br>" + lines.map(esc).join("<br>");
}

/* ---------- реестр загруженных файлов ---------- */
const REG_KEY = "sbv_registry_v1";
function loadReg(){ try { return JSON.parse(localStorage.getItem(REG_KEY)) || []; } catch (e){ return []; } }
function saveReg(r){ try { localStorage.setItem(REG_KEY, JSON.stringify(r.slice(0, 20))); } catch (e){} }
function pushRegistry(){
  const t = totals();
  const reg = loadReg();
  reg.unshift({ id: Date.now(), name: S.fileName || "без имени", date: new Date().toLocaleString("ru-RU"),
    kind: S.kind || "table", rows: S.rows.map(r => ({ ...r })), count: S.rows.length, sum: t.sum.toFixed(2), bad: t.bad });
  saveReg(reg); renderReg();
}
function renderReg(){
  const reg = loadReg();
  const card = document.getElementById("sbv-regcard");
  const list = document.getElementById("sbv-reglist");
  if (!card || !list) return;
  if (!reg.length){ list.innerHTML = '<div class="fileinfo">Пока пусто — загрузите файл, он попадёт в реестр автоматически</div>'; card.classList.remove("hide"); return; }
  card.classList.remove("hide");
  fillUikRegSelect();
  fillExpRegSelect();
  fillTRegSelect();
  list.innerHTML = reg.map(e => `<div class="regitem" data-id="${e.id}">
    <div class="regmain"><b>${esc(e.name)}</b><br><span class="regmeta">${esc(e.date)} · ${e.count} чел. · ${e.sum} ₽${e.bad ? ` · <span class="badge">ошибок: ${e.bad}</span>` : ""}${e.kind === "image" ? " · фото/OCR" : ""}</span></div>
    <div class="regbtns">
      <button type="button" class="ghost" data-view="${e.id}">Открыть</button>
      <button type="button" class="ghost" data-open="${e.id}">Правка</button>
      <button type="button" class="ghost" data-send="${e.id}">Отправить</button>
      <button type="button" class="ghost" data-exp="${e.id}">Экспорт</button>
      <button type="button" class="ghost delbtn" data-rdel="${e.id}" title="Удалить из реестра">Удалить</button>
    </div>
    <div class="regmenu hide" data-menu="${e.id}">
      <button type="button" data-fmt="csv1251" data-id="${e.id}">CSV Сбербанк Онлайн (Windows-1251)</button>
      <button type="button" data-fmt="csvutf" data-id="${e.id}">CSV UTF-8</button>
      <button type="button" data-fmt="xlsx" data-id="${e.id}">XLSX</button>
      <button type="button" data-fmt="txt" data-id="${e.id}">TXT (список)</button>
    </div>
  </div>`).join("");
}
function regEntryRows(id){
  const e = loadReg().find(x => x.id === id);
  return e ? e : null;
}
function exportRegEntry(id, fmt){
  const e = regEntryRows(id); if (!e) return;
  const rows = e.rows || [];
  if (!rows.length){ alert("В записи нет строк."); return; }
  const nm = (e.name || "vedomost").replace(/\.[^.]+$/, "").replace(/[^\w\u0400-\u04FF\-]+/g, "_").slice(0, 40) || "vedomost";
  if (fmt === "csv1251") download(`ved_SBER_${nm}_${stamp()}.csv`, new Blob([enc1251(csvTextFrom(rows))], { type: "application/csv;charset=windows-1251" }));
  else if (fmt === "csvutf") download(`ved_SBER_${nm}_${stamp()}.csv`, new Blob(["\uFEFF" + csvTextFrom(rows)], { type: "application/csv;charset=utf-8" }));
  else if (fmt === "xlsx"){
    const aoa = [HEADER, ...rows.map(r => [r.account, r.last, r.first, r.middle, parseFloat(r.amount) || 0, parseFloat(r.deduct) || 0])];
    const ws = sheetFromRows(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ведомость");
    download(`ved_SBER_${nm}_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  }
  else if (fmt === "txt"){
    const txt = rows.map((r, i) => `${i + 1}. ${[r.last, r.first, r.middle].join(" ").trim()} — счёт ${r.account || "—"}, сумма ${r.amount || "—"}`).join("\n");
    download(`spisok_${nm}_${stamp()}.txt`, new Blob(["\uFEFF" + txt], { type: "text/plain;charset=utf-8" }));
  }
}
const TPL_KEY = "sbv_tpl_v1";
function activeTemplate(){
  try { return localStorage.getItem(TPL_KEY) || "sber"; } catch(e){ return "sber"; }
}
function autofillByTemplate(rows){
  const t = activeTemplate();
  if (t === "sber") return { rows, filled: 0, tpl: t };
  let filled = 0;
  const out = rows.map(r => {
    if ((!r.amount || parseFloat(r.amount) <= 0) && r.__role && RATES[r.__role]){
      filled++;
      return { ...r, amount: (RATES[r.__role]).toFixed(2) };
    }
    return r;
  });
  return { rows: out, filled, tpl: t };
}

function buildCommAoa(kind){
  const isUik = kind === "uik";
  const aoa = [
    ["КОНТРОЛЬНАЯ ФОРМА"],
    [`к ведомости на выплату вознаграждения членам ${isUik ? "участковой" : "территориальной"} избирательной комиссии`],
    [],
    [`${isUik ? "Участковая избирательная комиссия № ______" : "Территориальная избирательная комиссия"}`, "", "", "Наименование выборов/период:", ""],
    ["", "", "", "Дата составления:", ""],
    [],
    ["№ п/п", "Фамилия, имя, отчество", "Должность", "Ставка вознаграждения, руб.", "Кол-во дней (смен)", "Сумма, руб.", "Подпись"],
  ];
  for (let i = 1; i <= 10; i++) aoa.push([i, "", "", "", "", "", ""]);
  aoa.push(
    [],
    ["", "", "", "", "ИТОГО:", "", ""],
    [],
    ["Сумма прописью:", "", "", "", "", "", ""],
    [],
    ["Председатель комиссии: _________ / ________________ /", "", "", "", "Секретарь: _________ / ________________ /", "", ""],
    [],
    ["М.П.", "", "", "", "", "", ""],
    [],
    isUik ? ["Отметка ТИК о согласовании:", "", "", "", "", "", ""] : ["Согласовано с избирательной комиссией субъекта РФ:", "", "", "", "", "", ""],
    [],
    ["Примечание: ставки вознаграждения — по постановлению ЦИК России (председатель — 63, заместитель и секретарь — 57, член — 45 за день работы)."],
    ["Форма — рабочий шаблон по структуре контрольных форм, применяемых при выплате вознаграждений членам избирательных комиссий; реквизиты конкретного избирательного события заполняются вручную."]
  );
  return aoa;
}
function buildSberAoa(){
  const aoa = [
    ["ПАО СБЕРБАНК"],
    ["КОНТРОЛЬНАЯ ФОРМА ВЕДОМОСТИ"],
    [],
    ["Организация:", "", "", "№ ведомости:", "", "Дата составления:", ""],
    ["Счёт организации:", "", "", "ИНН:", "", "КПП:", ""],
    [],
    ["№ п/п", "Фамилия", "Имя", "Отчество", "№ счёта получателя", "Сумма, руб.", "Подпись получателя"],
  ];
  for (let i = 1; i <= 10; i++) aoa.push([i, "", "", "", "", "", ""]);
  aoa.push(
    [],
    ["", "", "", "", "ИТОГО:", "", ""],
    [],
    ["Сумма прописью:", "", "", "", "", "", ""],
    [],
    ["Руководитель организации: _________ / ________________ /", "", "", "", "Главный бухгалтер: _________ / ________________ /", "", ""],
    [],
    ["М.П.", "", "", "", "", "", ""],
    [],
    ["Примечание: форма соответствует требованиям Сбербанка к оформлению ведомости на выплату (зарплатный проект)."],
    ["Счёт получателя — 20 цифр, текстовый формат; сумма — в рублях с копейками, разделитель точка."]
  );
  return aoa;
}
function aoaToHtml(aoa){
  let h = '<table class="pview">';
  for (const row of aoa){
    const cells = row.map(c => String(c ?? ""));
    if (!cells.some(c => c.trim())){ h += '<tr class="sp"><td colspan="7">&nbsp;</td></tr>'; continue; }
    h += "<tr>" + cells.map(c => `<td>${esc(c) || "&nbsp;"}</td>`).join("") + "</tr>";
  }
  return h + "</table>";
}
function openViewer(title, bodyHtml){
  document.getElementById("sbv-mtitle").textContent = title;
  document.getElementById("sbv-mbody").innerHTML = bodyHtml;
  document.getElementById("sbv-modal").classList.remove("hide");
}
function closeViewer(){ document.getElementById("sbv-modal").classList.add("hide"); }
function downloadAoa(aoa, name){
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 6 }, { wch: 30 }, { wch: 16 }, { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Контрольная форма");
  download(name, new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}
function downloadControlForm(kind){
  kind = kind || activeTemplate();
  downloadAoa(kind === "sber" ? buildSberAoa() : buildCommAoa(kind), `kontrolnaya_forma_${kind.toUpperCase()}_${stamp()}.xlsx`);
}
function previewControlForm(kind){
  kind = kind || activeTemplate();
  const names = { sber: "Сбербанк (ведомость)", uik: "УИК (участковая комиссия)", tik: "ТИК (территориальная комиссия)" };
  openViewer("Контрольная форма: " + (names[kind] || kind),
    aoaToHtml(kind === "sber" ? buildSberAoa() : buildCommAoa(kind)) +
    `<div class="mact">
      <button type="button" data-mdl-form="${kind}">⬇ Скачать XLSX</button>
      <button type="button" class="ghost" data-mshare-form="${kind}">Открыть внешним приложением</button>
    </div>`);
}
function previewRegEntry(id){
  const e = regEntryRows(id);
  if (!e) return;
  const rows = e.rows || [];
  let sum = 0, body = "";
  if (rows.length){
    body = '<table class="pview"><tr><td>№</td><td>Фамилия</td><td>Имя</td><td>Отчество</td><td>Счёт</td><td>Сумма</td><td>Удерж.</td></tr>';
    rows.forEach((r, i) => {
      const n = parseFloat(r.amount) || 0; sum += n;
      body += `<tr><td>${i + 1}</td><td>${esc(r.last)}</td><td>${esc(r.first)}</td><td>${esc(r.middle)}</td><td>${esc(r.account)}</td><td>${esc(r.amount)}</td><td>${esc(r.deduct)}</td></tr>`;
    });
    body += "</table>";
  } else body = "<p>Запись пустая.</p>";
  openViewer(`Просмотр: ${e.name}`,
    `<div class="fileinfo" style="margin-bottom:6px">${esc(e.date)} · ${rows.length} чел. · итого ${sum.toFixed(2)} ₽${e.bad ? ` · ошибок: ${e.bad}` : ""}</div>` +
    body +
    `<div class="mact">
      <button type="button" data-mdl="${e.id}">⬇ Скачать XLSX</button>
      <button type="button" class="ghost" data-mshare="${e.id}">Открыть внешним приложением</button>
      <button type="button" class="ghost" data-medit="${e.id}">Править</button>
    </div>`);
}
async function shareFormExternal(kind){
  const aoa = kind === "sber" ? buildSberAoa() : buildCommAoa(kind);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Контрольная форма");
  const blob = new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const file = new File([blob], `kontrolnaya_forma_${kind.toUpperCase()}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  if (navigator.canShare && navigator.canShare({ files: [file] })){
    try { await navigator.share({ files: [file], title: "Контрольная форма" }); return; } catch (err) { if (err && err.name === "AbortError") return; }
  }
  download(file.name, blob);
  alert("Прямая отправка не поддерживается — файл скачан, откройте его внешним приложением.");
}

async function sendRegEntry(id){
  const e = regEntryRows(id); if (!e) return;
  const rows = e.rows || [];
  if (!rows.length){ alert("В записи нет строк."); return; }
  const nm = (e.name || "vedomost").replace(/\.[^.]+$/, "").replace(/[^\w\u0400-\u04FF\-]+/g, "_").slice(0, 40) || "vedomost";
  const blob = new Blob([enc1251(csvTextFrom(rows))], { type: "application/csv;charset=windows-1251" });
  const file = new File([blob], `ved_SBER_${nm}.csv`, { type: "application/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })){
    try{ await navigator.share({ files: [file], title: "Ведомость Сбербанк", text: `${rows.length} получателей, итого ${e.sum} ₽ (файл в формате Сбербанк Онлайн)` }); return; }catch(err){ if (err && err.name === "AbortError") return; }
  }
  download(file.name, blob);
  alert("Прямая отправка не поддерживается этим браузером — файл скачан, прикрепите его вручную в мессенджер/почту.");
}
function csvTextFrom(rows){
  const q = v => { v = String(v ?? ""); return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [HEADER.map(q).join(";")].concat(rows.map(r => [r.account, r.last, r.first, r.middle, r.amount || "0.00", r.deduct || "0.00"].map(q).join(";"))).join("\r\n");
}

function restoreReg(id){
  const e = loadReg().find(x => x.id === id);
  if (!e) return;
  let rows = JSON.parse(JSON.stringify(e.rows || []));
  const fx = fixAccounts(rows);
  if (fx.fixed){
    rows = fx.rows;
    e.rows = rows;
    saveReg(loadReg().map(x => x.id === id ? e : x));
    renderReg();
  }
  S.rows = rows;
  if (fx.fixed) setTimeout(() => { document.getElementById("sbv-fileinfo").textContent = `Проверка при открытии: исправлено номеров счетов (E+ запись → полный номер): ${fx.fixed}` + (fx.sci ? " — восстановленные из экспоненциальной записи счета сверьте с источником" : ""); }, 50);
  S.fileName = e.name; S.appliedSum = parseFloat(e.sum) || 0;
  document.getElementById("sbv-tablecard").classList.remove("hide");
  document.getElementById("sbv-exportcard").classList.remove("hide");
  renderTable();
  document.getElementById("sbv-tablecard").scrollIntoView({ behavior: "smooth" });
}

/* ---------- сверка ФИО и счетов ---------- */
function runCheck(){
  const box = document.getElementById("sbv-checkres");
  const issues = [];
  const cur = S.rows;
  const reg = loadReg();
  const byAccount = new Map(), byFio = new Map();
  const addAcc = (acc, last, src) => {
    if (!acc || !/\d{20}/.test(acc)) return;
    if (!byAccount.has(acc)) byAccount.set(acc, new Map());
    const m = byAccount.get(acc);
    if (!m.has(last)) m.set(last, new Set());
    m.get(last).add(src);
  };
  const addFio = (fio, acc) => {
    const k = normFio(fio);
    if (!k) return;
    if (!byFio.has(k)) byFio.set(k, new Set());
    if (acc) byFio.get(k).add(acc);
  };
  const seenCur = new Map();
  cur.forEach((r, i) => {
    const fio = [r.last, r.first, r.middle].join(" ");
    addAcc(r.account, r.last || ("строка " + (i + 1)), "текущая ведомость");
    addFio(fio, r.account);
    if (!r.last) issues.push({ l: "e", t: `Строка ${i + 1}: пустая фамилия` });
    else {
      if (/[A-Za-z]/.test(fio)) issues.push({ l: "w", t: `Строка ${i + 1}: латиница в ФИО «${fio.trim()}»` });
      const k = normFio(fio);
      if (seenCur.has(k)) issues.push({ l: "w", t: `«${fio.trim()}» встречается в ведомости 2 раза (строки ${seenCur.get(k) + 1} и ${i + 1})` });
      else seenCur.set(k, i);
    }
    if (r.account && !/^\d{20}$/.test(r.account)) issues.push({ l: "e", t: `Строка ${i + 1}: счёт «${r.account}» — не 20 цифр` });
  });
  reg.forEach(e => (e.rows || []).forEach(r => {
    addAcc(r.account, r.last || e.name, e.name);
    addFio([r.last, r.first, r.middle].join(" "), r.account);
  }));
  for (const [acc, m] of byAccount){
    if (m.size > 1){
      const fams = [...m.keys()].filter(f => !/^строка /.test(f)).slice(0, 4).join(", ");
      issues.push({ l: "e", t: `Счёт ${acc} числится на разные фамилии: ${fams} — проверьте, чей это счёт` });
    }
  }
  for (const [k, accs] of byFio){
    if (accs.size > 1) issues.push({ l: "w", t: `${k} — разные счета: ${[...accs].join(", ")} (возможна смена счёта — уточните актуальный)` });
  }
  const errs = issues.filter(x => x.l === "e").length;
  const warns = issues.length - errs;
  box.classList.remove("hide");
  box.innerHTML = issues.length
    ? `<b>Сверка:</b> ошибок — ${errs}, замечаний — ${warns}.<ul class="chk">${issues.slice(0, 50).map(x => `<li class="${x.l}">${esc(x.t)}</li>`).join("")}${issues.length > 50 ? `<li>…и ещё ${issues.length - 50}</li>` : ""}</ul>`
    : '<b>Сверка:</b> конфликтов не найдено — ФИО и счета согласованы.';
}

/* ---------- публичный API ---------- */
/* ---------- сторож версии: обновление без участия пользователя ---------- */
let watchdogBusy = false;
async function versionWatchdog(){
  if (watchdogBusy) return;
  watchdogBusy = true;
  try{
    const r = await fetch("sw.js", { cache: "no-store" });
    const t = await r.text();
    const m = t.match(/sberpay(\d+)/);
    if (!m) return;
    const remote = +m[1];
    const local = parseInt(String(window.__sbvdmV || "").replace(/\D/g, ""), 10) || 0;
    if (remote <= local) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg){
      try { await reg.update(); } catch(e){}
      if (reg.waiting) reg.waiting.postMessage("SKIP_WAITING");
    }
    const mod = await import(`./sber-vedomost.js?v=sberpay${remote}`);
    if (window.__sbvdmUnmount) { try { window.__sbvdmUnmount(); } catch(e){} }
    window.__sbvdmV = "sberpay" + remote;
    if (window.__sbvdmHost) mod.mount(window.__sbvdmHost);
  } catch(e){ /* офлайн или ошибка — остаёмся на текущей версии */ }
  finally { watchdogBusy = false; }
}

export function mount(el){
  root = el;
  window.__sbvdmHost = el;
  versionWatchdog();
  if (!document.getElementById("sbv-style")){
    const st = document.createElement("style");
    st.id = "sbv-style"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  el.innerHTML = `<div class="sbv">${TPL}</div>`;
  document.getElementById("sbv-pick").onclick = () => document.getElementById("sbv-file").click();
  document.getElementById("sbv-manbtn").onclick = () => document.getElementById("sbv-man").classList.toggle("hide");
  document.getElementById("sbv-reglist").addEventListener("click", e => {
    const o = e.target.closest("[data-open]");
    const d = e.target.closest("[data-rdel]");
    const s = e.target.closest("[data-send]");
    const x = e.target.closest("[data-exp]");
    const f = e.target.closest("[data-fmt]");
    const v = e.target.closest("[data-view]");
    if (v) return previewRegEntry(+v.dataset.view);
    if (f) return exportRegEntry(+f.dataset.id, f.dataset.fmt);
    if (o) return restoreReg(+o.dataset.open);
    if (s) return sendRegEntry(+s.dataset.send);
    if (x){
      document.querySelectorAll(".regmenu").forEach(m => { if (m.dataset.menu !== x.dataset.exp) m.classList.add("hide"); });
      document.querySelector('[data-menu="' + x.dataset.exp + '"]').classList.toggle("hide");
      return;
    }
    if (d){
      const reg0 = loadReg();
      const en0 = reg0.find(x2 => x2.id === +d.dataset.rdel);
      if (en0 && confirm(`Удалить из реестра «${en0.name}» (${en0.count} чел., ${en0.sum} ₽)?`)){
        saveReg(reg0.filter(x2 => x2.id !== +d.dataset.rdel));
        renderReg();
      }
    }
  });
  refreshMergeBtn();
  document.getElementById("sbv-regcheck").onclick = runCheck;
  const fsel = document.getElementById("sbv-formsel");
  fsel.value = activeTemplate();
  fsel.onchange = () => { try { localStorage.setItem(TPL_KEY, fsel.value); } catch(e){} };
  document.getElementById("sbv-regform").onclick = () => downloadControlForm(fsel.value);
  document.getElementById("sbv-regview").onclick = () => previewControlForm(fsel.value);
  document.getElementById("sbv-modal").addEventListener("click", e => {
    if (e.target.id === "sbv-modal" || e.target.closest("[data-mclose]")) return closeViewer();
    const b1 = e.target.closest("[data-mdl]");
    const b2 = e.target.closest("[data-mshare]");
    const b3 = e.target.closest("[data-medit]");
    const b4 = e.target.closest("[data-mdl-form]");
    const b5 = e.target.closest("[data-mshare-form]");
    if (b1){ closeViewer(); return exportRegEntry(+b1.dataset.mdl, "xlsx"); }
    if (b2){ closeViewer(); return sendRegEntry(+b2.dataset.mshare); }
    if (b3){ closeViewer(); return restoreReg(+b3.dataset.medit); }
    if (b4) return downloadControlForm(b4.dataset.mdlForm);
    if (b5) return shareFormExternal(b5.dataset.mshareForm);
  });
  document.getElementById("sbv-regclear").onclick = () => {
    const reg0 = loadReg();
    if (!reg0.length){ return; }
    if (confirm(`Удалить все ${reg0.length} записей реестра? Действие необратимо.`)){
      saveReg([]);
      renderReg();
      document.getElementById("sbv-checkres").classList.add("hide");
    }
  };
  document.getElementById("sbv-tpick").onclick = () => document.getElementById("sbv-tfile").click();
  document.getElementById("sbv-tfile").onchange = e => { const f = e.target.files[0]; if (f) onFile(f); };
  document.getElementById("sbv-treg").onchange = e => { if (e.target.value) restoreReg(+e.target.value); };
  const dz = document.getElementById("sbv-drop");
  ["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) onFile(f); });
  document.getElementById("sbv-mmerge").onclick = mergeFromMaster;
  document.getElementById("sbv-copy").onclick = copySummary;
  document.getElementById("sbv-save").onclick = saveCurrentVed;
  document.getElementById("sbv-del").onclick = deleteCurrentVed;
  document.getElementById("sbv-mpick").onclick = () => document.getElementById("sbv-mfile").click();
  document.getElementById("sbv-mfile").onchange = e => { const f = e.target.files[0]; if (f) onMasterFile(f); };
  document.getElementById("sbv-mname").oninput = e => { M.name = e.target.value; saveMaster(); };
  document.getElementById("sbv-madd").onclick = () => { M.rows.push({ fio: "", account: "", amount: "" }); renderMaster(); };
  document.getElementById("sbv-mclear").onclick = () => { if (confirm("Очистить общий список?")){ M.name = ""; M.rows = []; M.loaded = false; localStorage.removeItem(MASTER_KEY); renderMaster(); document.getElementById("sbv-minfo").textContent = "Список не загружен"; } };
  document.getElementById("sbv-mtbody").addEventListener("input", e => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const i = +tr.dataset.i, k = e.target.dataset.k; if (k == null || !M.rows[i]) return;
    M.rows[i][k] = k === "account" ? digits(e.target.value) : e.target.value;
    saveMaster();
  });
  document.getElementById("sbv-mtbody").addEventListener("click", e => {
    const b = e.target.closest("[data-mdel]"); if (!b) return;
    M.rows.splice(+b.dataset.mdel, 1); renderMaster();
  });
  restoreMaster();
  document.getElementById("sbv-uikpick").onclick = () => document.getElementById("sbv-uikfile").click();
  document.getElementById("sbv-uikfile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const info = document.getElementById("sbv-uikinfo");
    info.textContent = "Чтение файла…";
    try{
      const { rows, headers, ocr } = await extractRows(f);
      if (!rows.length) throw new Error("не найдены строки с данными");
      U.matrix = rows; U.headers = headers; U.fileName = f.name;
      U.mapping = guessMapping(headers);
      U.uikCol = detectUikColumn(headers, rows);
      info.textContent = `${f.name} · ${rows.length} строк · колонка УИК: ${U.uikCol >= 0 ? '"' + headers[U.uikCol] + '"' : "не найдена — выберите комиссию вручную"}${ocr ? " · OCR (сверьте вручную)" : ""}`;
    }catch(err){ U.matrix = []; info.textContent = "Ошибка чтения: " + err.message; }
  };
  document.getElementById("sbv-uikgo").onclick = runUikUpdate;
  document.getElementById("sbv-uikreg").onchange = e => { if (e.target.value) loadUikFromRegistry(+e.target.value); else { U.matrix = []; document.getElementById("sbv-uikinfo").textContent = "Файл не выбран"; } };
  renderReg();
  fillUikRegSelect();
  if (!S.rows.length) restoreDraft();
  document.getElementById("sbv-file").onchange = e => { if (e.target.files[0]) onFile(e.target.files[0]); };
  document.getElementById("sbv-map").onchange = e => {
    const k = e.target.dataset.k;
    if (k) S.mapping[k] = +e.target.value;
  };
  document.getElementById("sbv-apply").onclick = () => { mapMemoryPut(S.fileName, S.mapping); S.fromMemory = true; applyMapping(); };
  (async () => {
    const sel = document.getElementById("sbv-comm");
    try{
      const db = window.__db;
      if (!db || !db.commissions) throw new Error("нет доступа");
      const list = (await db.commissions.toArray()).filter(c => c.level === "UIK").sort((a, b) => (a.uikNo || 0) - (b.uikNo || 0));
      const opts = list.map(c => `<option value="${c.id}">${esc(c.code)}${c.district ? " · " + esc(c.district) : ""}</option>`).join("");
      sel.innerHTML = '<option value="">— выберите комиссию —</option>' + opts;
      const sel2 = document.getElementById("sbv-uikcomm");
      if (sel2) sel2.innerHTML = '<option value="">— по колонке УИК в файле —</option>' + opts;
    }catch(e){ sel.innerHTML = '<option value="">справочник недоступен</option>'; }
  })();
  document.getElementById("sbv-updcomm").onclick = async () => {
    const res = document.getElementById("sbv-updres");
    const id = +document.getElementById("sbv-comm").value;
    if (!id){ res.textContent = "Выберите комиссию."; return; }
    const btn = document.getElementById("sbv-updcomm");
    btn.disabled = true; res.textContent = "Обновление…";
    try{
      const st = await updateCommissionMembers(id, collectMembers());
      res.textContent = `Готово: ${st.total} человек из файла. Добавлено новых: ${st.added}, демо переведено в актуальные: ${st.upgraded}, демо удалено: ${st.deleted}, роли уточнены: ${st.updated}.`;
    }catch(e){ res.textContent = "Ошибка обновления: " + e.message; }
    finally{ btn.disabled = false; }
  };
  document.getElementById("sbv-add").onclick = () => {
    S.rows.push({ account: "", last: "", first: "", middle: "", amount: "", deduct: "0.00" });
    renderTable();
  };
  document.getElementById("sbv-clear").onclick = () => {
    if (confirm("Очистить всю ведомость?")){ S.rows = []; renderTable(); }
  };
  document.getElementById("sbv-tbody").addEventListener("input", e => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const i = +tr.dataset.i, k = e.target.dataset.k; if (k == null) return;
    S.rows[i][k] = e.target.value;
    if (k === "account"){
      const f = cellFix(e.target.value);
      S.rows[i][k] = f.fixed ? String(f.v).replace(/\D/g, "") : digits(e.target.value);
      if (f.sci) S.rows[i].__sci = true;
    }
    if (k === "amount" || k === "deduct"){
      const n = parseFloat(String(e.target.value).replace(",", "."));
      S.rows[i][k] = isFinite(n) ? String(e.target.value).replace(",", ".") : e.target.value;
    }
    tr.classList.toggle("badrow", rowProblems(S.rows[i]).length > 0);
    updateTotals();
  });
  document.getElementById("sbv-tbody").addEventListener("focusout", e => {
    const k = e.target.dataset && e.target.dataset.k;
    if (!k) return;
    const tr = e.target.closest("tr"); if (!tr) return;
    const i = +tr.dataset.i; if (!S.rows[i]) return;
    if (k === "amount" || k === "deduct"){
      const n = parseFloat(String(e.target.value).replace(/[\s\u00A0]/g, "").replace(",", "."));
      if (isFinite(n)){ S.rows[i][k] = n.toFixed(2); e.target.value = (+n.toFixed(2)).toLocaleString("ru-RU", { minimumFractionDigits: 2 }); updateTotals(); }
    }
    if (k === "account"){
      const f = cellFix(e.target.value);
      const d = f.fixed ? String(f.v).replace(/\D/g, "") : digits(e.target.value);
      S.rows[i][k] = d; e.target.value = d;
      if (f.sci) S.rows[i].__sci = true;
    }
  });
  document.getElementById("sbv-tbody").addEventListener("click", e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    S.rows.splice(+b.dataset.del, 1); renderTable();
  });
  document.getElementById("sbv-csv1251").onclick = () => {
    const rows = exportRowsFixed(); if (!guardRows(rows)) return;
    const nm = exportName(rows);
    download(`ved_SBER_${nm}_${stamp()}.csv`, new Blob([enc1251(csvText(rows))], { type: "application/csv;charset=windows-1251" }));
  };
  document.getElementById("sbv-csvutf").onclick = () => {
    const rows = exportRowsFixed(); if (!guardRows(rows)) return;
    const nm = exportName(rows);
    download(`ved_SBER_${nm}_${stamp()}.csv`, new Blob(["\uFEFF" + csvText(rows)], { type: "application/csv;charset=utf-8" }));
  };
  document.getElementById("sbv-xlsx").onclick = () => {
    const rows = exportRowsFixed(); if (!guardRows(rows)) return;
    const nm = exportName(rows);
    download(`ved_SBER_${nm}_${stamp()}.xlsx`, xlsxBlob(rows));
  };
  document.getElementById("sbv-sample").onclick = () => {
    const ws = sheetFromRows([HEADER,
      ["40702810123450123456","Иванов","Иван","Иванович",15000,0],
      ["40702810987650432109","Петрова","Мария","Сергеевна",22850.5,0]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ведомость");
    download("obrazec_SBER_vedomost.xlsx", new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  };
  if (S.rows.length) renderTable();
  window.__sbvdmV = "sberpay29";
}
export function unmount(){ root = null; }
if (typeof window !== "undefined") window.__sbvdmUnmount = unmount;
