// Вкладка «Ведомость Сбербанк» — реестр для импорта в Сбер Бизнес Онлайн (юрлица)
// Формат «Ведомость на счета»: Счет(20);Фамилия;Имя;Отчество;Сумма(точка);Удержания(точка)
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { loadXlsx } from '../lib/excel';
import { RATES } from '../lib/rules';
import { Card, CardHead, Num } from '../components/app/kit';
import type { Member, Role } from '../types';

const VER = 'sberpay28';
const HEADER = ['Счет (20 знаков)', 'Фамилия', 'Имя', 'Отчество', 'Сумма (разделитель - точка)', 'Сумма произведенных удержаний (разделитель - точка)'];
const REG_KEY = 'sbv_registry_v1';
const DRAFT_KEY = 'sbv_draft_v1';
const MASTER_KEY = 'sbv_master_v1';
const TPL_KEY = 'sbv_tpl_v1';

interface VedRow { account: string; last: string; first: string; middle: string; amount: string; deduct: string; }
interface RegEntry { id: number; name: string; date: string; kind: string; rows: VedRow[]; count: number; sum: string; bad: number; }
interface Draft { rows: VedRow[]; appliedSum: number; name: string; date: string; }
interface Issue { l: 'e' | 'w'; t: string; }

const FIELDS: { key: string; label: string }[] = [
  { key: 'account', label: 'Счёт получателя (20 цифр)' },
  { key: 'fio', label: 'ФИО одной строкой' },
  { key: 'last', label: 'Фамилия' },
  { key: 'first', label: 'Имя' },
  { key: 'middle', label: 'Отчество' },
  { key: 'role', label: 'Должность (необязательно)' },
  { key: 'amount', label: 'Сумма' },
  { key: 'deduct', label: 'Удержания (необязательно)' },
];
const RULES: [string, RegExp][] = [
  ['last', /фамили/i], ['middle', /отчеств/i], ['first', /(^|[^а-яa-z])имя([^а-яa-z]|$)/i],
  ['fio', /фио|получател|сотрудник|работник|член|наименование/i],
  ['account', /сч[её]т|account/i], ['role', /председат|замест|секретарь|должност/i],
  ['deduct', /удерж|ндфл/i], ['amount', /сумма|выплат|начисл|итог|вознагражд|к\s*оплат/i],
];

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const normFio = (s: unknown) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
function normAmount(v: unknown): string {
  if (typeof v === 'number' && isFinite(v)) return v.toFixed(2);
  const s = String(v ?? '').replace(/[\s  ]/g, '').replace(/руб.*$/i, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n.toFixed(2) : '';
}
function splitFio(fio: string) {
  const p = fio.trim().split(/\s+/).filter(Boolean);
  return { last: p[0] || '', first: p[1] || '', middle: p.slice(2).join(' ') };
}
function mapRole(v: unknown): Role {
  const s = String(v || '').toLowerCase();
  if (/председат/.test(s)) return 'chair';
  if (/замест/.test(s)) return 'deputy';
  if (/секретар/.test(s)) return 'secretary';
  return 'member';
}
// ── Защита счетов от экспоненциальной записи (4,08E+19) ─────────────
function expandNumber(n: number): string {
  try { return n.toLocaleString('fullwide', { useGrouping: false }); }
  catch {
    let s = String(n);
    if (/e/i.test(s)) {
      const parts = s.split(/e/i);
      const a = parts[0].replace('.', '');
      const p = +parts[1] - (parts[0].includes('.') ? parts[0].split('.')[1].length : 0);
      s = a + '0'.repeat(Math.max(p, 0));
    }
    return s;
  }
}
function cellFix(v: unknown): { v: unknown; fixed: boolean; sci: boolean } {
  if (typeof v === 'number' && isFinite(v) && Math.abs(v) >= 1e15) return { v: expandNumber(v), fixed: true, sci: true };
  const m = String(v ?? '').trim().match(/^(\d{1,3}(?:[.,]\d+)?)\s*[eE]\s*\+?\s*(\d{1,3})$/);
  if (m) {
    const n = Number(m[1].replace(',', '.')) * Math.pow(10, +m[2]);
    if (isFinite(n)) return { v: expandNumber(n), fixed: true, sci: true };
  }
  return { v, fixed: false, sci: false };
}
function fixAccounts(rows: VedRow[]): { rows: (VedRow & { __sci?: boolean })[]; fixed: number; sci: number } {
  let fixed = 0, sci = 0;
  const out = rows.map((r) => {
    const acc = String(r.account ?? '');
    if (!/^\d{20}$/.test(acc)) {
      const f = cellFix(acc);
      if (f.fixed) {
        const d = String(f.v).replace(/\D/g, '');
        if (d !== acc) { fixed++; if (f.sci) sci++; return { ...r, account: d, __sci: true }; }
      }
    }
    return r;
  });
  return { rows: out, fixed, sci };
}

// ── Умное распознавание: контент-анализ + заголовки ──────────────────
function colEvidence(rows: string[][], i: number, tests: number) {
  let acc = 0, amt = 0, fio = 0, uik = 0;
  for (let r = 0; r < tests; r++) {
    const v = String(rows[r] ? rows[r][i] ?? '' : '').trim();
    if (!v) continue;
    if (v.replace(/\D/g, '').length === 20) acc++;
    if (/^\d{1,9}([.,]\d{1,2})?$/.test(v.replace(/[\s\u00A0]/g, '').replace(',', '.'))) amt++;
    if (/^[А-ЯЁ][а-яё]+(\s+[А-ЯЁ][а-яё]+)+/.test(v)) fio++;
    if (/^(уик\s*)?№?\s*\d{1,4}$/i.test(v)) uik++;
  }
  const n = Math.max(tests, 1);
  return { acc: acc / n, amt: amt / n, fio: fio / n, uik: uik / n };
}
function smartMapping(headers: string[], rows: string[][]): { mapping: Record<string, number>; confidence: number } {
  const tests = Math.min(rows ? rows.length : 0, 30);
  const ev = headers.map((_, i) => colEvidence(rows || [], i, tests));
  const used = new Set<number>();
  const mapping: Record<string, number> = {}; const conf: Record<string, number> = {};
  function pick(key: string, metric: 'acc' | 'amt' | 'fio', re: RegExp, minContent: number) {
    let best = -1, bs = 0;
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const s = ev[i][metric] * 0.8 + (re.test(String(h)) ? 0.6 : 0);
      if (s > bs) { bs = s; best = i; }
    });
    if (best >= 0 && (ev[best][metric] >= minContent || re.test(String(headers[best])))) {
      mapping[key] = best; used.add(best); conf[key] = Math.round(ev[best][metric] * 100);
    }
  }
  pick('account', 'acc', /сч[её]т|account/i, 0.5);
  pick('amount', 'amt', /сумма|выплат|начисл|итог|вознагражд|к\s*оплат/i, 0.5);
  pick('fio', 'fio', /фио|получател|сотрудник|работник|член|наименование/i, 0.4);
  if (mapping.fio == null) {
    for (const [key, re] of [['last', /фамили/i], ['first', /(^|[^а-яa-z])имя([^а-яa-z]|$)/i], ['middle', /отчеств/i]] as const) {
      const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h)));
      if (i >= 0) { mapping[key] = i; used.add(i); }
    }
  }
  for (const [key, re] of [['role', /председат|замест|секретарь|должност/i], ['deduct', /удерж|ндфл/i]] as const) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h)));
    if (i >= 0) { mapping[key] = i; used.add(i); }
  }
  const vals = Object.keys(conf).map((k) => conf[k]);
  return { mapping, confidence: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0 };
}
function normFioCase(fio: string): string {
  return String(fio || '').split(/\s+/).map((w) => (!w ? w : (w === w.toLowerCase() || w === w.toUpperCase()) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}
function filterSmartRows(matrix: string[][]): { rows: string[][]; totalRow: number | null } {
  const out: string[][] = []; let totalRow: number | null = null;
  for (const row of matrix) {
    const nonEmpty = row.filter((c) => String(c ?? '').trim() !== '');
    if (!nonEmpty.length) continue;
    const first = String(row[0] ?? '').trim();
    if (/^(итог|всего|сумма|общая|результат)/i.test(first) && nonEmpty.length <= 3) {
      for (const c of nonEmpty) { const n = parseFloat(String(c).replace(/[\s\u00A0]/g, '').replace(',', '.')); if (isFinite(n) && n > 0) totalRow = n; }
      continue;
    }
    if (nonEmpty.length === 1 && row.length > 1) continue;
    out.push(row);
  }
  return { rows: out, totalRow };
}

function guessMapping(headers: string[]) {
  const used = new Set<number>(); const mapping: Record<string, number> = {};
  for (const [key, re] of RULES) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(String(h)));
    if (i >= 0) { mapping[key] = i; used.add(i); }
  }
  return mapping;
}
function rowProblems(r: VedRow): string[] {
  const p: string[] = [];
  if (!/^\d{20}$/.test(r.account)) p.push('счёт');
  if (!r.last) p.push('фамилия');
  const n = parseFloat(r.amount);
  if (!isFinite(n) || n <= 0) p.push('сумма');
  return p;
}

// ── Windows-1251 ─────────────────────────────────────────────────────
const CP: Record<number, number> = (() => {
  const t: Record<number, number> = {};
  for (let i = 0; i < 64; i++) { t[0x410 + i] = 0xc0 + i; t[0x430 + i] = 0xe0 + i; }
  Object.assign(t, { 0x401: 0xa8, 0x451: 0xb8, 0x2116: 0xb9, 0xa0: 0xa0, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2026: 0x85, 0x2022: 0x95, 0xab: 0xab, 0xbb: 0xbb });
  return t;
})();
function enc1251(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i] = c < 128 ? c : (CP[c] !== undefined ? CP[c] : 0x3f);
  }
  return out;
}

// ── OCR (tesseract.js с CDN, лениво) ─────────────────────────────────
let tessPromise: Promise<void> | null = null;
function loadTesseract(): Promise<void> {
  if ((window as unknown as { Tesseract?: unknown }).Tesseract) return Promise.resolve();
  return (tessPromise ??= new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => ok();
    s.onerror = () => { tessPromise = null; no(new Error('не удалось загрузить OCR-модель — проверьте интернет')); };
    document.head.appendChild(s);
  }));
}

// ── Парсер строк (OCR/TXT): «ФИО СЧЁТ СУММА» ─────────────────────────
function parseTextLines(text: string): string[][] {
  const rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = String(raw).replace(/[|*_#„“”"«»<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const tokens0 = line.split(' ');
    let account = '';
    const keep: string[] = [];
    for (let i = 0; i < tokens0.length; i++) {
      const t = tokens0[i];
      if (!account && /^[\d ]+$/.test(t)) {
        let j = i, d = 0; const run: string[] = [];
        while (j < tokens0.length && /^[\d ]+$/.test(tokens0[j])) {
          run.push(tokens0[j]); d += digits(tokens0[j]).length;
          if (d >= 20) break;
          j++;
        }
        if (d === 20) { account = run.join('').replace(/\D/g, ''); i = j; continue; }
      }
      keep.push(t);
    }
    let amount = '';
    for (let i = 0; i < keep.length; i++) {
      const c1 = keep[i].replace(/[\s ]/g, '').replace(',', '.');
      if (/^\d{1,3}$/.test(c1) && i + 1 < keep.length && /[.,]/.test(keep[i + 1])) {
        const c2 = keep[i + 1].replace(/[\s ]/g, '').replace(',', '.');
        if (/^\d{1,6}[.]\d{1,2}$/.test(c2)) { amount = c1 + c2; keep.splice(i, 2); i--; continue; }
      }
      if (!amount && /^\d{1,9}([.]\d{1,2})?$/.test(c1) && /[.,]/.test(keep[i])) { amount = c1; keep.splice(i, 1); i--; }
    }
    if (!amount) {
      for (let i = keep.length - 1; i >= 0; i--) {
        const clean = keep[i].replace(/[\s ]/g, '').replace(',', '.');
        if (/^\d{1,6}([.]\d{1,2})?$/.test(clean)) { amount = clean; keep.splice(i, 1); break; }
      }
    }
    while (keep.length && /^\d+$/.test(keep[keep.length - 1].replace(/[\s ]/g, ''))) keep.pop();
    const fio = keep.join(' ').replace(/^[\-–—.:]+|[\-–—.:]+$/g, '').trim();
    if (fio || account) rows.push([fio, account, amount]);
  }
  return rows;
}

// ── Чтение любого файла в строки ─────────────────────────────────────
async function extractRows(file: File): Promise<{ rows: string[][]; headers: string[]; ocr?: boolean }> {
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name)) {
    await loadTesseract();
    const T = (window as unknown as { Tesseract: { createWorker(lang: string): Promise<{ recognize(f: File): Promise<{ data: { text: string } }>; terminate(): Promise<void> }> } }).Tesseract;
    const worker = await T.createWorker('rus');
    try {
      const { data } = await worker.recognize(file);
      return { rows: parseTextLines(data.text), headers: ['ФИО (распознано)', 'Счет', 'Сумма'], ocr: true };
    } finally { await worker.terminate(); }
  }
  if (name.endsWith('.txt')) return { rows: parseTextLines(await file.text()), headers: ['ФИО', 'Счет', 'Сумма'] };
  const XLSX = await loadXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('в файле нет листов');
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false }) as unknown as unknown[][];
  const rawM = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true }) as unknown as unknown[][];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      const rv = rawM[r] ? rawM[r][c] : undefined;
      if (typeof rv === 'number' && isFinite(rv) && Math.abs(rv) >= 1e15 && String(matrix[r][c]).replace(/\D/g, '').length !== 20)
        matrix[r][c] = expandNumber(rv);
    }
  }
  if (!matrix.length) throw new Error('файл пустой');
  const first = matrix[0].map((c) => String(c).trim());
  const looksHeader = first.some((c) => /[A-Za-zА-Яа-яЁё]/.test(c));
  if (looksHeader) return { rows: matrix.slice(1) as string[][], headers: first };
  return { rows: matrix as string[][], headers: first.map((_, i) => `Колонка ${i + 1}`) };
}

// ── Обновление состава комиссии в базе приложения ────────────────────
async function updateCommissionMembers(commId: number, mem: { fio: string; role: Role }[]) {
  const incoming = new Map(mem.map((m) => [normFio(m.fio), m.role]));
  return db.transaction('rw', db.members, async () => {
    const existing = await db.members.where('commissionId').equals(commId).toArray();
    let upgraded = 0, deleted = 0, updated = 0;
    for (const m of existing) {
      const key = normFio(m.fio);
      if (m.source === 'demo') {
        if (incoming.has(key)) { await db.members.update(m.id, { source: 'official', role: incoming.get(key)! }); upgraded++; }
        else { await db.members.delete(m.id); deleted++; }
      } else if (incoming.has(key) && m.role !== incoming.get(key)) {
        await db.members.update(m.id, { role: incoming.get(key)! }); updated++;
      }
    }
    const have = new Set(existing.map((m) => normFio(m.fio)));
    const fresh = mem.filter((m) => !have.has(normFio(m.fio)))
      .map((m) => ({ commissionId: commId, fio: m.fio, role: m.role, status: 'нештатный', rate: RATES[m.role], source: 'official' }));
    if (fresh.length) await db.members.bulkAdd(fresh as Member[]);
    return { total: mem.length, added: fresh.length, upgraded, deleted, updated };
  });
}

function detectUikColumn(headers: string[], rows: string[][]): number {
  let best = -1, bestScore = 0;
  headers.forEach((h, i) => {
    let score = /уик|комисси/i.test(String(h)) ? 3 : 0;
    let nums = 0; const tests = Math.min(rows.length, 25);
    for (let r = 0; r < tests; r++) if (/^(уик\s*)?№?\s*\d{1,4}$/i.test(String(rows[r]?.[i] ?? '').trim())) nums++;
    score += (nums / tests) * 3;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore >= 2 ? best : -1;
}

const stamp = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 400);
}
function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── Хранилище: реестр + черновик ─────────────────────────────────────
function loadReg(): RegEntry[] { try { return JSON.parse(localStorage.getItem(REG_KEY) || '[]'); } catch { return []; } }
function saveReg(r: RegEntry[]) { try { localStorage.setItem(REG_KEY, JSON.stringify(r.slice(0, 20))); } catch { /* quota */ } }
function loadDraft(): Draft | null { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } }

// ═════════════════════════════════════════════════════════════════════
export default function SberPay() {
  const [headers, setHeaders] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<VedRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [info, setInfo] = useState('Excel (.xlsx/.xls), CSV, TXT или фото/скан (.png/.jpg) — с распознаванием текста, включая аккуратный рукописный');
  const [appliedSum, setAppliedSum] = useState(0);
  const [manOpen, setManOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [expMenu, setExpMenu] = useState(0);
  const [expRegId, setExpRegId] = useState(0);
  const [tpl, setTpl] = useState(() => { try { return localStorage.getItem(TPL_KEY) || 'sber'; } catch { return 'sber'; } });
  const [master, setMaster] = useState<{ name: string; rows: { fio: string; account: string; amount: string }[] }>(() => {
    try { return JSON.parse(localStorage.getItem(MASTER_KEY) || '{\"name\":\"\",\"rows\":[]}'); } catch { return { name: '', rows: [] }; }
  });
  const [registry, setRegistry] = useState<RegEntry[]>(() => loadReg());
  const [check, setCheck] = useState<Issue[] | null>(null);
  const [updCommId, setUpdCommId] = useState(0);
  const [updResult, setUpdResult] = useState('');
  const [uState, setUState] = useState<{ headers: string[]; matrix: string[][]; mapping: Record<string, number>; uikCol: number; fileName: string } | null>(null);
  const [uInfo, setUInfo] = useState('Файл не выбран');
  const [uikManualId, setUikManualId] = useState(0);
  const [uikReport, setUikReport] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const masterRef = useRef<HTMLInputElement>(null);
  const tableFileRef = useRef<HTMLInputElement>(null);
  const uikFileRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  const commissions = useLiveQuery(() => db.commissions.toArray(), []);
  const uiks = useMemo(() => (commissions ?? []).filter((c) => c.level === 'UIK').sort((a, b) => (a.uikNo || 0) - (b.uikNo || 0)), [commissions]);

  // Автосохранение общего списка
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (!master.rows.length) localStorage.removeItem(MASTER_KEY);
        else localStorage.setItem(MASTER_KEY, JSON.stringify(master));
      } catch { /* quota */ }
    }, 800);
    return () => clearTimeout(t);
  }, [master]);

  async function onMasterFile(file: File) {
    try {
      const { rows: mtx, headers: hdrs, ocr } = await extractRows(file);
      if (!mtx.length) throw new Error('не найдены строки с данными');
      const mp = guessMapping(hdrs);
      const get = (row: string[], key: string) => { const i = mp[key]; return (i == null || i < 0) ? '' : row[i]; };
      const out = mtx.map((row) => {
        let fio = '';
        if (mp.fio != null && mp.fio >= 0) fio = String(get(row, 'fio')).trim();
        else fio = [get(row, 'last'), get(row, 'first'), get(row, 'middle')].map((x) => String(x).trim()).filter(Boolean).join(' ');
        return { fio, account: digits(get(row, 'account')), amount: normAmount(get(row, 'amount')) };
      }).filter((r) => r.fio || r.account);
      setMaster({ name: file.name, rows: out });
      setInfo(`${file.name} · общий список: ${out.length} строк${ocr ? ' · OCR' : ''}`);
    } catch (e) { setInfo('Ошибка чтения общего списка: ' + (e instanceof Error ? e.message : String(e))); }
  }

  // Фоновая загрузка обновлений: баннер «Доступно обновление»
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const prompt = (reg: ServiceWorkerRegistration) => {
      if (!reg.waiting) return;
      reg.waiting.addEventListener('statechange', (e) => {
        if ((e.target as ServiceWorker).state === 'activated') window.location.reload();
      });
      setUpdateReady(true);
    };
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) {
        if (reg.waiting) prompt(reg);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) prompt(reg);
          });
        });
      }
    });
    const t = setInterval(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg?.waiting) prompt(reg);
      });
    }, 120000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Восстановление черновика при первом открытии
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const d = loadDraft();
    if (d && d.rows?.length) {
      setRows(d.rows);
      setAppliedSum(d.appliedSum || 0);
      setFileName(d.name || '');
      setInfo(`Восстановлен черновик от ${d.date}${d.name ? ' · ' + d.name : ''} — продолжайте правку или загрузите новый файл`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Автосохранение черновика
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (!rows.length) localStorage.removeItem(DRAFT_KEY);
        else localStorage.setItem(DRAFT_KEY, JSON.stringify({ rows, appliedSum, name: fileName, date: new Date().toLocaleString('ru-RU') } satisfies Draft));
      } catch { /* quota */ }
    }, 800);
    return () => clearTimeout(t);
  }, [rows, appliedSum, fileName]);

  const totals = useMemo(() => {
    let sum = 0, cnt = 0, bad = 0;
    for (const r of rows) {
      const n = parseFloat(r.amount);
      if (isFinite(n) && n > 0) { sum += n; cnt++; }
      if (rowProblems(r).length) bad++;
    }
    return { sum, cnt, bad };
  }, [rows]);

  const dupAccounts = useMemo(() => {
    const seen = new Map<string, number>();
    rows.forEach((r) => { if (r.account) seen.set(r.account, (seen.get(r.account) || 0) + 1); });
    return seen;
  }, [rows]);

  function applyMapping(_hdrs: string[], mtx: string[][], mp: Record<string, number>) {
    const get = (row: string[], key: string) => { const i = mp[key]; return (i == null || i < 0) ? '' : row[i]; };
    const out: VedRow[] = mtx.map((row) => {
      const r: VedRow = {
        account: digits(get(row, 'account')),
        last: '', first: '', middle: '',
        amount: normAmount(get(row, 'amount')),
        deduct: normAmount(get(row, 'deduct')) || '0.00',
      };
      if (mp.fio != null && mp.fio >= 0) Object.assign(r, splitFio(normFioCase(String(get(row, 'fio')).trim())));
      else {
        r.last = String(get(row, 'last')).trim();
        r.first = String(get(row, 'first')).trim();
        r.middle = String(get(row, 'middle')).trim();
      }
      return r;
    }).filter((r) => r.account || r.last || parseFloat(r.amount) > 0);
    let out2 = out;
    if (tpl !== 'sber') {
      const R: Record<string, number> = { chair: 63, deputy: 57, secretary: 57, member: 45 };
      let filled = 0;
      out2 = out.map((r) => {
        const role = (r as unknown as { __role?: string }).__role;
        if ((!r.amount || parseFloat(r.amount) <= 0) && role && R[role]) { filled++; return { ...r, amount: R[role].toFixed(2) }; }
        return r;
      });
      if (filled) setInfo((i) => i + ` · автозаполнение по шаблону ${tpl.toUpperCase()}: сумм по ставкам ЦИК — ${filled}`);
    }
    setRows(out2);
    setAppliedSum(out2.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0));
    const reg = loadReg();
    const t = (() => { let s = 0, b = 0; for (const r of out) { const n = parseFloat(r.amount); if (isFinite(n) && n > 0) s += n; if (rowProblems(r).length) b++; } return { s, b }; })();
    reg.unshift({ id: Date.now(), name: fileName || 'без имени', date: new Date().toLocaleString('ru-RU'), kind: 'table', rows: out.map((r) => ({ ...r })), count: out.length, sum: t.s.toFixed(2), bad: t.b });
    saveReg(reg);
    setRegistry(reg);
    return out;
  }

  async function onFile(file: File) {
    try {
      const { rows: mtx, headers: hdrs, ocr } = await extractRows(file);
      if (!mtx.length) throw new Error('не найдены строки с данными');
      const sm = smartMapping(hdrs, mtx);
      const mp = sm.mapping;
      setHeaders(hdrs); setMatrix(mtx); setMapping(mp); setFileName(file.name); setCheck(null);
      setInfo(`${file.name} · ${mtx.length} строк${ocr ? ' · OCR (сверьте вручную)' : ''}`);
      applyMapping(hdrs, mtx, mp);
      setTimeout(() => void autoExcelSave(file.name), 600);
    } catch (e) {
      setInfo('Ошибка чтения: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  function setCell(i: number, k: keyof VedRow, v: string) {
    setRows((rs) => {
      const nr = [...rs];
      const r = { ...nr[i] };
      if (k === 'account') r.account = digits(v);
      else if (k === 'amount' || k === 'deduct') r[k] = String(v).replace(',', '.');
      else r[k] = v;
      nr[i] = r;
      return nr;
    });
  }
  function blurCell(i: number, k: keyof VedRow, v: string) {
    if (k === 'amount' || k === 'deduct') {
      const n = parseFloat(v.replace(/[\s ]/g, '').replace(',', '.'));
      if (isFinite(n)) setCell(i, k, n.toFixed(2));
    }
    if (k === 'account') setCell(i, k, digits(v));
  }

  // ── Сверка ─────────────────────────────────────────────────────────
  function runCheck() {
    const issues: Issue[] = [];
    const reg = loadReg();
    const byAccount = new Map<string, Map<string, Set<string>>>();
    const byFio = new Map<string, Set<string>>();
    const addAcc = (acc: string, last: string, src: string) => {
      if (!acc || !/^\d{20}$/.test(acc)) return;
      if (!byAccount.has(acc)) byAccount.set(acc, new Map());
      const m = byAccount.get(acc)!;
      if (!m.has(last)) m.set(last, new Set());
      m.get(last)!.add(src);
    };
    const addFio = (fio: string, acc: string) => {
      const k = normFio(fio);
      if (!k) return;
      if (!byFio.has(k)) byFio.set(k, new Set());
      if (acc) byFio.get(k)!.add(acc);
    };
    const seenCur = new Map<string, number>();
    rows.forEach((r, i) => {
      const fio = [r.last, r.first, r.middle].join(' ');
      addAcc(r.account, r.last || `строка ${i + 1}`, 'текущая ведомость');
      addFio(fio, r.account);
      if (!r.last) issues.push({ l: 'e', t: `Строка ${i + 1}: пустая фамилия` });
      else {
        if (/[A-Za-z]/.test(fio)) issues.push({ l: 'w', t: `Строка ${i + 1}: латиница в ФИО «${fio.trim()}»` });
        const k = normFio(fio);
        if (seenCur.has(k)) issues.push({ l: 'w', t: `«${fio.trim()}» встречается в ведомости 2 раза (строки ${seenCur.get(k)! + 1} и ${i + 1})` });
        else seenCur.set(k, i);
      }
      if (r.account && !/^\d{20}$/.test(r.account)) issues.push({ l: 'e', t: `Строка ${i + 1}: счёт «${r.account}» — не 20 цифр` });
    });
    reg.forEach((e) => (e.rows || []).forEach((r) => {
      addAcc(r.account, r.last || e.name, e.name);
      addFio([r.last, r.first, r.middle].join(' '), r.account);
    }));
    for (const [acc, m] of byAccount) {
      if (m.size > 1) {
        const fams = [...m.keys()].filter((f) => !/^строка /.test(f)).slice(0, 4).join(', ');
        issues.push({ l: 'e', t: `Счёт ${acc} числится на разные фамилии: ${fams} — проверьте, чей это счёт` });
      }
    }
    for (const [k, accs] of byFio) {
      if (accs.size > 1) issues.push({ l: 'w', t: `${k} — разные счета: ${[...accs].join(', ')} (возможна смена счёта — уточните актуальный)` });
    }
    setCheck(issues);
  }

  // ── Обновление списков УИК (отдельная кнопка) ──────────────────────
  async function onUikFile(file: File) {
    setUInfo('Чтение файла…');
    try {
      const { rows: mtx, headers: hdrs, ocr } = await extractRows(file);
      if (!mtx.length) throw new Error('не найдены строки с данными');
      const mp = guessMapping(hdrs);
      const col = detectUikColumn(hdrs, mtx);
      setUState({ headers: hdrs, matrix: mtx, mapping: mp, uikCol: col, fileName: file.name });
      setUInfo(`${file.name} · ${mtx.length} строк · колонка УИК: ${col >= 0 ? '"' + hdrs[col] + '"' : 'не найдена — выберите комиссию вручную'}${ocr ? ' · OCR (сверьте вручную)' : ''}`);
    } catch (e) {
      setUState(null);
      setUInfo('Ошибка чтения: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
  async function runUikUpdate() {
    if (!uState) { setUInfo('Сначала выберите файл состава.'); return; }
    const comms = uiks;
    const numFromRef = (v: unknown) => { const m = String(v ?? '').match(/\d{1,4}/); return m ? +m[0] : null; };
    if (uState.uikCol < 0 && !uikManualId) { setUInfo('Колонка УИК не найдена — выберите комиссию вручную.'); return; }
    const groups = new Map<number, { fio: string; role: Role }[]>();
    const skipped: string[] = [];
    for (const row of uState.matrix) {
      const get = (k: string) => { const i = uState.mapping[k]; return (i == null || i < 0) ? '' : row[i]; };
      let fio = '';
      if (uState.mapping.fio != null && uState.mapping.fio >= 0) fio = String(get('fio')).trim();
      else fio = [get('last'), get('first'), get('middle')].map((x) => String(x).trim()).filter(Boolean).join(' ');
      if (!fio) continue;
      const role = mapRole(get('role'));
      let cid = uikManualId || 0;
      if (!cid && uState.uikCol >= 0) {
        const n = numFromRef(row[uState.uikCol]);
        if (n != null) {
          const c = comms.find((x) => x.uikNo === n) || comms.find((x) => String(x.code).includes(String(n)));
          cid = c ? c.id : 0;
        }
      }
      if (!cid) { skipped.push(fio); continue; }
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push({ fio, role });
    }
    if (!groups.size) { setUInfo('Не удалось сопоставить ни одного человека с комиссией.' + (skipped.length ? ' Без УИК: ' + skipped.slice(0, 5).join(', ') : '')); return; }
    setUikReport(`Обновление ${groups.size} комиссий…`);
    const lines: string[] = [];
    for (const [cid, mem] of groups) {
      const c = comms.find((x) => x.id === cid);
      try {
        const st = await updateCommissionMembers(cid, mem);
        lines.push(`${c ? c.code : cid}: ${st.total} чел. — добавлено ${st.added}, демо→актуальные ${st.upgraded}, демо удалено ${st.deleted}, роли ${st.updated}`);
      } catch (e) { lines.push(`${c ? c.code : cid}: ошибка — ${e instanceof Error ? e.message : e}`); }
    }
    if (skipped.length) lines.push(`Без совпавшей комиссии (${skipped.length}): ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? '…' : ''}`);
    setUikReport('Готово.\n' + lines.join('\n'));
  }
  // Обновление состава из шага 2 (текущий загруженный файл)
  async function runStepUpdate() {
    if (!updCommId) { setUpdResult('Выберите комиссию.'); return; }
    const get = (row: string[], key: string) => { const i = mapping[key]; return (i == null || i < 0) ? '' : row[i]; };
    const mem: { fio: string; role: Role }[] = [];
    for (const row of matrix) {
      let fio = '';
      if (mapping.fio != null && mapping.fio >= 0) fio = String(get(row, 'fio')).trim();
      else fio = [get(row, 'last'), get(row, 'first'), get(row, 'middle')].map((x) => String(x).trim()).filter(Boolean).join(' ');
      if (fio) mem.push({ fio, role: mapRole(get(row, 'role')) });
    }
    if (!mem.length) { setUpdResult('Не удалось собрать ФИО из файла — проверьте сопоставление колонок.'); return; }
    setUpdResult('Обновление…');
    try {
      const st = await updateCommissionMembers(updCommId, mem);
      setUpdResult(`Готово: ${st.total} человек из файла. Добавлено новых: ${st.added}, демо переведено в актуальные: ${st.upgraded}, демо удалено: ${st.deleted}, роли уточнены: ${st.updated}.`);
    } catch (e) { setUpdResult('Ошибка обновления: ' + (e instanceof Error ? e.message : e)); }
  }

  // ── Экспорт ────────────────────────────────────────────────────────
  async function autoExcelSave(nm0?: string) {
    if (!rows.length) return;
    const XLSX = await loadXlsx();
    const nm = (nm0 || fileName || 'vedomost').replace(/\.[^.]+$/, '').replace(/[^\w\u0400-\u04FF\-]+/g, '_').slice(0, 40) || 'vedomost';
    const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows.map((r) => [r.account, r.last, r.first, r.middle, parseFloat(r.amount) || 0, parseFloat(r.deduct) || 0])]);
    const range = XLSX.utils.decode_range(ws['!ref']!);
    for (let r = 1; r <= range.e.r; r++) {
      const acc = ws[XLSX.utils.encode_cell({ r, c: 0 })];
      if (acc) acc.z = '@';
      for (const c of [4, 5]) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && typeof cell.v === 'number') cell.z = '#,##0.00'; }
    }
    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ведомость');
    download(`ved_SBER_${nm}_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  async function downloadControlForm(kind?: string) {
    const XLSX = await loadXlsx();
    const k = kind || tpl;
    if (k === 'uik' || k === 'tik') {
      const isUik = k === 'uik';
      const aoa: unknown[][] = [
        ["КОНТРОЛЬНАЯ ФОРМА"],
        [`к ведомости на выплату вознаграждения членам ${isUik ? "участковой" : "территориальной"} избирательной комиссии`],
        [],
        [`${isUik ? "Участковая избирательная комиссия № ______" : "Территориальная избирательная комиссия"}`, "", "", "Наименование выборов/период:", ""],
        ["", "", "", "Дата составления:", ""],
        [],
        ["№ п/п", "Фамилия, имя, отчество", "Должность", "Ставка вознаграждения, руб.", "Кол-во дней (смен)", "Сумма, руб.", "Подпись"],
      ];
      for (let i = 1; i <= 10; i++) aoa.push([i, "", "", "", "", "", ""]);
      aoa.push([], ["", "", "", "", "ИТОГО:", "", ""], [], ["Сумма прописью:", "", "", "", "", "", ""], [],
        ["Председатель комиссии: _________ / ________________ /", "", "", "", "Секретарь: _________ / ________________ /", "", ""], [], ["М.П."], [],
        isUik ? ["Отметка ТИК о согласовании:", "", "", "", "", "", ""] : ["Согласовано с избирательной комиссией субъекта РФ:", "", "", "", "", "", ""], [],
        ["Примечание: ставки вознаграждения — по постановлению ЦИК России (председатель — 63, заместитель и секретарь — 57, член — 45 за день работы)."],
        ["Форма — рабочий шаблон по структуре контрольных форм, применяемых при выплате вознаграждений членам избирательных комиссий; реквизиты события заполняются вручную."]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 16 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Контрольная форма');
      download(`kontrolnaya_forma_${k.toUpperCase()}_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      return;
    }
    const aoa: unknown[][] = [
      ["ПАО СБЕРБАНК"],
      ["КОНТРОЛЬНАЯ ФОРМА ВЕДОМОСТИ"],
      [],
      ["Организация:", "", "", "№ ведомости:", "", "Дата составления:", ""],
      ["Счёт организации:", "", "", "ИНН:", "", "КПП:", ""],
      [],
      ["№ п/п", "Фамилия", "Имя", "Отчество", "№ счёта получателя", "Сумма, руб.", "Подпись получателя"],
    ];
    for (let i = 1; i <= 10; i++) aoa.push([i, "", "", "", "", "", ""]);
    aoa.push([], ["", "", "", "", "ИТОГО:", "", ""], [], ["Сумма прописью:", "", "", "", "", "", ""], [],
      ["Руководитель организации: _________ / ________________ /", "", "", "", "Главный бухгалтер: _________ / ________________ /", "", ""], [], ["М.П."], [],
      ["Примечание: форма соответствует требованиям Сбербанка к оформлению ведомости на выплату (зарплатный проект)."],
      ["Счёт получателя — 20 цифр, текстовый формат; сумма — в рублях с копейками, разделитель точка."]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Контрольная форма');
    download(`kontrolnaya_forma_SBER_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  function saveCurrentVed() {
    if (!rows.length) { alert('Ведомость пустая — нечего сохранять.'); return; }
    let name = fileName || '';
    if (!name) { name = prompt('Название для сохранения в реестре:', 'Ведомость ' + new Date().toLocaleDateString('ru-RU')) || ''; if (!name) return; setFileName(name); }
    const tSum = rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
    const tBad = rows.filter((r) => rowProblems(r).length).length;
    const reg = loadReg();
    const ex = reg.find((e) => e.name === name);
    const entry = { id: ex ? ex.id : Date.now(), name, date: new Date().toLocaleString('ru-RU'), kind: 'table', rows: rows.map((r) => ({ ...r })), count: rows.length, sum: tSum.toFixed(2), bad: tBad };
    const next = ex ? reg.map((e) => e.id === ex.id ? entry : e) : [entry, ...reg];
    saveReg(next); setRegistry(next);
    setInfo((ex ? 'Запись обновлена' : 'Сохранено в реестр') + `: «${name}» · ${entry.count} чел. · ${entry.sum} ₽`);
  }
  function deleteCurrentVed() {
    if (!rows.length && !fileName) { alert('Нечего удалять.'); return; }
    if (!confirm(`Удалить текущую ведомость${fileName ? ` «${fileName}»` : ''}? Запись в реестре (если есть) тоже будет удалена.`)) return;
    if (fileName) { const reg = loadReg().filter((e) => e.name !== fileName); if (reg.length !== loadReg().length) { saveReg(reg); setRegistry(reg); } }
    setRows([]); setFileName(''); setAppliedSum(0);
    localStorage.removeItem(DRAFT_KEY);
    setInfo('Ведомость удалена. Загрузите файл или откройте запись из реестра.');
  }

  function exportSourceRows(): VedRow[] {
    if (!expRegId) return rows;
    const en = registry.find((x) => x.id === expRegId);
    return en ? (en.rows || []) : rows;
  }
  function guard(): boolean {
    if (totals.bad) { alert(`В ведомости ${totals.bad} строк с ошибками (красные). Исправьте счёт/фамилию/сумму — банк такой файл не примет.`); return false; }
    if (!rows.length) { alert('Ведомость пустая.'); return false; }
    return true;
  }
  function csvText(): string {
    return [HEADER.map(csvEscape).join(';')]
      .concat(rows.map((r) => [r.account, r.last, r.first, r.middle, r.amount || '0.00', r.deduct || '0.00'].map(csvEscape).join(';')))
      .join('\r\n');
  }
  async function exportCsv(encoding: '1251' | 'utf8') {
    const src = exportSourceRows();
    if (!src.length || src.some((r) => rowProblems(r).length > 0)) { guard(); return; }
    if (encoding === '1251') download(`ved_SBER_${stamp()}.csv`, new Blob([enc1251(csvText()).buffer as ArrayBuffer], { type: 'application/csv;charset=windows-1251' }));
    else download(`ved_SBER_${stamp()}.csv`, new Blob(['﻿' + csvText()], { type: 'application/csv;charset=utf-8' }));
  }
  async function exportXlsx() {
    const src = exportSourceRows();
    if (!src.length || src.some((r) => rowProblems(r).length > 0)) { guard(); return; }
    const XLSX = await loadXlsx();
    const aoa = [HEADER, ...rows.map((r) => [r.account, r.last, r.first, r.middle, parseFloat(r.amount) || 0, parseFloat(r.deduct) || 0])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const range = XLSX.utils.decode_range(ws['!ref']!);
    for (let r = 1; r <= range.e.r; r++) {
      const acc = ws[XLSX.utils.encode_cell({ r, c: 0 })];
      if (acc) acc.z = '@';
      for (const c of [4, 5]) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
      }
    }
    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ведомость');
    download(`ved_SBER_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  async function downloadSample() {
    const XLSX = await loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet([HEADER, ['40702810123450123456', 'Иванов', 'Иван', 'Иванович', 15000, 0], ['40702810987650432109', 'Петрова', 'Мария', 'Сергеевна', 22850.5, 0]]);
    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ведомость');
    download('obrazec_SBER_vedomost.xlsx', new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  const errCnt = check ? check.filter((x) => x.l === 'e').length : 0;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Ведомость Сбербанк <span className="opacity-35 text-[11px] font-normal">{VER}</span></h2>
          <button type="button" className="rounded-lg bg-slate-500/20 px-3 py-1 text-[12.5px] font-semibold" onClick={() => setManOpen((v) => !v)}>? Инструкция</button>
        </div>
        <p className="text-[12.5px] opacity-65">Реестр для импорта в Сбер Бизнес Онлайн (юрлица) · формат «Ведомость на счета»</p>
        {updateReady && (
          <div className="mt-2 rounded-[10px] border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-[13px] flex items-center justify-between gap-2">
            <span>Доступно обновление приложения — ведомость сохранена в черновике.</span>
            <button type="button" className="rounded-lg bg-blue-600 px-3 py-1 text-[12.5px] font-semibold text-white" onClick={() => {
              navigator.serviceWorker.getRegistration().then((reg) => { reg?.waiting?.postMessage({ type: 'SKIP_WAITING' }); });
              setTimeout(() => window.location.reload(), 2500);
            }}>Обновить сейчас</button>
          </div>
        )}
      </div>

      {manOpen && (
        <Card>
          <CardHead>Как работать с вкладкой</CardHead>
          <ol className="list-decimal pl-5 text-[13px] space-y-1.5">
            <li><b>Загрузите файл</b>: .xlsx, .xls, .csv, .txt или фото/скан (.png/.jpg) — текст распознаётся автоматически, включая аккуратный рукописный (после OCR сверьте ведомость вручную). Ведомость сформируется автоматически.</li>
            <li><b>Проверьте распознавание.</b> Если колонки определились неверно — поправьте списки ниже и нажмите «Применить» ещё раз.</li>
            <li><b>«Обновление списков УИК»</b> — отдельная кнопка: загрузите состав (Excel/CSV/TXT/фото) — по колонке с номером УИК списки всех комиссий обновятся автоматически, демонстрационные данные заменятся.</li>
            <li><b>Реестр файлов</b>: каждая загрузка сохраняется — «Открыть» вернёт её ведомость, «Сверка ФИО и счетов» проверит: счёт на разные фамилии, дубли людей, разные счёта одного человека между файлами.</li>
            <li><b>Проверьте ведомость:</b> тап по ячейке — правка. 🔴 красная строка — ошибка (счёт ≠ 20 цифр, пустая сумма/фамилия), выгрузка заблокирована. 🟡 жёлтая — дубль счёта. Внизу — итоги: получателей и сумма; сверьте со сметой до копейки.</li>
            <li><b>«⬇ Выгрузить в Сбербанк»</b> — файл CSV Windows-1251 (разделитель «;»), родной формат «Ведомость на счета». Запасные варианты: CSV UTF-8, XLSX, образец.</li>
            <li><b>Импорт в банк:</b> Сбер Бизнес Онлайн → Зарплатный проект → Импорт ведомости → сверьте количество получателей и итог по предпросмотру → подпишите.</li>
          </ol>
          <p className="text-[13px] mt-2"><b>Правила файла:</b> счёт — ровно 20 цифр (в Сбербанке, в рублях); сумма — с точкой: 15000.00; удержаний нет — стоит 0.00.</p>
          <p className="text-[13px] mt-1"><b>Проблемы:</b> кракозябры → качайте CSV-1251 (кнопка по умолчанию); колонки съехали → разделитель «;»; «счёт не найден» → не 20 цифр или другой банк (для карт чужих банков — «Массовые переводы», другой шаблон).</p>
        </Card>
      )}

      {/* Реестр загруженных файлов */}
      <Card>
        <CardHead>
          <span className="flex items-center justify-between w-full">
            Реестр загруженных файлов
            <select value={tpl} onChange={(e) => { setTpl(e.target.value); try { localStorage.setItem(TPL_KEY, e.target.value); } catch { /* */ } }} className="rounded-lg border border-slate-400/40 bg-transparent px-2 py-1 text-[12px]">
              <option value="sber">КФ — Сбербанк</option>
              <option value="uik">КФ — УИК</option>
              <option value="tik">КФ — ТИК</option>
            </select>
            <button type="button" className="rounded-lg bg-slate-500/20 px-2.5 py-1 text-[12px]" onClick={() => void downloadControlForm()}>Скачать форму</button>
            <button type="button" className="rounded-lg bg-slate-500/20 px-2.5 py-1 text-[12px]" onClick={runCheck}>Сверка ФИО и счетов</button>
          </span>
        </CardHead>
        {registry.length === 0 && <p className="text-[12.5px] opacity-60">Пока пусто — загрузите файл, он попадёт в реестр автоматически</p>}
        <div className="flex flex-col gap-2">
          {registry.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2.5 rounded-[10px] border border-slate-400/25 px-3 py-2">
              <div className="text-[13px] min-w-0">
                <b>{e.name}</b><br />
                <span className="text-[11.5px] opacity-65">{e.date} · {e.count} чел. · {e.sum} ₽{e.bad ? <> · <span className="rounded bg-red-600/85 text-white px-1.5 text-[11px]">ошибок: {e.bad}</span></> : ''}{e.kind === 'image' ? ' · фото/OCR' : ''}</span>
              </div>
              <div className="flex gap-1.5 shrink-0 items-center flex-wrap justify-end">
                <button type="button" className="rounded-lg bg-slate-500/20 px-2.5 py-1 text-[12px]" onClick={() => { setRows(JSON.parse(JSON.stringify(e.rows))); setAppliedSum(parseFloat(e.sum) || 0); setFileName(e.name); }}>Правка</button>
                <button type="button" className="rounded-lg bg-slate-500/20 px-2.5 py-1 text-[12px]" onClick={() => sendRegEntry(e)}>Отправить</button>
                <button type="button" className="rounded-lg bg-slate-500/20 px-2.5 py-1 text-[12px]" onClick={() => setExpMenu(expMenu === e.id ? 0 : e.id)}>Экспорт</button>
                <button type="button" className="px-1.5 text-[15px] opacity-50" title="Удалить из реестра" onClick={() => { const r = loadReg().filter((x) => x.id !== e.id); saveReg(r); setRegistry(r); }}>×</button>
              </div>
              {expMenu === e.id && (
                <div className="w-full flex flex-wrap gap-1.5 mt-1.5 pt-1.5 border-t border-dashed border-slate-400/25">
                  <button type="button" className="rounded-lg border border-slate-400/40 bg-slate-500/10 px-2.5 py-1 text-[12px]" onClick={() => exportRegEntry(e, 'csv1251')}>CSV Сбербанк Онлайн (1251)</button>
                  <button type="button" className="rounded-lg border border-slate-400/40 bg-slate-500/10 px-2.5 py-1 text-[12px]" onClick={() => exportRegEntry(e, 'csvutf')}>CSV UTF-8</button>
                  <button type="button" className="rounded-lg border border-slate-400/40 bg-slate-500/10 px-2.5 py-1 text-[12px]" onClick={() => exportRegEntry(e, 'xlsx')}>XLSX</button>
                  <button type="button" className="rounded-lg border border-slate-400/40 bg-slate-500/10 px-2.5 py-1 text-[12px]" onClick={() => exportRegEntry(e, 'txt')}>TXT</button>
                </div>
              )}
            </div>
          ))}
        </div>
        {check && (
          <div className="text-[12.5px] mt-2">
            <b>Сверка:</b> {check.length ? <>ошибок — {errCnt}, замечаний — {check.length - errCnt}.</> : 'конфликтов не найдено — ФИО и счета согласованы.'}
            {check.length > 0 && (
              <ul className="mt-1">
                {check.slice(0, 50).map((x, i) => (
                  <li key={i} className={x.l === 'e' ? 'text-red-400' : 'text-amber-300'}>{x.l === 'e' ? '✖' : '⚠'} {x.t}</li>
                ))}
                {check.length > 50 && <li>…и ещё {check.length - 50}</li>}
              </ul>
            )}
          </div>
        )}
      </Card>

  function csvTextFrom(rows: VedRow[]): string {
    return [HEADER.map(csvEscape).join(';')]
      .concat(rows.map((r) => [r.account, r.last, r.first, r.middle, r.amount || '0.00', r.deduct || '0.00'].map(csvEscape).join(';')))
      .join('\r\n');
  }
  function exportRegEntry(e: RegEntry, fmt: string) {
    const rows = e.rows || [];
    if (!rows.length) { alert('В записи нет строк.'); return; }
    const nm = (e.name || 'vedomost').replace(/\.[^.]+$/, '').replace(/[^\w\u0400-\u04FF\-]+/g, '_').slice(0, 40) || 'vedomost';
    if (fmt === 'csv1251') download(`ved_SBER_${nm}_${stamp()}.csv`, new Blob([enc1251(csvTextFrom(rows)).buffer as ArrayBuffer], { type: 'application/csv;charset=windows-1251' }));
    else if (fmt === 'csvutf') download(`ved_SBER_${nm}_${stamp()}.csv`, new Blob(['\uFEFF' + csvTextFrom(rows)], { type: 'application/csv;charset=utf-8' }));
    else if (fmt === 'xlsx') void (async () => {
      const XLSX = await loadXlsx();
      const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows.map((r) => [r.account, r.last, r.first, r.middle, parseFloat(r.amount) || 0, parseFloat(r.deduct) || 0])]);
      ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 24 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Ведомость');
      download(`ved_SBER_${nm}_${stamp()}.xlsx`, new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    })();
    else if (fmt === 'txt') {
      const txt = rows.map((r, i) => `${i + 1}. ${[r.last, r.first, r.middle].join(' ').trim()} — счёт ${r.account || '—'}, сумма ${r.amount || '—'}`).join('\n');
      download(`spisok_${nm}_${stamp()}.txt`, new Blob(['\uFEFF' + txt], { type: 'text/plain;charset=utf-8' }));
    }
    setExpMenu(0);
  }
  async function sendRegEntry(e: RegEntry) {
    const rows = e.rows || [];
    if (!rows.length) { alert('В записи нет строк.'); return; }
    const nm = (e.name || 'vedomost').replace(/\.[^.]+$/, '').replace(/[^\w\u0400-\u04FF\-]+/g, '_').slice(0, 40) || 'vedomost';
    const blob = new Blob([enc1251(csvTextFrom(rows)).buffer as ArrayBuffer], { type: 'application/csv;charset=windows-1251' });
    const file = new File([blob], `ved_SBER_${nm}.csv`, { type: 'application/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Ведомость Сбербанк', text: `${rows.length} получателей, итого ${e.sum} ₽ (формат Сбербанк Онлайн)` }); return; } catch (err) { if ((err as Error).name === 'AbortError') return; }
    }
    download(file.name, blob);
    alert('Прямая отправка не поддерживается браузером — файл скачан, прикрепите вручную.');
  }

      {/* Общий список */}
      <Card>
        <CardHead>
          <span className="flex items-center justify-between w-full">
            Общий список
            <button type="button" className="rounded-lg bg-slate-500/20 px-2.5 py-1 text-[12px]" onClick={() => { if (confirm('Очистить общий список?')) setMaster({ name: '', rows: [] }); }}>Очистить</button>
          </span>
        </CardHead>
        <p className="text-[12px] opacity-60 mb-2">Мастер-список получателей: загрузите Excel/CSV/TXT/фото — строки распознаются автоматически. Содержание и название правятся вручную, всё сохраняется на устройстве.</p>
        <div className="flex flex-wrap gap-2 items-center">
          <input ref={masterRef} type="file" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onMasterFile(f); e.target.value = ''; }} />
          <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold" onClick={() => masterRef.current?.click()}>Загрузить список</button>
          <input type="text" value={master.name} onChange={(e) => setMaster((m) => ({ ...m, name: e.target.value }))} placeholder="Название файла/списка…" className="flex-1 min-w-[150px] rounded-lg border border-slate-400/40 bg-transparent px-2 py-2 text-[13.5px]" />
        </div>
        {master.rows.length > 0 && (
          <>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-[13px] border-collapse">
                <thead><tr className="text-[11.5px] opacity-70">
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">№</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">ФИО</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Счёт</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Сумма</th>
                  <th className="border border-slate-400/25 px-1 py-1" />
                </tr></thead>
                <tbody>
                  {master.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="border border-slate-400/25 px-1.5 py-0.5">{i + 1}</td>
                      {(['fio', 'account', 'amount'] as const).map((k) => (
                        <td key={k} className="border border-slate-400/25 px-0.5 py-0.5">
                          <input type="text" inputMode={k === 'account' ? 'numeric' : k === 'amount' ? 'decimal' : undefined} value={r[k]}
                            onChange={(e) => setMaster((m) => ({ ...m, rows: m.rows.map((x, j) => j === i ? { ...x, [k]: k === 'account' ? digits(e.target.value) : e.target.value } : x) }))}
                            className="w-full min-w-[90px] bg-transparent px-1 py-0.5 text-[13px] rounded focus:outline focus:outline-2 focus:outline-blue-600" />
                        </td>
                      ))}
                      <td className="border border-slate-400/25 px-0.5 py-0.5 text-center">
                        <button type="button" className="px-1.5 text-[15px] opacity-50" onClick={() => setMaster((m) => ({ ...m, rows: m.rows.filter((_, j) => j !== i) }))}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold mt-2" onClick={() => setMaster((m) => ({ ...m, rows: [...m.rows, { fio: '', account: '', amount: '' }] }))}>+ Строка</button>
            <p className="text-[12px] opacity-60 mt-1.5">{master.rows.length} строк · сохранено на устройстве</p>
          </>
        )}
      </Card>

      {/* Отдельная кнопка: обновление списков УИК */}
      <Card>
        <CardHead>Обновление списков УИК</CardHead>
        <p className="text-[12px] opacity-60 mb-2.5">Отдельная загрузка актуального состава: демонстрационные данные комиссий заменятся этим списком. Если в файле есть колонка с номером УИК — обновление пройдёт по всем комиссиям автоматически, иначе выберите комиссию вручную.</p>
        <div className="flex flex-wrap gap-2 items-center">
          <input ref={uikFileRef} type="file" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUikFile(f); e.target.value = ''; }} />
          <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold" onClick={() => uikFileRef.current?.click()}>Выбрать файл состава</button>
          <select value={uState?.fromReg || 0} onChange={(e) => {
            const id = +e.target.value;
            const en = registry.find((x) => x.id === id);
            if (!en) { setUState(null); setUInfo('Файл не выбран'); return; }
            const rows = (en.rows || []).map((r) => [[r.last, r.first, r.middle].join(' ').trim(), r.account || '', r.amount || '']);
            if (!rows.length) { setUState(null); setUInfo('В записи реестра нет строк.'); return; }
            const col = detectUikColumn(['ФИО', 'Счет', 'Сумма'], rows);
            setUState({ headers: ['ФИО', 'Счет', 'Сумма'], matrix: rows, mapping: { fio: 0, account: 1, amount: 2 }, uikCol: col, fileName: en.name + ' (реестр)', fromReg: id } as typeof uState & { fromReg: number });
            setUInfo(`${en.name} · из реестра · ${rows.length} строк · колонка УИК: ${col >= 0 ? '"ФИО/Счет/Сумма"' : 'не найдена — выберите комиссию вручную'}`);
          }} className="flex-1 min-w-[160px] rounded-lg border border-slate-400/40 bg-transparent px-2 py-2 text-[13.5px]">
            <option value={0}>— или выбрать из реестра вкладки —</option>
            {registry.map((en) => <option key={en.id} value={en.id}>{en.name} · {en.count} чел.</option>)}
          </select>
          <select value={uikManualId} onChange={(e) => setUikManualId(+e.target.value)} className="flex-1 min-w-[170px] rounded-lg border border-slate-400/40 bg-transparent px-2 py-2 text-[13.5px]">
            <option value={0}>— по колонке УИК в файле —</option>
            {uiks.map((c) => <option key={c.id} value={c.id}>{c.code}{c.district ? ` · ${c.district}` : ''}</option>)}
          </select>
          <button type="button" className="rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white" onClick={runUikUpdate}>Обновить списки УИК</button>
        </div>
        <p className="text-[12.5px] opacity-75 mt-2">{uInfo}</p>
        {uikReport && <p className="text-[12.5px] mt-1.5 whitespace-pre-line">{uikReport}</p>}
      </Card>

      {/* Шаг 1. Загрузка */}
      <Card>
        <CardHead><Num>1</Num>Загрузите предварительный список</CardHead>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        <button type="button" className="rounded-lg bg-blue-600 px-3.5 py-2 text-[13.5px] font-semibold text-white" onClick={() => fileRef.current?.click()}>Выбрать файл (.xlsx / .xls / .csv / .txt / фото)</button>
        <p className="text-[12.5px] opacity-75 mt-2">{info}</p>
      </Card>

      {/* Шаг 2. Сопоставление */}
      {matrix.length > 0 && (
        <Card>
          <CardHead><Num>2</Num>Распознавание — проверьте сопоставление колонок</CardHead>
          <div className="grid grid-cols-2 gap-2 gap-x-3.5 my-1.5">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="text-[12.5px] opacity-85 block mb-1">{f.label}</label>
                <select value={mapping[f.key] ?? -1} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: +e.target.value }))} className="w-full rounded-lg border border-slate-400/40 bg-transparent px-2 py-1.5 text-[13.5px]">
                  <option value={-1}>— не брать —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `Колонка ${i + 1}`}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mt-2.5">
            <button type="button" className="rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white" onClick={() => applyMapping(headers, matrix, mapping)}>Применить → сформировать ведомость</button>
          </div>
          <div className="flex flex-wrap gap-2 items-center mt-3 pt-3 border-t border-slate-400/25">
            <span className="text-[13px] w-full"><b>Обновить справочник членов УИК</b> <span className="opacity-60">— заменить демонстрационные данные этим списком</span></span>
            <select value={updCommId} onChange={(e) => setUpdCommId(+e.target.value)} className="flex-1 min-w-[180px] rounded-lg border border-slate-400/40 bg-transparent px-2 py-1.5 text-[13.5px]">
              <option value={0}>— выберите комиссию —</option>
              {uiks.map((c) => <option key={c.id} value={c.id}>{c.code}{c.district ? ` · ${c.district}` : ''}</option>)}
            </select>
            <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold" onClick={runStepUpdate}>Обновить состав</button>
          </div>
          {updResult && <p className="text-[12.5px] opacity-75 mt-2">{updResult}</p>}
        </Card>
      )}

      {/* Шаг 3. Ведомость */}
      {(rows.length > 0 || registry.length > 0) && (
        <Card>
          <CardHead><Num>3</Num>Ведомость — проверьте и поправьте вручную</CardHead>
          <div className="flex flex-wrap gap-2 items-center mb-2">
            <select value={0} onChange={(e) => { const en = registry.find((x) => x.id === +e.target.value); if (en) { setRows(JSON.parse(JSON.stringify(en.rows))); setAppliedSum(parseFloat(en.sum) || 0); setFileName(en.name); } e.target.value = '0'; }} className="flex-1 min-w-[170px] rounded-lg border border-slate-400/40 bg-transparent px-2 py-2 text-[13.5px]">
              <option value={0}>— открыть список из реестра для правки —</option>
              {registry.map((en) => <option key={en.id} value={en.id}>{en.name} · {en.count} чел.</option>)}
            </select>
            <input ref={tableFileRef} type="file" accept=".xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold" onClick={() => tableFileRef.current?.click()}>Загрузить файл (распознавание + Excel)</button>
          </div>
          {rows.length > 0 && (<>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-[11.5px] opacity-70">
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">№</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Счёт (20 цифр)</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Фамилия</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Имя</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Отчество</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Сумма</th>
                  <th className="border border-slate-400/25 px-1.5 py-1 text-left">Удержания</th>
                  <th className="border border-slate-400/25 px-1 py-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const bad = rowProblems(r).length > 0;
                  const dup = !bad && r.account && (dupAccounts.get(r.account) ?? 0) > 1;
                  return (
                    <tr key={i} className={bad ? 'bg-red-500/10' : dup ? 'bg-amber-400/10' : ''}>
                      <td className="border border-slate-400/25 px-1.5 py-0.5">{i + 1}</td>
                      {(['account', 'last', 'first', 'middle', 'amount', 'deduct'] as const).map((k) => (
                        <td key={k} className="border border-slate-400/25 px-0.5 py-0.5">
                          <input
                            type="text"
                            inputMode={k === 'account' ? 'numeric' : k === 'amount' || k === 'deduct' ? 'decimal' : undefined}
                            value={k === 'amount' || k === 'deduct' ? (parseFloat(r[k]) ? (parseFloat(r[k])).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) : r[k]) : r[k]}
                            onChange={(e) => setCell(i, k, e.target.value)}
                            onBlur={(e) => blurCell(i, k, e.target.value)}
                            className="w-full min-w-[64px] bg-transparent px-1 py-0.5 text-[13px] rounded focus:outline focus:outline-2 focus:outline-blue-600"
                          />
                        </td>
                      ))}
                      <td className="border border-slate-400/25 px-0.5 py-0.5 text-center">
                        <button type="button" className="px-1.5 text-[15px] opacity-50" title="Удалить строку" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 mt-2.5">
            <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold" onClick={() => setRows((rs) => [...rs, { account: '', last: '', first: '', middle: '', amount: '', deduct: '0.00' }])}>+ Строка</button>
            <button type="button" className="rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white" onClick={saveCurrentVed}>Сохранить</button>
            <button type="button" className="rounded-lg bg-red-700/80 px-3.5 py-2 text-[13px] font-semibold text-white" onClick={deleteCurrentVed}>Удалить</button>
            <button type="button" className="rounded-lg bg-red-700/80 px-3.5 py-2 text-[13px] font-semibold text-white" onClick={() => { if (confirm('Очистить всю ведомость?')) setRows([]); }}>Очистить всё</button>
          </div>
          <p className="text-[13.5px] font-bold mt-2.5">
            Получателей: <b>{totals.cnt}</b> из {rows.length} · Итого: <b>{totals.sum.toFixed(2)} ₽</b>
            {totals.bad ? <> · <span className="text-red-400">ошибок: {totals.bad}</span></> : <> · <span className="text-emerald-500">готово к выгрузке</span></>}
            {appliedSum && Math.abs(totals.sum - appliedSum) > 0.005 ? <> · Δ от загруженного: {totals.sum - appliedSum > 0 ? '+' : ''}{(totals.sum - appliedSum).toFixed(2)} ₽</> : ''}
          </p>
          <p className="text-[12px] opacity-60 mt-1.5">Красная строка — ошибка: счёт ≠ 20 цифр или сумма пустая. Жёлтая — одинаковый счёт у разных получателей.</p>
          </>)}
        </Card>
      )}

      {/* Шаг 4. Выгрузка */}
      {(rows.length > 0 || registry.length > 0) && (
        <Card>
          <CardHead><Num>4</Num>Выгрузка в Сбербанк</CardHead>
          <select value={expRegId} onChange={(e) => setExpRegId(+e.target.value)} className="w-full rounded-lg border border-slate-400/40 bg-transparent px-2 py-2 text-[13.5px] mb-2">
            <option value={0}>— выгрузить текущую ведомость (после автораспознавания) —</option>
            {registry.map((en) => <option key={en.id} value={en.id}>{en.name} · {en.count} чел. · {en.sum} ₽</option>)}
          </select>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={exportSourceRows().length === 0 || exportSourceRows().some((r) => rowProblems(r).length > 0)} className="rounded-lg bg-blue-600 px-5 py-3 text-[15px] font-semibold text-white disabled:opacity-45" onClick={() => exportCsv('1251')}>⬇ Выгрузить в Сбербанк</button>
          </div>
          <p className="text-[12px] opacity-60 mt-2">Файл CSV (Windows-1251) в формате «Ведомость на счета» — готов к импорту: Сбер Бизнес Онлайн → Зарплатный проект → Импорт ведомости.</p>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="button" disabled={exportSourceRows().length === 0 || exportSourceRows().some((r) => rowProblems(r).length > 0)} className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold disabled:opacity-45" onClick={() => exportCsv('utf8')}>CSV UTF-8</button>
            <button type="button" disabled={exportSourceRows().length === 0 || exportSourceRows().some((r) => rowProblems(r).length > 0)} className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold disabled:opacity-45" onClick={exportXlsx}>XLSX</button>
            <button type="button" className="rounded-lg bg-slate-500/20 px-3.5 py-2 text-[13px] font-semibold" onClick={downloadSample}>Скачать образец</button>
          </div>
          <p className="text-[12px] opacity-60 mt-2">Перед подписью в банке сверьте: количество получателей и итоговая сумма обязаны совпасть с предпросмотром в Сбер Бизнес Онлайн.</p>
        </Card>
      )}
    </div>
  );
}
