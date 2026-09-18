// Обмен файлами: автораспознавание (составы / реестр / смета / табель / документ),
// авторазмещение в базу, архивация в библиотеку, выгрузка таблиц (xlsx/csv/json).
import { db } from './db';
import { loadXlsx } from './excel';
import { logAdmin } from './adminlog';
import { buildRecon } from './calc';
import { loadRates } from './settings';
import { BUDGET_NAME, LINE_CODES, LINE_NAME, ROLE_NAME } from './rules';
import type { Budget, Role } from '../types';

// ── Типы разобранных файлов ──────────────────────────────────────────
export type FileKind = 'rosters' | 'registry' | 'estimate' | 'timesheet' | 'document';

export const KIND_NAME: Record<FileKind, string> = {
  rosters: 'Составы комиссий',
  registry: 'Реестр комиссий',
  estimate: 'Смета расходов',
  timesheet: 'Табель учёта времени',
  document: 'Документ',
};

export interface RosterRow {
  fio: string;
  role: Role;
}

export interface RegistryCard {
  num: number;
  district?: string;
  venue?: string;
  address?: string;
  phone?: string;
}

export interface EstimateRow {
  lineCode: string;
  limit: number;
  decision?: string;
}

export interface TsRow {
  fio: string;
  date: string;
  dayH: number;
  nightH: number;
  weekendH: number;
  role?: Role;
}

export interface ParsedFile {
  kind: FileKind;
  fileName: string;
  warnings: string[];
  summary: string;
  rosters?: Record<number, RosterRow[]>;
  unassigned?: RosterRow[];
  registry?: RegistryCard[];
  estimate?: EstimateRow[];
  timesheet?: TsRow[];
  timesheetUik?: number | null;
}

// ── Низкоуровневые разборщики ────────────────────────────────────────
const ROLE_PATTERNS: Array<[RegExp, Role]> = [
  [/^председател/i, 'chair'],
  [/зам/i, 'deputy'],
  [/секретар/i, 'secretary'],
  [/член/i, 'member'],
];

function parseRole(v: unknown): Role | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  for (const [re, role] of ROLE_PATTERNS) if (re.test(s)) return role;
  return null;
}

const FIO_RE = /^[А-ЯЁ][а-яё-]+(\s+[А-ЯЁ][а-яё-]+){1,2}$/;
const FIO_INITIALS_RE = /^[А-ЯЁ][а-яё-]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.$/;

function isFio(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 5 || s.length > 60 || /\d/.test(s)) return false;
  return FIO_RE.test(s) || FIO_INITIALS_RE.test(s);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.replace(/[\s ]/g, '').replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseLineCode(v: string): string | null {
  const up = v.trim().toUpperCase();
  if ((LINE_CODES as readonly string[]).includes(up)) return up;
  const t = v.toLowerCase();
  if (/гражданск|гпд|гпх/.test(t)) return 'GPD';
  if (/оплат|вознагражд/.test(t)) return 'PAY';
  if (/информир/.test(t)) return 'INF';
  if (/полиграф|бюллетен/.test(t)) return 'POLIGRAF';
  if (/транспорт|доставк/.test(t)) return 'TRANSPORT';
  if (/связь|гас/.test(t)) return 'SVYAZ';
  if (/оборудован|оргтехник/.test(t)) return 'EQUIP';
  if (/обучен/.test(t)) return 'OBUCH';
  if (/проч/.test(t)) return 'PROCHEE';
  return null;
}

const COLS: Record<string, RegExp> = {
  fio: /фио|фамилия|член\s+комиссии/i,
  role: /роль|должност/i,
  uik: /уик|участк|№\s*комиссии/i,
  district: /район/i,
  venue: /помещен/i,
  address: /адрес/i,
  phone: /телефон|^тел\.?/i,
  line: /статья|направлен|код|расход/i,
  limit: /лимит|сумма|ассигнован|руб|₽/i,
  decision: /решение|реквизит/i,
};

function matchCols(row: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  row.forEach((cell, i) => {
    const s = str(cell);
    if (!s) return;
    for (const key of Object.keys(COLS)) {
      if (out[key] === undefined && COLS[key].test(s)) out[key] = i;
    }
  });
  return out;
}

function colScore(row: unknown[]): number {
  return Object.keys(matchCols(row)).length;
}

/** № УИК из текста (имени файла/листа): «уик 123», «участок № 123» или просто трёхзначное число */
function uikFromText(s: string): number | null {
  const m = /(?:уик|участок|uik)?\s*№?\s*(\d{3})/i.exec(s);
  return m ? Number(m[1]) : null;
}

// ── Табель: даты и части суток ───────────────────────────────────────
const MONTHS: Array<[RegExp, number]> = [
  [/янв/i, 1],
  [/фев/i, 2],
  [/мар/i, 3],
  [/апр/i, 4],
  [/ма[йя]/i, 5],
  [/июн/i, 6],
  [/июл/i, 7],
  [/авг/i, 8],
  [/сен/i, 9],
  [/окт/i, 10],
  [/ноя/i, 11],
  [/дек/i, 12],
];

function monthFromText(s: string): number | null {
  for (const [re, m] of MONTHS) if (re.test(s)) return m;
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
const validDM = (d: number, m: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** Excel serial date → ISO (только правдоподобный диапазон) */
function excelDate(n: number): string | null {
  if (n < 4e4 || n > 6e4) return null;
  const d = new Date(Math.round((n - 25569) * 864e5));
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Пометка части суток в тексте даты: «ночь»/«(н)» → nightH, «вых» → weekendH */
function partOf(s: string): 'dayH' | 'nightH' | 'weekendH' {
  return /ноч|\(\s*н\s*\)|\sн\.?$/i.test(s)
    ? 'nightH'
    : /вых|выходн|\(\s*в\s*\)|\sв\.?$/i.test(s)
      ? 'weekendH'
      : 'dayH';
}

function parseDateCell(v: unknown, year: number, month: number | null): { iso: string; part: 'dayH' | 'nightH' | 'weekendH' } | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const iso = excelDate(v);
    if (iso) return { iso, part: 'dayH' };
    if (Number.isInteger(v) && v >= 1 && v <= 31 && month) return { iso: toIso(year, month, v), part: 'dayH' };
    return null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    let m = /^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/.exec(s);
    if (m) {
      const d = Number(m[1]);
      const mo = Number(m[2]);
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
      return validDM(d, mo) ? { iso: toIso(y, mo, d), part: partOf(s) } : null;
    }
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m && validDM(Number(m[3]), Number(m[2]))) {
      return { iso: toIso(Number(m[1]), Number(m[2]), Number(m[3])), part: partOf(s) };
    }
    if (/^\d{1,2}$/.test(s) && month) {
      const d = Number(s);
      if (d >= 1 && d <= 31) return { iso: toIso(year, month, d), part: 'dayH' };
    }
  }
  return null;
}

/** Слияние дублей «ФИО|дата» (суммирование часов) */
function mergeTsRows(rows: TsRow[]): TsRow[] {
  const map = new Map<string, TsRow>();
  for (const r of rows) {
    const key = `${r.fio.toLowerCase()}|${r.date}`;
    const cur = map.get(key);
    if (cur) {
      cur.dayH += r.dayH;
      cur.nightH += r.nightH;
      cur.weekendH += r.weekendH;
      cur.role ??= r.role;
    } else {
      map.set(key, { ...r });
    }
  }
  return [...map.values()];
}

const TS_COLS: Record<string, RegExp> = {
  fio: /фио|фамилия|член\s+комиссии/i,
  date: /^дата|^день$|^дд$/i,
  day: /дневн|^час|отработан/i,
  night: /ночн|ночь/i,
  weekend: /выходн|вых/i,
  role: /роль|должност/i,
};

type XlsxModule = Awaited<ReturnType<typeof loadXlsx>>;

/** Табель на листе: форма-матрица (ФИО × даты) или построчная (ФИО|Дата|Дн|Ноч|Вых) */
function parseTimesheetSheet(
  XLSX: XlsxModule,
  sheet: unknown,
  sheetName: string,
  fileName: string,
  warnings: string[],
): { rows: TsRow[]; uik: number | null } | null {
  const rows = (XLSX.utils.sheet_to_json(sheet as never, { header: 1, defval: '' }) as unknown[][]).filter((r) =>
    r.some((c) => str(c) !== ''),
  );
  if (rows.length < 2) return null;
  const mNum = /(\d{3})/.exec(sheetName);
  const uik = mNum ? Number(mNum[1]) : uikFromText(fileName);
  const mYear = /(20\d{2})/.exec(fileName);
  const year = mYear ? Number(mYear[1]) : 2026;
  const month = monthFromText(sheetName) ?? monthFromText(fileName);

  // Форма 1: матрица — строка заголовка с ≥2 датами
  for (let h = 0; h < Math.min(10, rows.length - 1); h += 1) {
    const head = rows[h];
    const dateCols: Array<{ col: number; iso: string; part: 'dayH' | 'nightH' | 'weekendH' }> = [];
    head.forEach((cell, ci) => {
      const parsed = parseDateCell(cell, year, month);
      if (parsed) dateCols.push({ col: ci, ...parsed });
    });
    if (dateCols.length < 2) continue;
    const dateColSet = new Set(dateCols.map((d) => d.col));
    let fioCol = head.findIndex((c) => TS_COLS.fio.test(str(c)));
    if (fioCol < 0) {
      for (let ci = 0; ci < Math.min(head.length, 4); ci += 1) {
        if (dateColSet.has(ci)) continue;
        const below = rows.slice(h + 1);
        if (below.filter((r) => isFio(r[ci])).length >= Math.max(2, below.length * 0.6)) {
          fioCol = ci;
          break;
        }
      }
    }
    if (fioCol < 0) continue;
    const roleCol = head.findIndex((c, ci) => ci !== fioCol && !dateColSet.has(ci) && TS_COLS.role.test(str(c)));
    const out: TsRow[] = [];
    let skipped = 0;
    for (const r of rows.slice(h + 1)) {
      const fio = str(r[fioCol]);
      if (!fio) continue;
      if (!isFio(fio)) {
        skipped += 1;
        continue;
      }
      const role = roleCol >= 0 ? (parseRole(r[roleCol]) ?? undefined) : undefined;
      for (const dc of dateCols) {
        const hours = num(r[dc.col]);
        if (hours == null || hours <= 0 || hours > 24) continue;
        out.push({
          fio,
          date: dc.iso,
          dayH: dc.part === 'dayH' ? hours : 0,
          nightH: dc.part === 'nightH' ? hours : 0,
          weekendH: dc.part === 'weekendH' ? hours : 0,
          ...(role ? { role } : {}),
        });
      }
    }
    if (out.length) {
      if (skipped) warnings.push(`Лист «${sheetName}»: пропущено строк без корректного ФИО — ${skipped}`);
      return { rows: mergeTsRows(out), uik };
    }
  }

  // Форма 2: построчная — заголовок по TS_COLS
  for (let h = 0; h < Math.min(10, rows.length - 1); h += 1) {
    const head = rows[h];
    const cols: Record<string, number> = {};
    head.forEach((cell, ci) => {
      const s = str(cell);
      if (!s) return;
      for (const key of Object.keys(TS_COLS)) {
        if (cols[key] === undefined && TS_COLS[key].test(s)) cols[key] = ci;
      }
    });
    if (cols.fio === undefined || cols.date === undefined || (cols.day === undefined && cols.night === undefined && cols.weekend === undefined))
      continue;
    const out: TsRow[] = [];
    let skipped = 0;
    for (const r of rows.slice(h + 1)) {
      const fio = str(r[cols.fio]);
      if (!fio) continue;
      const parsed = parseDateCell(r[cols.date], year, month);
      if (!isFio(fio) || !parsed) {
        skipped += 1;
        continue;
      }
      const dayH = cols.day !== undefined ? (num(r[cols.day]) ?? 0) : 0;
      const nightH = cols.night !== undefined ? (num(r[cols.night]) ?? 0) : 0;
      const weekendH = cols.weekend !== undefined ? (num(r[cols.weekend]) ?? 0) : 0;
      if (dayH <= 0 && nightH <= 0 && weekendH <= 0) continue;
      const role = cols.role !== undefined ? (parseRole(r[cols.role]) ?? undefined) : undefined;
      out.push({ fio, date: parsed.iso, dayH, nightH, weekendH, ...(role ? { role } : {}) });
    }
    if (out.length) {
      if (skipped) warnings.push(`Лист «${sheetName}»: пропущено строк — ${skipped} (ФИО или дата не распознаны)`);
      return { rows: mergeTsRows(out), uik };
    }
  }
  return null;
}

/** Общий разбор листа: строки + карта колонок + УИК из имени */
function parseSheet(
  XLSX: XlsxModule,
  sheet: unknown,
  sheetName: string,
): { rows: unknown[][]; cols: Record<string, number>; dataStart: number; uikFromName: number | null } | null {
  const rows = (XLSX.utils.sheet_to_json(sheet as never, { header: 1, defval: '' }) as unknown[][]).filter((r) =>
    r.some((c) => str(c) !== ''),
  );
  if (!rows.length) return null;
  const mNum = /(\d{3})/.exec(sheetName);
  const uikFromName = mNum ? Number(mNum[1]) : null;
  let headIdx = -1;
  let best = 1;
  for (let h = 0; h < Math.min(8, rows.length); h += 1) {
    const score = colScore(rows[h]);
    if (score > best) {
      headIdx = h;
      best = score;
    }
  }
  if (headIdx >= 0) return { rows: rows.slice(headIdx + 1), cols: matchCols(rows[headIdx]), dataStart: headIdx + 1, uikFromName };
  // без заголовка: ищем колонку ФИО эвристикой
  const width = Math.max(...rows.map((r) => r.length));
  for (let ci = 0; ci < Math.min(width, 4); ci += 1) {
    if (rows.filter((r) => isFio(r[ci])).length >= Math.max(2, rows.length * 0.6)) {
      const roleCol = ci + 1 < width ? ci + 1 : undefined;
      return { rows, cols: { fio: ci, ...(roleCol !== undefined ? { role: roleCol } : {}) }, dataStart: 0, uikFromName };
    }
  }
  return { rows, cols: {}, dataStart: 0, uikFromName };
}

/** Разбор книги xlsx/csv: табель → составы → смета → реестр → документ */
function parseWorkbook(XLSX: XlsxModule, wb: { SheetNames: string[]; Sheets: Record<string, unknown> }, fileName: string): ParsedFile {
  const warnings: string[] = [];
  const rosters: Record<number, RosterRow[]> = {};
  const unassigned: RosterRow[] = [];
  const registry: RegistryCard[] = [];
  const estimate: EstimateRow[] = [];
  const timesheet: TsRow[] = [];
  const fileUik = uikFromText(fileName);
  let hasRosters = false;
  let hasEstimate = false;
  let hasRegistry = false;
  let hasTimesheet = false;
  let timesheetUik: number | null = null;
  let skippedRows = 0;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const ts = parseTimesheetSheet(XLSX, sheet, sheetName, fileName, warnings);
    if (ts) {
      hasTimesheet = true;
      timesheet.push(...ts.rows);
      timesheetUik ??= ts.uik;
      continue;
    }
    const parsed = parseSheet(XLSX, sheet, sheetName);
    if (!parsed) continue;
    const { rows, cols } = parsed;
    const sheetUik = parsed.uikFromName ?? fileUik;

    if (cols.fio !== undefined) {
      hasRosters = true;
      for (const r of rows) {
        const fio = str(r[cols.fio]);
        if (!fio) continue;
        if (!isFio(fio)) {
          skippedRows += 1;
          continue;
        }
        const role = (cols.role !== undefined ? parseRole(r[cols.role]) : null) ?? 'member';
        const uikNo = cols.uik !== undefined ? num(r[cols.uik]) : sheetUik;
        const row: RosterRow = { fio, role };
        if (uikNo && uikNo >= 100 && uikNo <= 9999) (rosters[uikNo] ??= []).push(row);
        else unassigned.push(row);
      }
      continue;
    }
    if (cols.line !== undefined && cols.limit !== undefined) {
      hasEstimate = true;
      for (const r of rows) {
        const code = parseLineCode(str(r[cols.line]));
        const limit = num(r[cols.limit]);
        if (!code || limit == null) {
          if (str(r[cols.line])) skippedRows += 1;
          continue;
        }
        const decision = cols.decision !== undefined ? str(r[cols.decision]) : '';
        estimate.push({ lineCode: code, limit, ...(decision ? { decision } : {}) });
      }
      continue;
    }
    if (cols.uik !== undefined && (cols.address !== undefined || cols.venue !== undefined)) {
      hasRegistry = true;
      for (const r of rows) {
        const n = num(r[cols.uik]);
        if (!n || n < 100) continue;
        registry.push({
          num: n,
          ...(cols.district !== undefined && str(r[cols.district]) ? { district: str(r[cols.district]) } : {}),
          ...(cols.venue !== undefined && str(r[cols.venue]) ? { venue: str(r[cols.venue]) } : {}),
          ...(cols.address !== undefined && str(r[cols.address]) ? { address: str(r[cols.address]) } : {}),
          ...(cols.phone !== undefined && str(r[cols.phone]) ? { phone: str(r[cols.phone]) } : {}),
        });
      }
    }
  }

  if (skippedRows) warnings.push(`Пропущено строк с нераспознанным содержимым: ${skippedRows}`);

  if (hasTimesheet && timesheet.length) {
    const people = new Set(timesheet.map((r) => r.fio.toLowerCase())).size;
    const dates = new Set(timesheet.map((r) => r.date));
    const sorted = [...dates].sort();
    const fmtD = (iso?: string) => (iso ? iso.split('-').reverse().join('.') : '');
    return {
      kind: 'timesheet',
      fileName,
      warnings,
      timesheet,
      timesheetUik: timesheetUik ?? fileUik,
      summary: `Табель: записей — ${timesheet.length}, людей — ${people}, дат — ${dates.size} (${fmtD(sorted[0])} — ${fmtD(sorted[sorted.length - 1])})${(timesheetUik ?? fileUik) ? `, УИК № ${timesheetUik ?? fileUik} — по имени` : ''}`,
    };
  }
  if (hasRosters) {
    const uikCount = Object.keys(rosters).length;
    const total = Object.values(rosters).reduce((s, arr) => s + arr.length, 0) + unassigned.length;
    if (!total) warnings.push('Строки похожи на состав, но ФИО не распознаны.');
    if (unassigned.length) warnings.push(`Без номера участка: ${unassigned.length} чел. — при размещении укажите УИК вручную.`);
    return {
      kind: 'rosters',
      fileName,
      warnings,
      rosters,
      ...(unassigned.length ? { unassigned } : {}),
      summary: `Составы: ${total} чел.${uikCount ? `, участков: ${uikCount}` : ''}${fileUik && !uikCount ? ` (УИК № ${fileUik} — по имени файла)` : ''}`,
    };
  }
  if (hasEstimate && estimate.length) {
    return {
      kind: 'estimate',
      fileName,
      warnings,
      estimate,
      summary: `Смета: статей — ${estimate.length}, итого ${estimate.reduce((s, r) => s + r.limit, 0).toLocaleString('ru-RU')} ₽`,
    };
  }
  if (hasRegistry && registry.length) {
    return { kind: 'registry', fileName, warnings, registry, summary: `Реестр комиссий: карточек — ${registry.length}` };
  }
  return {
    kind: 'document',
    fileName,
    warnings,
    summary: 'Табличная структура не распознана — файл будет сохранён как документ.',
  };
}

/** Разбор JSON: составы {uik:{123:[...]}}, реестр {uik:[...]}, смета (массив строк) */
function parseJson(data: unknown, fileName: string): ParsedFile {
  const warnings: string[] = [];
  const obj = data as Record<string, unknown>;
  if (obj && typeof obj === 'object' && obj.uik && !Array.isArray(obj.uik) && typeof obj.uik === 'object') {
    const rosters: Record<number, RosterRow[]> = {};
    let total = 0;
    for (const [key, list] of Object.entries(obj.uik as Record<string, unknown[]>)) {
      const uikNo = Number(key);
      if (!Number.isFinite(uikNo) || !Array.isArray(list)) continue;
      for (const item of list) {
        const row = item as { fio?: unknown; role?: unknown };
        if (!isFio(row?.fio)) continue;
        const role = parseRole(row?.role) ?? 'member';
        (rosters[uikNo] ??= []).push({ fio: str(row.fio), role });
        total += 1;
      }
    }
    if (total) {
      return {
        kind: 'rosters',
        fileName,
        warnings,
        rosters,
        summary: `Составы (JSON): ${total} чел., участков — ${Object.keys(rosters).length}`,
      };
    }
  }
  if (obj && typeof obj === 'object' && Array.isArray(obj.uik)) {
    const registry: RegistryCard[] = [];
    for (const item of obj.uik) {
      const row = item as Record<string, unknown>;
      const n = num(row?.num);
      if (!n) continue;
      registry.push({
        num: n,
        ...(str(row.district) ? { district: str(row.district) } : {}),
        ...(str(row.venue) ? { venue: str(row.venue) } : {}),
        ...(str(row.address) ? { address: str(row.address) } : {}),
        ...(str(row.phone) ? { phone: str(row.phone) } : {}),
      });
    }
    if (registry.length) {
      return { kind: 'registry', fileName, warnings, registry, summary: `Реестр (JSON): карточек — ${registry.length}` };
    }
  }
  const list = Array.isArray(data) ? data : Array.isArray(obj?.estimate) ? obj.estimate : Array.isArray(obj?.lines) ? obj.lines : null;
  if (Array.isArray(list)) {
    const estimate: EstimateRow[] = [];
    for (const item of list) {
      const row = item as Record<string, unknown>;
      const code = parseLineCode(str(row?.lineCode ?? row?.line ?? row?.code ?? row?.article ?? ''));
      const limit = num(row?.limit ?? row?.amount ?? row?.sum);
      if (!code || limit == null) continue;
      const decision = str(row?.decision ?? '');
      estimate.push({ lineCode: code, limit, ...(decision ? { decision } : {}) });
    }
    if (estimate.length) {
      return {
        kind: 'estimate',
        fileName,
        warnings,
        estimate,
        summary: `Смета (JSON): статей — ${estimate.length}, итого ${estimate.reduce((s, r) => s + r.limit, 0).toLocaleString('ru-RU')} ₽`,
      };
    }
  }
  return { kind: 'document', fileName, warnings, summary: 'JSON не содержит известных структур — сохранён как документ.' };
}

const XLSX_RE = /\.(xlsx|xls|xlsm|ods)$/i;
const CSV_RE = /\.(csv|txt|tsv)$/i;

/** Главный вход: распознать файл любого поддерживаемого формата */
export async function parseFile(file: File): Promise<ParsedFile> {
  const name = file.name;
  try {
    if (/\.json$/i.test(name)) {
      return parseJson(JSON.parse(await file.text()), name);
    }
    if (CSV_RE.test(name)) {
      const buf = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder('windows-1251').decode(buf);
      }
      const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
      const semis = first.match(/;/g)?.length ?? 0;
      const commas = first.match(/,/g)?.length ?? 0;
      const tabs = first.match(/\t/g)?.length ?? 0;
      const fs = semis >= commas && semis > 0 ? ';' : tabs > 0 ? '\t' : ',';
      const XLSX = await loadXlsx();
      const wb = XLSX.read(text, { type: 'string', FS: fs });
      return parseWorkbook(XLSX, wb, name);
    }
    if (XLSX_RE.test(name)) {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      return parseWorkbook(XLSX, wb, name);
    }
    return {
      kind: 'document',
      fileName: name,
      warnings: [],
      summary: 'Формат не табличный — файл будет сохранён в библиотеку документов.',
    };
  } catch (e) {
    return {
      kind: 'document',
      fileName: name,
      warnings: [`Разбор не выполнен: ${e instanceof Error ? e.message : 'ошибка чтения'}`],
      summary: 'Файл не распознан — будет сохранён как документ.',
    };
  }
}

// ── Размещение в базе ────────────────────────────────────────────────
export interface ApplyOpts {
  commissionId: number;
  budget: Budget;
  overrideUik?: number | null;
}

async function applyRosters(rec: ParsedFile, opts: ApplyOpts): Promise<string> {
  const rates = await loadRates();
  const entries = Object.entries(rec.rosters ?? {}).map(([k, v]) => [Number(k), v] as [number, RosterRow[]]);
  if (rec.unassigned?.length) {
    if (opts.overrideUik) entries.push([opts.overrideUik, rec.unassigned]);
    else throw new Error(`В файле ${rec.unassigned.length} чел. без номера участка — выберите УИК для размещения.`);
  }
  if (!entries.length) throw new Error('Составы в файле не найдены.');
  const placed: string[] = [];
  const missing: number[] = [];
  let total = 0;
  for (const [uikNo, people] of entries) {
    const commission = await db.commissions.where('uikNo').equals(uikNo).first();
    if (!commission) {
      missing.push(uikNo);
      continue;
    }
    const existing = await db.members.where('commissionId').equals(commission.id).toArray();
    if (existing.length) await db.members.bulkDelete(existing.map((m) => m.id));
    await db.members.bulkAdd(
      people.map(
        (p) =>
          ({
            commissionId: commission.id,
            fio: p.fio,
            role: p.role,
            status: 'нештатный',
            rate: rates[p.role],
            source: 'official',
          }) as never,
      ),
    );
    const chair = people.find((p) => p.role === 'chair');
    if (chair) await db.commissions.update(commission.id, { chair: chair.fio } as never);
    placed.push(`№ ${uikNo} (${people.length})`);
    total += people.length;
  }
  const msg =
    `Официальные составы размещены: УИК ${placed.join(', ')} — всего ${total} чел.` +
    (missing.length ? ` Не найдены карточки участков: ${missing.join(', ')}.` : '');
  await logAdmin(`Файл «${rec.fileName}»: ${msg}`);
  return msg;
}

async function applyRegistry(rec: ParsedFile): Promise<string> {
  const cards = rec.registry ?? [];
  if (!cards.length) throw new Error('Карточки комиссий в файле не найдены.');
  const tik = await db.commissions.where('level').equals('TIK').first();
  let added = 0;
  let updated = 0;
  for (const card of cards) {
    const existing = await db.commissions.where('uikNo').equals(card.num).first();
    if (existing) {
      const changed =
        (card.venue && existing.venue !== card.venue) ||
        (card.address && existing.address !== card.address) ||
        (card.phone && existing.phone !== card.phone) ||
        (card.district && existing.district !== card.district);
      if (changed) {
        await db.commissions.update(existing.id, {
          ...(card.venue ? { venue: card.venue } : {}),
          ...(card.address ? { address: card.address } : {}),
          ...(card.phone ? { phone: card.phone } : {}),
          ...(card.district ? { district: card.district } : {}),
        } as never);
        updated += 1;
      }
    } else {
      await db.commissions.add({
        code: `УИК № ${card.num}`,
        name: `Участковая избирательная комиссия № ${card.num}`,
        level: 'UIK',
        parentId: tik?.id,
        budget: 'krai',
        uikNo: card.num,
        district: card.district,
        venue: card.venue,
        address: card.address,
        phone: card.phone,
      } as never);
      added += 1;
    }
  }
  const msg = `Реестр размещён: обновлено карточек — ${updated}, добавлено — ${added}.`;
  await logAdmin(`Файл «${rec.fileName}»: ${msg}`);
  return msg;
}

async function applyEstimate(rec: ParsedFile, opts: ApplyOpts): Promise<string> {
  const rows = rec.estimate ?? [];
  if (!rows.length) throw new Error('Статьи сметы в файле не найдены.');
  const commission = await db.commissions.get(opts.commissionId);
  if (!commission) throw new Error('Целевая комиссия не выбрана.');
  const existing = await db.estimate.where('[commissionId+budget]').equals([opts.commissionId, opts.budget]).toArray();
  let updated = 0;
  let added = 0;
  for (const row of rows) {
    const cur = existing.find((e) => e.lineCode === row.lineCode);
    if (cur) {
      await db.estimate.update(cur.id, { limit: row.limit, ...(row.decision ? { decision: row.decision } : {}) } as never);
      updated += 1;
    } else {
      await db.estimate.add({
        commissionId: opts.commissionId,
        budget: opts.budget,
        lineCode: row.lineCode,
        limit: row.limit,
        decision: row.decision ?? 'решение комиссии (загружено файлом)',
      } as never);
      added += 1;
    }
  }
  const total = rows.reduce((s, r) => s + r.limit, 0);
  const msg = `Смета размещена: ${commission.code}, статей обновлено — ${updated}, добавлено — ${added}, итого ${total.toLocaleString('ru-RU')} ₽.`;
  await logAdmin(`Файл «${rec.fileName}»: ${msg}`);
  return msg;
}

function normFio(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[.\s-]+/g, ' ').trim();
}

/** Ключ «фамилия + инициалы» для нестрогого сопоставления */
function fioKey(s: string): string {
  const parts = normFio(s).split(' ');
  return `${parts[0] ?? ''} ${parts.slice(1).map((p) => p[0]).join('')}`;
}

async function applyTimesheet(rec: ParsedFile, opts: ApplyOpts): Promise<string> {
  const rows = rec.timesheet ?? [];
  if (!rows.length) throw new Error('Записи табеля в файле не найдены.');
  const uikNo = opts.overrideUik ?? rec.timesheetUik ?? null;
  if (!uikNo) throw new Error('Выберите УИК, для которого загружается табель (выпадающий список в очереди файла).');
  const commission = await db.commissions.where('uikNo').equals(uikNo).first();
  if (!commission) throw new Error(`Карточка УИК № ${uikNo} не найдена в реестре.`);
  const rates = await loadRates();
  const members = await db.members.where('commissionId').equals(commission.id).toArray();
  const byFull = new Map(members.map((m) => [normFio(m.fio), m]));
  const byKey = new Map(members.map((m) => [fioKey(m.fio), m]));
  const entries = await db.timesheet.where('memberId').anyOf(members.map((m) => m.id)).toArray();
  const byKeyDate = new Map(entries.map((e) => [`${e.memberId}|${e.date}`, e]));
  let addedPeople = 0;
  let addedRows = 0;
  let updatedRows = 0;
  for (const row of rows) {
    let member = byFull.get(normFio(row.fio)) ?? byKey.get(fioKey(row.fio));
    if (!member) {
      const role = row.role ?? 'member';
      const id = await db.members.add({
        commissionId: commission.id,
        fio: row.fio,
        role,
        status: 'нештатный',
        rate: rates[role],
        source: 'official',
      } as never);
      member = { id, commissionId: commission.id, fio: row.fio, role, status: 'нештатный', rate: rates[role], source: 'official' };
      byFull.set(normFio(row.fio), member);
      byKey.set(fioKey(row.fio), member);
      addedPeople += 1;
    }
    const key = `${member.id}|${row.date}`;
    const cur = byKeyDate.get(key);
    if (cur) {
      await db.timesheet.update(cur.id, { dayH: row.dayH, nightH: row.nightH, weekendH: row.weekendH } as never);
      updatedRows += 1;
    } else {
      const id = await db.timesheet.add({
        memberId: member.id,
        date: row.date,
        dayH: row.dayH,
        nightH: row.nightH,
        weekendH: row.weekendH,
      } as never);
      byKeyDate.set(key, { id, memberId: member.id, date: row.date, dayH: row.dayH, nightH: row.nightH, weekendH: row.weekendH });
      addedRows += 1;
    }
  }
  const people = new Set(rows.map((r) => normFio(r.fio))).size;
  const msg =
    `Табель размещён: ${commission.code} — записей добавлено ${addedRows}, обновлено ${updatedRows}` +
    (addedPeople ? `, в состав добавлено людей: ${addedPeople}` : '') +
    ` (людей в файле: ${people}).`;
  await logAdmin(`Файл «${rec.fileName}»: ${msg}`);
  return msg;
}

/** Авторазмещение распознанного файла в базу */
export async function applyFile(rec: ParsedFile, opts: ApplyOpts): Promise<string> {
  if (rec.kind === 'rosters') return applyRosters(rec, opts);
  if (rec.kind === 'registry') return applyRegistry(rec);
  if (rec.kind === 'estimate') return applyEstimate(rec, opts);
  if (rec.kind === 'timesheet') return applyTimesheet(rec, opts);
  throw new Error('Этот файл сохраняется в библиотеку документов, размещение не требуется.');
}

/** Архивация исходного файла в библиотеку документов */
export async function archiveFile(file: File, kind: FileKind, note?: string): Promise<void> {
  await db.documents.add({
    name: file.name,
    kind,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    addedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
    blob: file,
  } as never);
  await logAdmin(`Документ «${file.name}» сохранён в библиотеку (${KIND_NAME[kind].toLowerCase()})`);
}

// ── Экспорт таблиц ───────────────────────────────────────────────────
export const EXPORT_SCOPE = {
  commissions: 'Комиссии (справочник)',
  members: 'Члены комиссий',
  estimate: 'Сметы (лимиты)',
  operations: 'Операции (банк/касса)',
  timesheet: 'Табели учёта времени',
  advances: 'Подотчётные суммы',
  accounts: 'Реестр счетов и средств (сверка с банком)',
  documents: 'Библиотека документов (реестр)',
  full: 'Сводный отчёт (все таблицы)',
  backup: 'Полная копия базы (JSON)',
} as const;

export type ExportScope = keyof typeof EXPORT_SCOPE;

export const EXPORT_FORMAT = {
  xlsx: 'MS Excel (.xlsx)',
  csv: 'CSV (.csv)',
  json: 'JSON (.json)',
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMAT;

const CHANNEL_SHORT: Record<string, string> = { bank: 'банк', cash: 'касса', advance: 'подотчёт' };

interface SheetData {
  name: string;
  rows: unknown[][];
}

async function sheetCommissions(): Promise<SheetData> {
  const list = await db.commissions.toArray();
  list.sort((a, b) => a.code.localeCompare(b.code, 'ru'));
  return {
    name: 'Комиссии',
    rows: [
      ['Код', 'Наименование', 'Уровень', 'Бюджет', '№ УИК', 'Район', 'Помещение', 'Адрес', 'Телефон', 'Счёт', 'Банк', 'Председатель', 'Бухгалтер'],
      ...list.map((c) => [
        c.code, c.name, c.level, BUDGET_NAME[c.budget] ?? c.budget, c.uikNo ?? '', c.district ?? '', c.venue ?? '',
        c.address ?? '', c.phone ?? '', c.account ?? '', c.bank ?? '', c.chair ?? '', c.accountant ?? '',
      ]),
    ],
  };
}

async function sheetMembers(): Promise<SheetData> {
  const [members, commissions] = await Promise.all([db.members.toArray(), db.commissions.toArray()]);
  const byId = new Map(commissions.map((c) => [c.id, c.code]));
  members.sort((a, b) => a.fio.localeCompare(b.fio, 'ru'));
  return {
    name: 'Члены комиссий',
    rows: [
      ['Комиссия', 'ФИО', 'Роль', 'Статус', 'Ставка ₽/ч'],
      ...members.map((m) => [byId.get(m.commissionId) ?? m.commissionId, m.fio, ROLE_NAME[m.role] ?? m.role, m.status, m.rate]),
    ],
  };
}

async function sheetEstimate(): Promise<SheetData> {
  const [lines, commissions] = await Promise.all([db.estimate.toArray(), db.commissions.toArray()]);
  const byId = new Map(commissions.map((c) => [c.id, c.code]));
  return {
    name: 'Сметы',
    rows: [
      ['Комиссия', 'Бюджет', 'Код строки', 'Статья', 'Лимит, ₽', 'Решение'],
      ...lines.map((e) => [
        byId.get(e.commissionId) ?? e.commissionId, BUDGET_NAME[e.budget] ?? e.budget, e.lineCode,
        LINE_NAME[e.lineCode] ?? e.name ?? e.lineCode, e.limit, e.decision,
      ]),
    ],
  };
}

async function sheetOperations(): Promise<SheetData> {
  const [ops, commissions] = await Promise.all([db.operations.toArray(), db.commissions.toArray()]);
  const byId = new Map(commissions.map((c) => [c.id, c.code]));
  ops.sort((a, b) => a.date.localeCompare(b.date));
  return {
    name: 'Операции',
    rows: [
      ['Комиссия', 'Бюджет', 'Дата', 'Приход/расход', 'Статья', 'Сумма, ₽', '№ документа', 'Дата документа', 'Контрагент', 'Назначение', 'Канал'],
      ...ops.map((o) => [
        byId.get(o.commissionId) ?? o.commissionId, BUDGET_NAME[o.budget] ?? o.budget, o.date,
        o.kind === 'in' ? 'приход' : 'расход', LINE_NAME[o.lineCode] ?? o.lineCode, o.amount, o.docNo, o.docDate,
        o.counterparty, o.purpose, CHANNEL_SHORT[o.channel] ?? o.channel,
      ]),
    ],
  };
}

async function sheetTimesheet(): Promise<SheetData> {
  const [entries, members, commissions] = await Promise.all([db.timesheet.toArray(), db.members.toArray(), db.commissions.toArray()]);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const codeById = new Map(commissions.map((c) => [c.id, c.code]));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return {
    name: 'Табели',
    rows: [
      ['Комиссия', 'ФИО', 'Дата', 'Дневные, ч', 'Ночные, ч', 'Выходные, ч'],
      ...entries.map((e) => {
        const m = memberById.get(e.memberId);
        return [m ? (codeById.get(m.commissionId) ?? '') : '', m?.fio ?? `#${e.memberId}`, e.date, e.dayH, e.nightH, e.weekendH];
      }),
    ],
  };
}

async function sheetAdvances(): Promise<SheetData> {
  const [advances, commissions] = await Promise.all([db.advances.toArray(), db.commissions.toArray()]);
  const byId = new Map(commissions.map((c) => [c.id, c.code]));
  return {
    name: 'Подотчётные',
    rows: [
      ['Комиссия', 'Лицо', 'Дата', 'Назначение', 'Выдано, ₽', 'Отчитались, ₽', 'Документов', 'Статус'],
      ...advances.map((a) => [byId.get(a.commissionId) ?? a.commissionId, a.person, a.date, a.purpose, a.amount, a.reported, a.docsCount, a.status]),
    ],
  };
}

async function sheetAccounts(): Promise<SheetData> {
  const [accounts, ops, commissions] = await Promise.all([db.accounts.toArray(), db.operations.toArray(), db.commissions.toArray()]);
  const rows = buildRecon(accounts, ops, commissions);
  const p = (n: number) => Math.round(n * 100) / 100;
  return {
    name: 'Счета и средства',
    rows: [
      ['Комиссия', 'Бюджет', 'Расчётный счёт', 'Банк', 'БИК', 'Открыт', 'Закрыт', 'Поступило, ₽', 'Израсходовано, ₽', 'Остаток по учёту, ₽', 'Остаток по выписке, ₽', 'Дата выписки', 'Расхождение, ₽', 'Статус сверки'],
      ...rows.map((r) => [
        r.commission?.code ?? '', BUDGET_NAME[r.account.budget] ?? r.account.budget, r.account.number, r.account.bank,
        r.account.bik ?? '', r.account.opened ?? '', r.account.closed ?? '', p(r.paidIn), p(r.paidOut), p(r.bookBalance),
        r.account.statementBalance ?? '', r.account.statementDate ?? '', r.diff ?? '',
        r.status === 'ok' ? 'совпадает' : r.status === 'bad' ? 'расхождение' : 'нет выписки',
      ]),
    ],
  };
}

async function sheetDocuments(): Promise<SheetData> {
  const docs = await db.documents.toArray();
  docs.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return {
    name: 'Документы',
    rows: [
      ['Название', 'Тип', 'Размер, байт', 'Добавлен', 'Примечание'],
      ...docs.map((d) => [d.name, d.kind, d.size, d.addedAt.slice(0, 19).replace('T', ' '), d.note ?? '']),
    ],
  };
}

async function collectSheets(scope: ExportScope): Promise<SheetData[]> {
  switch (scope) {
    case 'commissions': return [await sheetCommissions()];
    case 'members': return [await sheetMembers()];
    case 'estimate': return [await sheetEstimate()];
    case 'operations': return [await sheetOperations()];
    case 'timesheet': return [await sheetTimesheet()];
    case 'advances': return [await sheetAdvances()];
    case 'accounts': return [await sheetAccounts()];
    case 'documents': return [await sheetDocuments()];
    case 'full':
      return [
        await sheetCommissions(), await sheetMembers(), await sheetEstimate(), await sheetOperations(),
        await sheetTimesheet(), await sheetAdvances(), await sheetAccounts(), await sheetDocuments(),
      ];
    case 'backup': return [];
  }
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sheetsToCsv(sheets: SheetData[]): string {
  return (
    '﻿' +
    sheets
      .map((sheet) => {
        const body = sheet.rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
        return sheets.length > 1 ? `=== ${sheet.name} ===\r\n${body}` : body;
      })
      .join('\r\n\r\n')
  );
}

async function sheetsToJson(sheets: SheetData[]): Promise<string> {
  const tables: Record<string, unknown[]> = {};
  for (const sheet of sheets) {
    const [head, ...rows] = sheet.rows;
    tables[sheet.name] = rows.map((r) => Object.fromEntries((head as unknown[]).map((h, i) => [String(h), r[i] ?? ''])));
  }
  return JSON.stringify({ app: 'komfin', at: new Date().toISOString(), tables }, null, 2);
}

/** Полная копия базы (без бинарных тел документов/шаблонов — только реестры) */
async function fullBackupJson(): Promise<string> {
  const tables: Record<string, unknown[]> = {};
  for (const t of ['commissions', 'members', 'estimate', 'operations', 'timesheet', 'advances', 'pages', 'accounts'] as const) {
    tables[t] = await db[t].toArray();
  }
  tables.documents = (await db.documents.toArray()).map(({ blob: _blob, ...rest }) => rest);
  tables.templates = (await db.templates.toArray()).map(({ blob: _blob, ...rest }) => rest);
  return JSON.stringify({ app: 'komfin', format: 2, at: new Date().toISOString(), tables }, null, 2);
}

const EXPORT_SLUG: Record<ExportScope, string> = {
  commissions: 'komissii',
  members: 'chleny',
  estimate: 'smety',
  operations: 'operacii',
  timesheet: 'tabeli',
  advances: 'podotchet',
  accounts: 'scheta_sredstva',
  documents: 'dokumenty',
  full: 'svodny_otchet',
  backup: 'baza',
};

export interface BuiltFile {
  blob: Blob;
  filename: string;
  rowsCount: number;
  textPreview: string;
}

/** Формирование файла выгрузки заданного охвата и формата */
export async function buildExport(scope: ExportScope, format: ExportFormat): Promise<BuiltFile> {
  const date = new Date().toISOString().slice(0, 10);
  const base = `komfin_${EXPORT_SLUG[scope]}_${date}`;
  if (scope === 'backup' || format === 'json') {
    const text = scope === 'backup' ? await fullBackupJson() : await sheetsToJson(await collectSheets(scope));
    return {
      blob: new Blob([text], { type: 'application/json;charset=utf-8' }),
      filename: `${base}.json`,
      rowsCount: (text.match(/\n/g) ?? []).length,
      textPreview: text.split('\n').slice(0, 12).join('\n'),
    };
  }
  const sheets = await collectSheets(scope);
  const rowsCount = sheets.reduce((s, sh) => s + Math.max(0, sh.rows.length - 1), 0);
  const textPreview = sheets.map((sh) => sh.rows.slice(0, 6).map((r) => r.join(' | ')).join('\n')).join('\n\n');
  if (format === 'csv') {
    return { blob: new Blob([sheetsToCsv(sheets)], { type: 'text/csv;charset=utf-8' }), filename: `${base}.csv`, rowsCount, textPreview };
  }
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows as never);
    ws['!cols'] = sh.rows[0].map((h, ci) => ({
      wch: Math.min(48, Math.max(String(h).length, ...sh.rows.slice(1, 60).map((r) => String(r[ci] ?? '').length)) + 2),
    }));
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return {
    blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename: `${base}.xlsx`,
    rowsCount,
    textPreview,
  };
}
