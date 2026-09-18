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
async function updateCommissionMembers(commId){
  const db = window.__db;
  const mem = collectMembers();
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
.sbv .chk li.w::before{content:"⚠";color:#c90}`;

const TPL = `
<h2>Ведомость Сбербанк <button type="button" class="ghost" id="sbv-manbtn" style="float:right;padding:5px 12px;font-size:12.5px;font-weight:600">? Инструкция</button></h2>
<div class="sbv-sub">Реестр для импорта в Сбер Бизнес Онлайн (юрлица) · формат «Ведомость на счета»</div>

<div class="card hide sbv-man" id="sbv-man">
  <h3>Как работать с вкладкой</h3>
  <p><b>Назначение:</b> любой Excel/CSV со списком выплат превращается в ведомость для импорта в Сбер Бизнес Онлайн — без ручного набора.</p>
  <ol>
    <li><b>Загрузите файл</b>: .xlsx, .xls, .csv, .txt или фото/скан (.png/.jpg) — текст распознаётся автоматически, включая аккуратный рукописный (после OCR сверьте ведомость вручную). Ведомость сформируется автоматически.</li>
    <li><b>Проверьте распознавание.</b> Если колонки определились неверно — поправьте выпадающие списки и нажмите «Применить» ещё раз.</li>
    <li><b>Обновите справочник УИК (необязательно):</b> выберите комиссию → «Обновить состав» — демонстрационные данные заменятся этим списком.</li>
    <li><b>Проверьте ведомость:</b> тап по ячейке — правка. 🔴 красная строка — ошибка (счёт ≠ 20 цифр, пустая сумма/фамилия), выгрузка заблокирована. 🟡 жёлтая — дубль счёта. Внизу — итоги: получателей и сумма; сверьте со сметой до копейки.</li>
    <li><b>Реестр файлов</b> (вверху вкладки): каждая загрузка сохраняется — «Открыть» вернёт её ведомость, «Сверка ФИО и счетов» проверит: счёт на разные фамилии, дубли людей, разные счёта одного человека между файлами.</li>
    <li><b>«⬇ Выгрузить в Сбербанк»</b> — файл CSV Windows-1251 (разделитель «;»), родной формат «Ведомость на счета». Запасные варианты: CSV UTF-8, XLSX, образец.</li>
    <li><b>Импорт в банк:</b> Сбер Бизнес Онлайн → Зарплатный проект → Импорт ведомости → сверьте количество получателей и итог по предпросмотру → подпишите.</li>
  </ol>
  <p><b>Правила файла:</b> счёт — ровно 20 цифр (в Сбербанке, в рублях); сумма — с точкой: 15000.00; удержаний нет — стоит 0.00.</p>
  <p><b>Проблемы:</b> кракозябры → качайте CSV-1251 (кнопка по умолчанию); колонки съехали → разделитель «;»; «счёт не найден» → не 20 цифр или другой банк (для карт чужих банков — «Массовые переводы», другой шаблон).</p>
</div>

<div class="card hide" id="sbv-regcard">
  <h3>Реестр загруженных файлов
    <button type="button" class="ghost" id="sbv-regcheck" style="float:right;padding:4px 10px;font-size:12px">Сверка ФИО и счетов</button></h3>
  <div id="sbv-reglist" class="reglist"><div class="fileinfo">Пока пусто — загрузите файл, он попадёт в реестр автоматически</div></div>
  <div class="fileinfo hide" id="sbv-checkres" style="margin-top:8px"></div>
</div>

<div class="card">
  <h3><span class="num">1</span>Загрузите предварительный список</h3>
  <label class="filebtn"><input type="file" id="sbv-file" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" style="display:none"> <button type="button" id="sbv-pick">Выбрать файл (.xlsx / .xls / .csv)</button></label>
  <div class="fileinfo" id="sbv-fileinfo">Excel (.xlsx/.xls), CSV, TXT или фото/скан (.png/.jpg) — с распознаванием текста, включая аккуратный рукописный</div>
</div>

<div class="card hide" id="sbv-mapcard">
  <h3><span class="num">2</span>Распознавание — проверьте сопоставление колонок</h3>
  <div class="maprow" id="sbv-map"></div>
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
  <div class="tablewrap"><table>
    <thead><tr><th>№</th><th>Счёт (20 цифр)</th><th>Фамилия</th><th>Имя</th><th>Отчество</th><th>Сумма</th><th>Удержания</th><th></th></tr></thead>
    <tbody id="sbv-tbody"></tbody>
  </table></div>
  <div class="btnrow">
    <button type="button" class="ghost" id="sbv-add">+ Строка</button>
    <button type="button" class="warnb hide" id="sbv-clear">Очистить всё</button>
  </div>
  <div class="totals" id="sbv-totals"></div>
  <div class="hint" id="sbv-hint">Красная строка — ошибка: счёт ≠ 20 цифр или сумма пустая. Жёлтая — одинаковый счёт у разных получателей.</div>
</div>

<div class="card hide" id="sbv-exportcard">
  <h3><span class="num">4</span>Выгрузка в Сбербанк</h3>
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
  S.headers = headers; S.matrix = matrix; S.fileName = fileName; S.kind = kind;
  S.mapping = mapping || guessMapping(headers);
  document.getElementById("sbv-fileinfo").textContent = infoText;
  renderMap();
  document.getElementById("sbv-mapcard").classList.remove("hide");
  applyMapping();
  pushRegistry();
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
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws){ document.getElementById("sbv-fileinfo").textContent = "В файле нет листов"; return; }
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  if (!matrix.length){ document.getElementById("sbv-fileinfo").textContent = "Файл пустой"; return; }
  const first = matrix[0].map(c => String(c).trim());
  const looksHeader = first.some(c => /[A-Za-zА-Яа-яЁё]/.test(c));
  let headers, data;
  if (looksHeader){ headers = first; data = matrix.slice(1); }
  else { headers = first.map((_, i) => "Колонка " + (i + 1)); data = matrix; }
  loadMatrix(headers, data, null, file.name, "table", `${file.name} · ${data.length} строк · лист «${wb.SheetNames[0]}»`);
}
function applyMapping(){
  const get = (row, key) => { const i = S.mapping[key]; return (i == null || i < 0) ? "" : row[i]; };
  S.rows = S.matrix.map(row => {
    const r = {
      account: digits(get(row, "account")),
      last: "", first: "", middle: "",
      amount: normAmount(get(row, "amount")),
      deduct: normAmount(get(row, "deduct")) || "0.00",
    };
    if (S.mapping.fio != null && S.mapping.fio >= 0) Object.assign(r, splitFio(get(row, "fio")));
    else {
      r.last = String(get(row, "last")).trim();
      r.first = String(get(row, "first")).trim();
      r.middle = String(get(row, "middle")).trim();
    }
    return r;
  }).filter(r => r.account || r.last || parseFloat(r.amount) > 0);
  S.appliedSum = S.rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
  document.getElementById("sbv-tablecard").classList.remove("hide");
  document.getElementById("sbv-exportcard").classList.remove("hide");
  document.getElementById("sbv-clear").classList.remove("hide");
  renderTable();
  document.getElementById("sbv-tablecard").scrollIntoView({ behavior: "smooth", block: "start" });
}
function buildLines(){
  return S.rows.map(r => [r.account, r.last, r.first, r.middle, r.amount || "0.00", r.deduct || "0.00"]);
}
function csvText(){
  const q = v => { v = String(v ?? ""); return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [HEADER.map(q).join(";")].concat(buildLines().map(c => c.map(q).join(";"))).join("\r\n");
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
function buildLinesX(){
  return S.rows.map(r => [r.account, r.last, r.first, r.middle, parseFloat(r.amount) || 0, parseFloat(r.deduct) || 0]);
}
function xlsxBlob(){
  const ws = sheetFromRows([HEADER, ...buildLinesX()]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Ведомость");
  return new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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
  if (!reg.length){ list.innerHTML = '<div class="fileinfo">Пока пусто — загрузите файл, он попадёт в реестр автоматически</div>'; return; }
  card.classList.remove("hide");
  list.innerHTML = reg.map(e => `<div class="regitem" data-id="${e.id}">
    <div class="regmain"><b>${esc(e.name)}</b><br><span class="regmeta">${esc(e.date)} · ${e.count} чел. · ${e.sum} ₽${e.bad ? ` · <span class="badge">ошибок: ${e.bad}</span>` : ""}${e.kind === "image" ? " · фото/OCR" : ""}</span></div>
    <div class="regbtns"><button type="button" class="ghost" data-open="${e.id}">Открыть</button><button type="button" class="del" data-rdel="${e.id}" title="Удалить из реестра">×</button></div>
  </div>`).join("");
}
function restoreReg(id){
  const e = loadReg().find(x => x.id === id);
  if (!e) return;
  S.rows = JSON.parse(JSON.stringify(e.rows || []));
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
export function mount(el){
  root = el;
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
    if (o) restoreReg(+o.dataset.open);
    else if (d){ saveReg(loadReg().filter(x => x.id !== +d.dataset.rdel)); renderReg(); }
  });
  document.getElementById("sbv-regcheck").onclick = runCheck;
  renderReg();
  document.getElementById("sbv-file").onchange = e => { if (e.target.files[0]) onFile(e.target.files[0]); };
  document.getElementById("sbv-map").onchange = e => {
    const k = e.target.dataset.k;
    if (k) S.mapping[k] = +e.target.value;
  };
  document.getElementById("sbv-apply").onclick = applyMapping;
  (async () => {
    const sel = document.getElementById("sbv-comm");
    try{
      const db = window.__db;
      if (!db || !db.commissions) throw new Error("нет доступа");
      const list = (await db.commissions.toArray()).filter(c => c.level === "UIK").sort((a, b) => (a.uikNo || 0) - (b.uikNo || 0));
      sel.innerHTML = '<option value="">— выберите комиссию —</option>' +
        list.map(c => `<option value="${c.id}">${esc(c.code)}${c.district ? " · " + esc(c.district) : ""}</option>`).join("");
    }catch(e){ sel.innerHTML = '<option value="">справочник недоступен</option>'; }
  })();
  document.getElementById("sbv-updcomm").onclick = async () => {
    const res = document.getElementById("sbv-updres");
    const id = +document.getElementById("sbv-comm").value;
    if (!id){ res.textContent = "Выберите комиссию."; return; }
    const btn = document.getElementById("sbv-updcomm");
    btn.disabled = true; res.textContent = "Обновление…";
    try{
      const st = await updateCommissionMembers(id);
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
    if (k === "account") S.rows[i][k] = digits(e.target.value);
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
    if (k === "account"){ const d = digits(e.target.value); S.rows[i][k] = d; e.target.value = d; }
  });
  document.getElementById("sbv-tbody").addEventListener("click", e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    S.rows.splice(+b.dataset.del, 1); renderTable();
  });
  document.getElementById("sbv-csv1251").onclick = () => {
    if (!guard()) return;
    download(`ved_SBER_${stamp()}.csv`, new Blob([enc1251(csvText())], { type: "application/csv;charset=windows-1251" }));
  };
  document.getElementById("sbv-csvutf").onclick = () => {
    if (!guard()) return;
    download(`ved_SBER_${stamp()}.csv`, new Blob(["\uFEFF" + csvText()], { type: "application/csv;charset=utf-8" }));
  };
  document.getElementById("sbv-xlsx").onclick = () => {
    if (!guard()) return;
    download(`ved_SBER_${stamp()}.xlsx`, xlsxBlob());
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
}
export function unmount(){ root = null; }
if (typeof window !== "undefined") window.__sbvdmUnmount = unmount;
