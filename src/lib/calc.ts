import type { AccountRec, Commission, EstimateLine, Member, Operation, Role, TimesheetEntry, VedC } from '../types';
import { capC, LINE_CODES, LINE_NAME, NIGHT_K, REGION_K, WEEKEND_K } from './rules';

// ── Резолвер названий статей (задача 21) ─────────────────────────────
/** Стандартное имя, затем реестр пользовательских, затем сам код */
export function lineName(code: string, custom: Record<string, string> = {}): string {
  return LINE_NAME[code] ?? custom[code] ?? code;
}

/** Порядок сортировки: стандартные по матрице, пользовательские следом по алфавиту */
export function lineSort(a: string, b: string): number {
  const ia = (LINE_CODES as readonly string[]).indexOf(a);
  const ib = (LINE_CODES as readonly string[]).indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b, 'ru');
}

// ── Движок вознаграждений (пост. ЦИК 10/101-9, РК ×1,8, Д = Д1 + Д2) ──
export interface PayRow {
  member: Member;
  dayH: number;
  nightH: number;
  weekendH: number;
  /** ставка с районным коэффициентом */
  rateK: number;
  daySum: number;
  nightSum: number;
  weekendSum: number;
  /** Д1 — база начисления */
  base: number;
  /** применённый коэффициент C (с учётом предела роли/местности) */
  c: number;
  /** Д2 — доплата за особые условия */
  d2: number;
  /** Итого: Д = Д1 + Д2 */
  total: number;
}

export interface PayTotals extends Omit<PayRow, 'member' | 'rateK' | 'c'> {}

export function calcPayroll(
  members: Member[],
  entries: TimesheetEntry[],
  vedC: VedC,
  regionK: number = REGION_K,
  far = false,
): { rows: PayRow[]; totals: PayTotals } {
  const byMember = new Map<number, { dayH: number; nightH: number; weekendH: number }>();
  for (const e of entries) {
    const acc = byMember.get(e.memberId) ?? { dayH: 0, nightH: 0, weekendH: 0 };
    acc.dayH += e.dayH;
    acc.nightH += e.nightH;
    acc.weekendH += e.weekendH;
    byMember.set(e.memberId, acc);
  }

  const rows: PayRow[] = members.map((m) => {
    const h = byMember.get(m.id) ?? { dayH: 0, nightH: 0, weekendH: 0 };
    const rateK = m.rate * regionK;
    const daySum = h.dayH * rateK;
    const nightSum = h.nightH * rateK * NIGHT_K;
    const weekendSum = h.weekendH * rateK * WEEKEND_K;
    const base = daySum + nightSum + weekendSum;
    const c = Math.min(Math.max(0, vedC[m.role as Role] ?? 0), capC(m.role as Role, far));
    const d2 = base * c;
    return {
      member: m,
      ...h,
      rateK,
      daySum,
      nightSum,
      weekendSum,
      base,
      c,
      d2,
      total: base + d2,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      dayH: acc.dayH + r.dayH,
      nightH: acc.nightH + r.nightH,
      weekendH: acc.weekendH + r.weekendH,
      daySum: acc.daySum + r.daySum,
      nightSum: acc.nightSum + r.nightSum,
      weekendSum: acc.weekendSum + r.weekendSum,
      base: acc.base + r.base,
      d2: acc.d2 + r.d2,
      total: acc.total + r.total,
    }),
    { dayH: 0, nightH: 0, weekendH: 0, daySum: 0, nightSum: 0, weekendSum: 0, base: 0, d2: 0, total: 0 },
  );

  return { rows, totals };
}

// ── Свод по статьям бюджета ──────────────────────────────────────────
export interface LineSum {
  code: string;
  name: string;
  limit: number;
  inSum: number;
  outSum: number;
  rest: number;
}

export function budgetLines(
  estimate: EstimateLine[],
  ops: Operation[],
  custom: Record<string, string> = {},
): LineSum[] {
  const codes = Array.from(
    new Set([...LINE_CODES, ...estimate.map((e) => e.lineCode), ...ops.map((o) => o.lineCode)]),
  );
  return codes
    .map((code) => {
      const limit = estimate.filter((e) => e.lineCode === code).reduce((s, e) => s + e.limit, 0);
      const inSum = ops.filter((o) => o.kind === 'in' && o.lineCode === code).reduce((s, o) => s + o.amount, 0);
      const outSum = ops.filter((o) => o.kind === 'out' && o.lineCode === code).reduce((s, o) => s + o.amount, 0);
      return { code, name: lineName(code, custom), limit, inSum, outSum, rest: limit - outSum };
    })
    .filter((l) => l.limit !== 0 || l.inSum !== 0 || l.outSum !== 0);
}

// ── Контрольные соотношения ──────────────────────────────────────────
export interface Check {
  id: string;
  title: string;
  ok: boolean | null;
  detail: string;
}

export function buildChecks(
  lines: LineSum[],
  accrued: number,
  payLimit: number,
  bankConfirmed: boolean,
  missingDocs: number,
): Check[] {
  const over = lines.filter((l) => l.outSum > l.limit && l.limit > 0);
  return [
    {
      id: 'limits',
      title: 'Расходы ≤ смета (построчно)',
      ok: over.length === 0,
      detail: over.length === 0 ? 'Превышений по направлениям нет' : `Превышение по: ${over.map((l) => l.code).join(', ')}`,
    },
    {
      id: 'pay-cap',
      title: 'Начислено вознаграждений ≤ лимит статьи PAY',
      ok: accrued <= payLimit,
      detail: `Начислено ${Math.round(accrued).toLocaleString('ru-RU')} ₽ при лимите ${Math.round(payLimit).toLocaleString('ru-RU')} ₽`,
    },
    {
      id: 'bank',
      title: 'Остаток по учёту = подтверждение банка',
      ok: bankConfirmed ? true : null,
      detail: bankConfirmed ? 'Сверка с банком подтверждена' : 'Требуется сверка и подтверждение банка',
    },
    {
      id: 'docs',
      title: 'У каждой операции есть документ-основание',
      ok: missingDocs === 0,
      detail: missingDocs === 0 ? 'Первичка полная' : `Без номера документа: ${missingDocs} операций`,
    },
  ];
}

// ── Сверка счетов с банком ───────────────────────────────────────────
export type ReconStatus = 'none' | 'ok' | 'bad';

export interface ReconRow {
  account: AccountRec;
  commission?: Commission;
  paidIn: number;
  paidOut: number;
  bookBalance: number;
  diff?: number;
  status: ReconStatus;
}

export function buildRecon(accounts: AccountRec[], ops: Operation[], commissions: Commission[]): ReconRow[] {
  const byId = new Map(commissions.map((c) => [c.id, c]));
  const rows = accounts.map((a) => {
    let paidIn = 0;
    let paidOut = 0;
    for (const o of ops) {
      if (o.channel !== 'bank') continue;
      if (o.commissionId !== a.commissionId || o.budget !== a.budget) continue;
      if (o.kind === 'in') paidIn += o.amount;
      else paidOut += o.amount;
    }
    const bookBalance = Math.round((paidIn - paidOut) * 100) / 100;
    let diff: number | undefined;
    let status: ReconStatus = 'none';
    if (a.statementBalance != null && Number.isFinite(a.statementBalance)) {
      diff = Math.round((a.statementBalance - bookBalance) * 100) / 100;
      status = Math.abs(diff) < 0.005 ? 'ok' : 'bad';
    }
    return { account: a, commission: byId.get(a.commissionId), paidIn, paidOut, bookBalance, diff, status };
  });
  rows.sort(
    (a, b) =>
      (a.commission?.code ?? '').localeCompare(b.commission?.code ?? '', 'ru') ||
      a.account.budget.localeCompare(b.account.budget),
  );
  return rows;
}

export function reconTotals(rows: ReconRow[]) {
  const t = { paidIn: 0, paidOut: 0, bookBalance: 0, withStatement: 0, matched: 0, total: rows.length };
  for (const r of rows) {
    t.paidIn += r.paidIn;
    t.paidOut += r.paidOut;
    t.bookBalance += r.bookBalance;
    if (r.status !== 'none') {
      t.withStatement += 1;
      if (r.status === 'ok') t.matched += 1;
    }
  }
  const p = (n: number) => Math.round(n * 100) / 100;
  t.paidIn = p(t.paidIn);
  t.paidOut = p(t.paidOut);
  t.bookBalance = p(t.bookBalance);
  return t;
}
