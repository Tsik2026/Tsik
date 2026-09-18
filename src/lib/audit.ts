// ── Аудит финансовой отчётности «Комиссия.Финансы — Норильск» ───────
// Проверка в роли принимающей стороны (ИК КК ← ТИК ← УИК): соответствие
// требованиям Красноярского края к финансовой отчётности ТИК и УИК.
// Статусы: ok — «Соответствует», fail — «Несоответствие», fix — «Правки»
// (с пошаговой рекомендацией, где и что исправить).
import { db } from './db';
import { BUDGET_NAME, DEADLINES, ROLE_NAME } from './rules';
import { loadRates, getRegionK } from './settings';
import { buildRecon } from './calc';
import { daysLeft, rub } from './fmt';
import type { Budget, Commission, Member } from '../types';

export type AuditStatus = 'ok' | 'fail' | 'fix';

export const AUDIT_STATUS_NAME: Record<AuditStatus, string> = {
  ok: 'Соответствует',
  fail: 'Несоответствие',
  fix: 'Правки',
};

export interface AuditFinding {
  id: string;
  category: string;
  scope: 'ТИК и УИК' | 'ТИК' | 'УИК';
  status: AuditStatus;
  title: string;
  detail: string;
  norm: string;
  /** Пошаговая рекомендация по исправлению (для статусов «Правки»/«Несоответствие») */
  fix?: string[];
}

export interface AuditReport {
  at: string;
  trigger: 'manual' | 'auto';
  findings: AuditFinding[];
  ok: number;
  fail: number;
  fix: number;
}

const NORM = {
  smeta: 'пост. ЦИК 10/101-9, прил. № 9; решение ИК КК 98/1080-8',
  ops: 'пост. ЦИК 7/59-7; решение ИК КК 98/1080-8; пост. Администрации Норильска 442 (ред. 111)',
  separate: 'ст. 21 УЗ КК 11-4807 — раздельный учёт средств федерального и краевого бюджетов',
  pay: 'пост. ЦИК 10/101-9 (ставки, формула Д1, РК = 1,8 для Норильска)',
  advance: 'порядок выдачи подотчётных сумм: отчёт по авансу до новой выдачи, первичные документы',
  account: 'решение ИК КК 98/1080-8; счета 40201/40202, сверка с выпиской банка',
  deadline: 'пост. ЦИК 10/101-9: УИК → ТИК ≤ 10 дней, ТИК → ИК КК ≤ 20 дней со дня голосования',
  roster: 'реестр комиссий: пост. Администрации Норильска 442 (ред. 111)',
};

const shortCommission = (c: Commission) =>
  c.level === 'UIK' ? `УИК № ${c.uikNo ?? c.code}` : c.level === 'TIK' ? 'ТИК' : c.code;

// ── Сбор данных ──────────────────────────────────────────────────────
async function collect() {
  const [commissions, members, estimate, operations, timesheet, advances, accounts, documents, rates, regionK] =
    await Promise.all([
      db.commissions.toArray(),
      db.members.toArray(),
      db.estimate.toArray(),
      db.operations.toArray(),
      db.timesheet.toArray(),
      db.advances.toArray(),
      db.accounts.toArray(),
      db.documents.toArray(),
      loadRates(),
      getRegionK(),
    ]);
  return { commissions, members, estimate, operations, timesheet, advances, accounts, documents, rates, regionK };
}
type Data = Awaited<ReturnType<typeof collect>>;

// ── Проверки ─────────────────────────────────────────────────────────
function checkEstimatePresence(d: Data): AuditFinding {
  const withEstimate = new Set(d.estimate.map((e) => `${e.commissionId}:${e.budget}`));
  const missing = d.commissions.filter((c) => !withEstimate.has(`${c.id}:${c.budget}`));
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'estimate-presence',
    category: 'Смета и лимиты',
    scope: 'ТИК и УИК',
    title: 'Смета утверждена по каждой комиссии и бюджету',
    norm: NORM.smeta,
  };
  if (!missing.length)
    return { ...base, status: 'ok', detail: `Смета есть у всех ${d.commissions.length} комиссий по их основным бюджетам.` };
  const list = missing.slice(0, 12).map(shortCommission).join(', ');
  return {
    ...base,
    status: 'fix',
    detail: `Нет ни одной строки сметы у ${missing.length} комиссий: ${list}${missing.length > 12 ? ' и др.' : ''}.`,
    fix: [
      'Откройте карточку «Сметы · загрузка и шаблон» в панели Admin — там целевая комиссия и бюджет.',
      'Скачайте «Шаблон сметы (с текущими лимитами)», заполните лимиты по решению комиссии и загрузите файл — строки встанут автоматически.',
      'Либо в разделе «Смета» выберите комиссию в шапке и добавьте направления вручную: статья из списка → лимит → реквизиты решения → «Включить в смету».',
      'Повторите для каждой комиссии из списка выше.',
    ],
  };
}

function checkOverspend(d: Data): AuditFinding {
  const spent = new Map<string, number>();
  for (const o of d.operations) {
    if (o.kind !== 'out') continue;
    const k = `${o.commissionId}:${o.budget}:${o.lineCode}`;
    spent.set(k, (spent.get(k) ?? 0) + o.amount);
  }
  const over: Array<{ c: Commission; line: string; limit: number; fact: number }> = [];
  for (const e of d.estimate) {
    const k = `${e.commissionId}:${e.budget}:${e.lineCode}`;
    const fact = spent.get(k) ?? 0;
    if (fact > e.limit + 0.005) {
      const c = d.commissions.find((x) => x.id === e.commissionId);
      over.push({ c: c!, line: e.lineCode, limit: e.limit, fact });
    }
  }
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'estimate-overspend',
    category: 'Смета и лимиты',
    scope: 'ТИК и УИК',
    title: 'Расходы в пределах лимитов сметы (построчно)',
    norm: NORM.smeta,
  };
  if (!over.length) return { ...base, status: 'ok', detail: 'Превышений лимитов по строкам смет не выявлено.' };
  const list = over
    .slice(0, 10)
    .map((o) => `${shortCommission(o.c)} · ${o.line}: факт ${rub(o.fact)} при лимите ${rub(o.limit)}`)
    .join('; ');
  return {
    ...base,
    status: 'fail',
    detail: `Превышение лимита по ${over.length} строкам: ${list}.`,
    fix: [
      'Раздел «Смета» → выберите комиссию и бюджет в шапке → строка с пометкой «ПРЕВЫШЕНИЕ».',
      'Оформите перераспределение: заседание комиссии, решение в новой редакции (увеличить строку за счёт экономии других статей в пределах итога).',
      'В разделе «Смета» исправьте лимиты обеих строк (клик по полю лимита) и укажите реквизиты нового решения.',
      'Если превышение — ошибочная операция: «Банк и касса» → режим правки (переключатель в Admin) → клик по операции → исправьте статью/сумму.',
      'До устранения расходы по этой строке не проводить — принимающая сторона такой отчёт вернёт.',
    ],
  };
}

function checkEstimateDecision(d: Data): AuditFinding {
  const bad = d.estimate.filter((e) => !e.decision || e.decision.trim().length < 5);
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'estimate-decision',
    category: 'Смета и лимиты',
    scope: 'ТИК и УИК',
    title: 'У каждой строки сметы есть реквизиты решения комиссии',
    norm: NORM.smeta + ' — смета версионируется решением комиссии',
  };
  if (!bad.length) return { ...base, status: 'ok', detail: 'Реквизиты решения заполнены по всем строкам всех смет.' };
  const list = bad
    .slice(0, 10)
    .map((e) => {
      const c = d.commissions.find((x) => x.id === e.commissionId);
      return `${c ? shortCommission(c) : e.commissionId} · ${e.lineCode} (${BUDGET_NAME[e.budget]})`;
    })
    .join('; ');
  return {
    ...base,
    status: 'fix',
    detail: `Без реквизитов решения ${bad.length} строк: ${list}${bad.length > 10 ? ' и др.' : ''}.`,
    fix: [
      'Раздел «Смета» → нужная комиссия/бюджет → колонка «Решение комиссии (версия сметы)».',
      'Впишите реквизиты: «решение … от ДД.ММ.ГГГГ № …» — сохранение при выходе из поля.',
      'Если решения ещё нет — вынесите вопрос на ближайшее заседание; без него строка недействительна для принимающей стороны.',
    ],
  };
}

function checkFundingCover(d: Data): AuditFinding {
  const inSum = new Map<string, number>();
  for (const o of d.operations) {
    if (o.kind !== 'in') continue;
    const k = `${o.commissionId}:${o.budget}`;
    inSum.set(k, (inSum.get(k) ?? 0) + o.amount);
  }
  const limitSum = new Map<string, number>();
  for (const e of d.estimate) {
    const k = `${e.commissionId}:${e.budget}`;
    limitSum.set(k, (limitSum.get(k) ?? 0) + e.limit);
  }
  const problems: string[] = [];
  for (const [k, lim] of limitSum) {
    const funded = inSum.get(k) ?? 0;
    if (lim > funded + 0.005) {
      const [cid, budget] = k.split(':');
      const c = d.commissions.find((x) => x.id === Number(cid));
      problems.push(
        `${c ? shortCommission(c) : cid} (${BUDGET_NAME[budget as Budget]}): смета ${rub(lim)} при поступлении ${rub(funded)}`,
      );
    }
  }
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'estimate-funding',
    category: 'Смета и лимиты',
    scope: 'ТИК и УИК',
    title: 'Лимиты сметы не превышают поступившие средства',
    norm: NORM.smeta,
  };
  if (!problems.length)
    return { ...base, status: 'ok', detail: 'Итоги смет покрыты зарегистрированными поступлениями по всем комиссиям.' };
  return {
    ...base,
    status: 'fix',
    detail: `${problems.length} случаев: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ' и др.' : ''}.`,
    fix: [
      'Если деньги поступили, но не проведены: «Банк и касса» → «+ Операция» → вид «поступление», канал «банк», статья — любая служебная (приход лимита), дата и № по выписке.',
      'Если поступления ещё не было — лимиты завышены: приведите смету решением комиссии к фактически доведённому финансированию.',
      'Проверьте соответствие: Дашборд → карточки «Смета (лимит)» и «Поступило» должны сходиться.',
    ],
  };
}

function checkOpsDocs(d: Data): AuditFinding {
  const bad = d.operations.filter((o) => !o.docNo?.trim() || !o.docDate?.trim());
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'ops-doc',
    category: 'Операции и первичка',
    scope: 'ТИК и УИК',
    title: 'У каждой операции есть документ-основание (№ и дата)',
    norm: NORM.ops,
  };
  if (!bad.length)
    return { ...base, status: 'ok', detail: `Все ${d.operations.length} операций имеют номер и дату документа-основания.` };
  const list = bad
    .slice(0, 10)
    .map((o) => `операция № ${o.id} от ${o.date}, ${rub(o.amount)}`)
    .join('; ');
  return {
    ...base,
    status: 'fix',
    detail: `${bad.length} операций без номера или даты документа: ${list}${bad.length > 10 ? ' и др.' : ''}.`,
    fix: [
      'Раздел «Банк и касса» → включите «Режим правки» переключателем вверху Admin.',
      'Кликните по операции → заполните «№ документа» и «Дата документа» по платёжному поручению/кассовому ордеру → «Сохранить».',
      'Саму первичку отсканируйте в библиотеку: Admin → «Документы» → «Добавить» — при сдаче отчёта её запросят по реестру.',
    ],
  };
}

function checkOpsOrphans(d: Data): AuditFinding {
  const lines = new Set(d.estimate.map((e) => `${e.commissionId}:${e.budget}:${e.lineCode}`));
  const orphans = d.operations.filter((o) => !lines.has(`${o.commissionId}:${o.budget}:${o.lineCode}`));
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'ops-orphan',
    category: 'Операции и первичка',
    scope: 'ТИК и УИК',
    title: 'Каждая операция привязана к действующей статье сметы',
    norm: NORM.smeta,
  };
  if (!orphans.length) return { ...base, status: 'ok', detail: 'Осиротевших операций (без строки сметы) не выявлено.' };
  const list = orphans
    .slice(0, 10)
    .map((o) => `${o.lineCode} · ${rub(o.amount)} от ${o.date}`)
    .join('; ');
  return {
    ...base,
    status: 'fix',
    detail: `${orphans.length} операций ссылаются на статьи, которых нет в смете комиссии: ${list}${orphans.length > 10 ? ' и др.' : ''}.`,
    fix: [
      'Если направление нужно: «Смета» → «Добавить направление» → выберите эту статью из списка, лимит ≥ сумме операций, реквизиты решения.',
      'Если статья указана ошибочно: «Банк и касса» → режим правки → клик по операции → исправьте «Статья сметы».',
      'После правок повторите аудит — контрольное соотношение «расходы ≤ смета» должно быть зелёным на Дашборде.',
    ],
  };
}

function checkSeparateBudgets(d: Data): AuditFinding {
  const uikIds = new Set(d.commissions.filter((c) => c.level === 'UIK').map((c) => c.id));
  const bad = d.operations.filter((o) => uikIds.has(o.commissionId) && o.budget === 'fed');
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'ops-separate',
    category: 'Операции и первичка',
    scope: 'УИК',
    title: 'Раздельный учёт: УИК оперируют только средствами краевого бюджета',
    norm: NORM.separate,
  };
  if (!bad.length)
    return { ...base, status: 'ok', detail: 'Операций УИК по федеральному бюджету не выявлено — учёт раздельный.' };
  const sum = bad.reduce((s, o) => s + o.amount, 0);
  return {
    ...base,
    status: 'fail',
    detail: `${bad.length} операций УИК проведено по федеральному бюджету на ${rub(sum)} — нарушение ст. 21 УЗ КК 11-4807.`,
    fix: [
      '«Банк и касса» → переключите бюджет в шапке на «Федеральный 40201» → найдите операции этих УИК.',
      'Режим правки → клик по операции → смените «Бюджет» на краевой (40202) → «Сохранить».',
      'Проверьте, что по краевому бюджету этой комиссии хватает лимита статьи (раздел «Смета»).',
      'В Главной книге и отчёте прил. № 10 эти суммы должны фигурировать только по краевому бюджету.',
    ],
  };
}

function checkOpsAmounts(d: Data): AuditFinding {
  const bad = d.operations.filter((o) => !(o.amount > 0));
  const future = d.operations.filter((o) => daysLeft(o.date) < 0);
  const base: Omit<AuditFinding, 'status' | 'detail' | 'fix'> = {
    id: 'ops-amount',
    category: 'Операции и первичка',
    scope: 'ТИК и УИК',
    title: 'Суммы положительные, даты операций не в будущем',
    norm: NORM.ops,
  };
  const parts: string[] = [];
  if (bad.length) parts.push(`${bad.length} операций с нулевой/отрицательной суммой`);
  if (future.length) parts.push(`${future.length} операций датированы будущим числом`);
  if (!parts.length) return { ...base, status: 'ok', detail: 'Арифметика операций корректна, будущих дат нет.' };
  return {
    ...base,
    status: 'fix',
    detail: `Выявлено: ${parts.join('; ')}.`,
    fix: [
      '«Банк и касса» → режим правки → клик по проблемной операции.',
      'Исправьте сумму (положительное число, копейки через точку) или дату проводки по документу-основанию.',
      'Если операция заведена ошибочно — там же кнопка «Удалить запись» (действие попадёт в журнал Admin).',
    ],
  };
}

function checkAdvances(d: Data): AuditFinding[] {
  const out: AuditFinding[] = [];
  const open = d.advances.filter((a) => a.status === 'выдан' || a.status === 'частично');
  const oldOpen = open.filter((a) => daysLeft(a.date) < -10);
  out.push({
    id: 'advance-open',
    category: 'Подотчёт',
    scope: 'ТИК и УИК',
    title: 'Подотчётные суммы закрыты в срок',
    norm: NORM.advance,
    status: oldOpen.length ? 'fix' : 'ok',
    detail: oldOpen.length
      ? `${oldOpen.length} авансов не закрыты более 10 дней: ${oldOpen
          .slice(0, 8)
          .map((a) => `${a.person} — ${rub(a.amount - a.reported)} с ${a.date}`)
          .join('; ')}.`
      : open.length
        ? `Открытых авансов ${open.length}, все свежие (до 10 дней) — срок отчёта не нарушен.`
        : 'Открытых подотчётных сумм нет.',
    fix: oldOpen.length
      ? [
          'Раздел «Подотчёт» → строка с просроченным авансом → внесите отчёт: сумма «Отчитано», число документов, статус «сдан»/«проверен».',
          'Непотраченный остаток — возврат в кассу операцией «поступление» с каналом «подотчёт» в разделе «Банк и касса».',
          'По уволенным/недееспособным подотчётным — удержание из вознаграждения решением комиссии; зафиксируйте в примечании.',
        ]
      : undefined,
  });
  // новый аванс при незакрытом старом у того же лица
  const byPerson = new Map<string, typeof d.advances>();
  for (const a of d.advances) {
    const list = byPerson.get(a.person) ?? [];
    list.push(a);
    byPerson.set(a.person, list);
  }
  const viol: string[] = [];
  for (const [person, list] of byPerson) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if ((prev.status === 'выдан' || prev.status === 'частично') && prev.reported < prev.amount) {
        viol.push(`${person} (аванс от ${sorted[i].date} при незакрытом от ${prev.date})`);
      }
    }
  }
  out.push({
    id: 'advance-chain',
    category: 'Подотчёт',
    scope: 'ТИК и УИК',
    title: 'Новый аванс не выдавался при неотчитанном предыдущем',
    norm: NORM.advance,
    status: viol.length ? 'fail' : 'ok',
    detail: viol.length
      ? `Нарушение у ${viol.length} лиц: ${viol.slice(0, 8).join('; ')}${viol.length > 8 ? ' и др.' : ''}.`
      : 'Цепочек «новый аванс при незакрытом старом» не выявлено.',
    fix: viol.length
      ? [
          'Раздел «Подотчёт» → по каждому лицу закройте предыдущий аванс (отчёт + документы или возврат остатка).',
          'Статус «сдан» проставьте только при полном комплекте первички — принимающая сторона сверяет документы по реестру.',
          'Впредь: выдачу следующего аванса проводите только после статуса «сдан»/«проверен» по предыдущему.',
        ]
      : undefined,
  });
  const noDocs = d.advances.filter((a) => (a.status === 'сдан' || a.status === 'проверен') && !(a.docsCount > 0));
  out.push({
    id: 'advance-docs',
    category: 'Подотчёт',
    scope: 'ТИК и УИК',
    title: 'У сданных авансовых отчётов указано число приложенных документов',
    norm: NORM.advance,
    status: noDocs.length ? 'fix' : 'ok',
    detail: noDocs.length
      ? `${noDocs.length} сданных отчётов с нулевым числом документов: ${noDocs
          .slice(0, 8)
          .map((a) => `${a.person} (${a.date})`)
          .join('; ')}.`
      : 'По всем сданным отчётам число приложенных документов заполнено.',
    fix: noDocs.length
      ? [
          'Раздел «Подотчёт» → режим правки → клик по авансу → поле «Документов, шт.» → укажите фактическое число листов первички.',
          'Сверьте с бумажным авансовым отчётом: количество должно совпадать с опиской приложений.',
        ]
      : undefined,
  });
  return out;
}

function checkPayroll(d: Data): AuditFinding[] {
  const out: AuditFinding[] = [];
  const payLimit = new Map<string, number>();
  for (const e of d.estimate) {
    if (e.lineCode !== 'PAY') continue;
    payLimit.set(`${e.commissionId}:${e.budget}`, e.limit);
  }
  const membersById = new Map<number, Member>(d.members.map((m) => [m.id, m]));
  const accrued = new Map<number, number>();
  for (const t of d.timesheet) {
    const m = membersById.get(t.memberId);
    if (!m) continue;
    const hours = t.dayH + t.nightH * 2 + t.weekendH * 2;
    accrued.set(m.commissionId, (accrued.get(m.commissionId) ?? 0) + hours * m.rate * d.regionK);
  }
  const over: string[] = [];
  for (const [cid, sum] of accrued) {
    const lim = payLimit.get(`${cid}:krai`) ?? payLimit.get(`${cid}:fed`);
    if (lim !== undefined && sum > lim + 0.005) {
      const c = d.commissions.find((x) => x.id === cid);
      over.push(`${c ? shortCommission(c) : cid}: начислено ${rub(sum)} при лимите ${rub(lim)}`);
    }
  }
  out.push({
    id: 'pay-limit',
    category: 'Вознаграждения и табель',
    scope: 'ТИК и УИК',
    title: 'Начисленные вознаграждения в пределах лимита статьи PAY',
    norm: NORM.pay,
    status: over.length ? 'fail' : 'ok',
    detail: over.length ? `Превышение лимита PAY: ${over.slice(0, 8).join('; ')}.` : 'Начисления по табелю не превышают лимиты PAY.',
    fix: over.length
      ? [
          'Раздел «Вознаграждения» → проверьте табель: лишние/дублирующие часы исправьте в сетке или через режим правки.',
          'Если часы верны — лимит PAY увеличивается решением комиссии за счёт других статей (раздел «Смета», новая редакция).',
          'Ведомость (прил. № 6) формируйте только после устранения превышения.',
        ]
      : undefined,
  });
  const offRate = d.members.filter((m) => Math.abs(m.rate - d.rates[m.role]) > 0.005);
  out.push({
    id: 'rates',
    category: 'Вознаграждения и табель',
    scope: 'ТИК и УИК',
    title: 'Ставки членов комиссий соответствуют утверждённым',
    norm: `${NORM.pay}; действующие ставки: председатель ${d.rates.chair}, зам./секретарь ${d.rates.deputy}, член ${d.rates.member} ₽/ч`,
    status: offRate.length ? 'fix' : 'ok',
    detail: offRate.length
      ? `${offRate.length} членов комиссий со ставкой вне норматива: ${offRate
          .slice(0, 8)
          .map((m) => `${m.fio} (${ROLE_NAME[m.role]}) — ${m.rate} ₽/ч вместо ${d.rates[m.role]} ₽/ч`)
          .join('; ')}.`
      : `Ставки всех ${d.members.length} членов комиссий совпадают с утверждёнными.`,
    fix: offRate.length
      ? [
          'Admin → «Ставки и данные» → проверьте сетку ставок; если норматив изменился — введите новые значения и отметьте «Применить ко всем уже внесённым членам комиссий» → «Сохранить ставки».',
          'Точечно: «Справочники» → комиссия → член комиссии → режим правки → поле «Ставка, ₽/час».',
          'После правки пересчитайте ведомость: раздел «Вознаграждения» → суммы обновятся автоматически.',
        ]
      : undefined,
  });
  const badHours = d.timesheet.filter((t) => t.dayH + t.nightH + t.weekendH > 24 || t.dayH < 0 || t.nightH < 0 || t.weekendH < 0);
  const ghost = d.timesheet.filter((t) => !membersById.has(t.memberId));
  out.push({
    id: 'timesheet',
    category: 'Вознаграждения и табель',
    scope: 'УИК',
    title: 'Табель: часы в допустимых пределах, все записи привязаны к людям',
    norm: NORM.pay,
    status: badHours.length || ghost.length ? 'fix' : 'ok',
    detail:
      badHours.length || ghost.length
        ? [
            badHours.length ? `${badHours.length} записей с суммой часов > 24 или отрицательными значениями` : '',
            ghost.length ? `${ghost.length} записей ссылаются на удалённых людей` : '',
          ]
            .filter(Boolean)
            .join('; ') + '.'
        : 'Все записи табеля корректны и привязаны к действующим членам комиссий.',
    fix:
      badHours.length || ghost.length
        ? [
            'Раздел «Вознаграждения» → выберите УИК → сетка табеля → исправьте часы прямо в ячейке (сохранение при выходе).',
            'Записи без человека удалите через режим правки (Admin → переключатель «Режим правки» → клик по записи табеля → «Удалить запись»).',
            'Если ошибка пришла из файла — исправьте исходный табель и загрузите повторно: повторная загрузка обновляет часы, а не дублирует.',
          ]
        : undefined,
  });
  const noChair = d.commissions.filter(
    (c) => c.level !== 'IKK' && !d.members.some((m) => m.commissionId === c.id && m.role === 'chair'),
  );
  out.push({
    id: 'chair',
    category: 'Вознаграждения и табель',
    scope: 'ТИК и УИК',
    title: 'В составе каждой комиссии есть председатель',
    norm: NORM.roster,
    status: noChair.length ? 'fix' : 'ok',
    detail: noChair.length
      ? `Нет председателя в ${noChair.length} комиссиях: ${noChair.slice(0, 12).map(shortCommission).join(', ')}${noChair.length > 12 ? ' и др.' : ''}.`
      : 'Председатель назначен в составе каждой комиссии.',
    fix: noChair.length
      ? [
          '«Справочники» → карточка комиссии → вкладка состава → добавьте председателя (ФИО по решению о назначении).',
          'Либо загрузите актуальный список членов УИК через Admin → «Файлы» — система сама расставит роли.',
          'Ведомость прил. № 6 без председателя не подписывается — исправьте до формирования отчётности.',
        ]
      : undefined,
  });
  return out;
}

function checkAccounts(d: Data): AuditFinding[] {
  const out: AuditFinding[] = [];
  const need: string[] = [];
  for (const c of d.commissions) {
    if (c.level === 'IKK') continue;
    const budgets: Budget[] = c.level === 'TIK' ? ['fed', 'krai'] : [c.budget];
    for (const b of budgets) {
      if (!d.accounts.some((a) => a.commissionId === c.id && a.budget === b)) {
        need.push(`${shortCommission(c)} (${BUDGET_NAME[b]})`);
      }
    }
  }
  const badNumber = d.accounts.filter((a) => !/^\d{20}$/.test(a.number.replace(/\s/g, '')));
  out.push({
    id: 'accounts-present',
    category: 'Счета и сверка',
    scope: 'ТИК и УИК',
    title: 'Расчётные счета заведены (20 цифр) по каждому бюджету',
    norm: NORM.account,
    status: need.length || badNumber.length ? 'fix' : 'ok',
    detail:
      need.length || badNumber.length
        ? [
            need.length ? `нет счёта у ${need.length} связок: ${need.slice(0, 8).join('; ')}${need.length > 8 ? ' и др.' : ''}` : '',
            badNumber.length ? `некорректный номер (не 20 цифр) у ${badNumber.length} счетов` : '',
          ]
            .filter(Boolean)
            .join('; ') + '.'
        : 'Счета заведены по всем комиссиям и бюджетам, номера корректны.',
    fix:
      need.length || badNumber.length
        ? [
            '«Календарь контроля» → «Счета и сверка» → кнопка «Заполнить из справочника» — подтянутся счета из карточек комиссий.',
            'Недостающие заведите вручную: комиссия, бюджет, номер (20 цифр), банк/РКЦ, дата открытия.',
            'Номер с пробелами/буквами исправьте режимом правки — проверка принимает только 20 цифр.',
          ]
        : undefined,
  });
  const rows = buildRecon(d.accounts, d.operations, d.commissions);
  const bad = rows.filter((r) => r.status === 'bad');
  const none = rows.filter((r) => r.status === 'none');
  out.push({
    id: 'recon',
    category: 'Счета и сверка',
    scope: 'ТИК и УИК',
    title: 'Остаток по учёту совпадает с подтверждением банка',
    norm: NORM.account,
    status: bad.length ? 'fail' : none.length ? 'fix' : 'ok',
    detail: bad.length
      ? `Расхождение по ${bad.length} счетам: ${bad
          .slice(0, 8)
          .map((r) => `${r.commission ? shortCommission(r.commission) : r.account.number} — разница ${rub(Math.abs(r.diff ?? 0))}`)
          .join('; ')}.`
      : none.length
        ? `По ${none.length} счетам не внесён остаток по выписке — сверка не проведена.`
        : `Все ${rows.length} счетов сверены: учёт сходится с выписками.`,
    fix:
      bad.length || none.length
        ? [
            '«Календарь контроля» → «Счета и сверка» → по каждому счёту внесите «Остаток по выписке» и «Дата выписки» из банковского документа.',
            'При расхождении: сверьте обороты — «Банк и касса» (канал «банк») против выписки; найденную разницу проведите недостающей операцией или исправьте ошибочную (режим правки).',
            'Банковские комиссии/проценты, которых нет в учёте, — частая причина копеечного расхождения: проведите их отдельной операцией.',
            'До статуса «совпадает» отчёт к сдаче не готов — принимающая сторона требует подтверждение банка.',
          ]
        : undefined,
  });
  const closeDeadline = DEADLINES.find((x) => x.id === 'tik-ikk');
  const left = closeDeadline ? daysLeft(closeDeadline.date) : 999;
  const unclosed = d.accounts.filter((a) => !a.closed);
  out.push({
    id: 'accounts-closed',
    category: 'Счета и сверка',
    scope: 'УИК',
    title: 'Счета УИК закрыты после сдачи отчётности',
    norm: NORM.deadline + '; закрытие счёта после перечисления остатка',
    status: left < 0 && unclosed.length ? 'fix' : 'ok',
    detail:
      left < 0 && unclosed.length
        ? `Срок закрытия прошёл, а ${unclosed.length} счетов всё ещё открыты.`
        : left < 0
          ? 'Все счета закрыты в установленном порядке.'
          : `До рубежа закрытия (${closeDeadline?.date.split('-').reverse().join('.')}) — ${left} дн.; закрытие пока не требуется.`,
    fix:
      left < 0 && unclosed.length
        ? [
            'Перечислите остаток средств по реквизитам вышестоящей комиссии (операция «расход», канал «банк»).',
            '«Календарь контроля» → «Счета и сверка» → режим правки → поле «Дата закрытия» → укажите дату из заявления на закрытие.',
            'Приложите к отчёту ТИК справку банка о закрытии счёта и нулевом остатке.',
          ]
        : undefined,
  });
  return out;
}

function checkRegistry(d: Data): AuditFinding[] {
  const out: AuditFinding[] = [];
  const empty = d.commissions.filter((c) => c.level !== 'IKK' && !d.members.some((m) => m.commissionId === c.id));
  out.push({
    id: 'roster',
    category: 'Состав и реестр',
    scope: 'ТИК и УИК',
    title: 'Состав внесён по каждой комиссии',
    norm: NORM.roster,
    status: empty.length ? 'fix' : 'ok',
    detail: empty.length
      ? `Пустой состав у ${empty.length} комиссий: ${empty.slice(0, 12).map(shortCommission).join(', ')}${empty.length > 12 ? ' и др.' : ''}.`
      : `Составы внесены: ${d.members.length} чел. по всем комиссиям.`,
    fix: empty.length
      ? [
          'Admin → «Файлы» → перетащите список членов УИК (xlsx/csv/txt с сайта Администрации) — система распознает ФИО и роли и разместит автоматически.',
          'Либо вручную: «Справочники» → комиссия → добавление членов по одному.',
          'Пустой состав при сданном табеле — гарантированный возврат отчётности.',
        ]
      : undefined,
  });
  const uiks = d.commissions.filter((c) => c.level === 'UIK');
  const incomplete = uiks.filter((c) => !c.venue?.trim() || !c.address?.trim());
  out.push({
    id: 'registry-cards',
    category: 'Состав и реестр',
    scope: 'УИК',
    title: 'Карточки УИК заполнены (помещение для голосования, адрес)',
    norm: NORM.roster,
    status: incomplete.length ? 'fix' : 'ok',
    detail: incomplete.length
      ? `Неполные карточки у ${incomplete.length} УИК: ${incomplete.slice(0, 12).map(shortCommission).join(', ')}${incomplete.length > 12 ? ' и др.' : ''}.`
      : `Все ${uiks.length} карточек УИК содержат помещение и адрес.`,
    fix: incomplete.length
      ? [
          '«Справочники» → карточка УИК → режим правки → поля «Помещение для голосования» и «Адрес» → «Сохранить».',
          'Сверьте с пост. Администрации Норильска 442 (ред. 111) — адреса должны совпадать с официальным реестром.',
          'Актуальный реестр можно обновить через «Справочники» → «Обновить сейчас» (автосинхронизация с подключённым источником).',
        ]
      : undefined,
  });
  return out;
}

// ── Движок ───────────────────────────────────────────────────────────
export async function runAudit(trigger: 'manual' | 'auto' = 'manual'): Promise<AuditReport> {
  const d = await collect();
  const findings: AuditFinding[] = [
    checkEstimatePresence(d),
    checkOverspend(d),
    checkEstimateDecision(d),
    checkFundingCover(d),
    checkOpsDocs(d),
    checkOpsOrphans(d),
    checkSeparateBudgets(d),
    checkOpsAmounts(d),
    ...checkAdvances(d),
    ...checkPayroll(d),
    ...checkAccounts(d),
    ...checkRegistry(d),
  ];
  const fail = findings.filter((f) => f.status === 'fail').length;
  const fix = findings.filter((f) => f.status === 'fix').length;
  // итоговая готовность к рубежу — зависит от остальных проверок
  const next = DEADLINES.map((x) => ({ ...x, left: daysLeft(x.date) }))
    .filter((x) => x.left >= 0)
    .sort((a, b) => a.left - b.left)[0];
  if (next) {
    const urgent = next.left <= 10;
    const status: AuditStatus = fail > 0 ? 'fail' : fix > 0 && urgent ? 'fail' : fix > 0 ? 'fix' : 'ok';
    findings.push({
      id: 'deadline',
      category: 'Готовность к отчётности',
      scope: 'ТИК и УИК',
      title: 'Готовность к ближайшему отчётному рубежу',
      norm: NORM.deadline,
      status,
      detail:
        `Ближайший рубеж: «${next.title}» — ${next.date.split('-').reverse().join('.')}, осталось ${next.left} дн. ` +
        (fail > 0
          ? `При этом выявлены несоответствия (${fail}) — отчёт в текущем виде будет возвращён.`
          : fix > 0
            ? `Открытых правок: ${fix} — устраните до сдачи.`
            : 'Все контрольные соотношения выполняются — отчётность готова к сдаче.'),
      fix:
        status !== 'ok'
          ? [
              'Пройдите по пунктам этого разбора сверху вниз: сначала «Несоответствие» (красные), затем «Правки» (жёлтые).',
              'После каждой серии исправлений нажимайте «Подготовить полный отчёт / Проверить и дать совет» — ручная проверка доступна на любом этапе, вплоть до дня сдачи.',
              'Сформируйте пакет: «Отчётность» → прил. № 9/№ 10, Excel, печать; библиотека документов — Admin → «Документы».',
            ]
          : undefined,
    });
  }
  const finalOk = findings.filter((f) => f.status === 'ok').length;
  const finalFail = findings.filter((f) => f.status === 'fail').length;
  const finalFix = findings.filter((f) => f.status === 'fix').length;
  const report: AuditReport = { at: new Date().toISOString(), trigger, findings, ok: finalOk, fail: finalFail, fix: finalFix };
  await saveLastAudit(report);
  return report;
}

// ── Хранение результатов и ночной автопрогон ─────────────────────────
const KEY_LAST = 'audit:last';
const KEY_LAST_AUTO = 'audit:lastAuto';
const KEY_SEEN = 'audit:seenAt';

export async function loadLastAudit(): Promise<AuditReport | null> {
  const rec = await db.settings.get(KEY_LAST);
  if (!rec) return null;
  try {
    return JSON.parse(rec.value) as AuditReport;
  } catch {
    return null;
  }
}

async function saveLastAudit(report: AuditReport) {
  await db.settings.put({ key: KEY_LAST, value: JSON.stringify(report) });
}

export async function markAuditSeen(at: string) {
  await db.settings.put({ key: KEY_SEEN, value: at });
}

/** Непросмотренный результат автопрогона (для мигающего окна) */
export async function unseenAutoAudit(): Promise<AuditReport | null> {
  const [last, seen] = await Promise.all([loadLastAudit(), db.settings.get(KEY_SEEN)]);
  if (!last || last.trigger !== 'auto') return null;
  if (seen && seen.value >= last.at) return null;
  return last;
}

const NIGHT_FROM = 0; // 00:00
const NIGHT_TO = 5; // до 05:00

/**
 * Ночной автопрогон: один раз в сутки в окне 00:00–05:00.
 * Если приложение ночью не открывалось — догоняющий прогон при первом
 * открытии позже (но не чаще одного раза в 24 часа).
 */
export async function maybeAutoAudit(): Promise<AuditReport | null> {
  const now = new Date();
  const rec = await db.settings.get(KEY_LAST_AUTO);
  const lastAt = rec ? new Date(rec.value) : null;
  if (lastAt) {
    const sameDay = lastAt.toDateString() === now.toDateString();
    if (sameDay) return null;
    if (now.getTime() - lastAt.getTime() < 24 * 3600 * 1000) return null;
  }
  const hour = now.getHours();
  const isNight = hour >= NIGHT_FROM && hour < NIGHT_TO;
  const overdue = !lastAt || now.getTime() - lastAt.getTime() >= 24 * 3600 * 1000;
  if (!isNight && !overdue) return null;
  const report = await runAudit('auto');
  await db.settings.put({ key: KEY_LAST_AUTO, value: report.at });
  return report;
}
