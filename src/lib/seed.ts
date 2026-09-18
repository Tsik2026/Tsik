import { db } from './db';
import { RATES, REGION_K } from './rules';
import { FEMALE_NAMES, MALE, SURNAMES, TIK, UIKS } from '../data/registry';
import type { Role } from '../types';

const SEED_V3 = 'seeded_norilsk_v3';
const SEED_V2 = 'seeded_norilsk_v2';
const SEED_V1 = 'seeded_norilsk_v1';
export const SEED_DEFERRED = 'seed:deferred';

// ── Детерминированный генератор составов УИК ─────────────────────────
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 1831565813) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const femSurname = (s: string) => (s.endsWith('ский') ? `${s.slice(0, -4)}ская` : `${s}а`);
const femPatr = (p: string) => p.replace(/ич$/, 'на');
const ROLE_SET: Role[] = ['chair', 'deputy', 'secretary', 'member', 'member', 'member', 'member', 'member', 'member'];

/** Детерминированный состав УИК по её номеру (стабилен между сессиями) */
export function genUikMembers(uikNo: number): Array<{ fio: string; role: Role }> {
  const rnd = mulberry(uikNo * 7919 + 13);
  const used = new Set<string>();
  const fio = (female: boolean): string => {
    for (;;) {
      const sur = SURNAMES[(rnd() * SURNAMES.length) | 0];
      const name = female
        ? `${femSurname(sur)} ${FEMALE_NAMES[(rnd() * FEMALE_NAMES.length) | 0]} ${femPatr(MALE[(rnd() * MALE.length) | 0][1])}`
        : `${sur} ${MALE[(rnd() * MALE.length) | 0][0]} ${MALE[(rnd() * MALE.length) | 0][1]}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  return ROLE_SET.map((role) => ({ fio: fio(rnd() < 0.55), role }));
}

// ── Сиды ─────────────────────────────────────────────────────────────
async function ensureRoots() {
  let ikk = await db.commissions.where('level').equals('IKK').first();
  if (!ikk) {
    const id = await db.commissions.add({
      code: 'ИК КК',
      name: 'Избирательная комиссия Красноярского края',
      level: 'IKK',
      budget: 'krai',
      account: '40202810400003000001',
      bank: 'Отделение Красноярск Банка России',
      chair: 'Председатель ИК КК',
      accountant: 'Главный бухгалтер',
    } as never);
    ikk = { id } as never;
  }
  let tik = await db.commissions
    .where('level')
    .equals('TIK')
    .filter((c) => c.code === 'ТИК Норильск')
    .first();
  if (!tik) {
    const id = await db.commissions.add({
      code: 'ТИК Норильск',
      name: TIK.fullName,
      level: 'TIK',
      parentId: ikk!.id,
      budget: 'krai',
      account: '40202810700002000063',
      bank: TIK.bank,
      chair: TIK.chair,
      accountant: 'бухгалтер (по договору)',
      address: TIK.address,
      phone: TIK.phone,
    } as never);
    tik = { id } as never;
  }
  return { ikk: ikk!.id, tik: tik!.id };
}

export async function ensureUiks() {
  const { tik } = await ensureRoots();
  const existing = new Set(
    (await db.commissions.where('level').equals('UIK').toArray())
      .map((c) => c.uikNo)
      .filter((n): n is number => typeof n === 'number'),
  );
  const toAdd = UIKS.filter((u) => !existing.has(u.num)).map((u) => ({
    code: `УИК № ${u.num}`,
    name: `Участковая избирательная комиссия № ${u.num}`,
    level: 'UIK' as const,
    parentId: tik,
    budget: 'krai' as const,
    uikNo: u.num,
    district: u.district,
    venue: u.venue,
    address: u.address,
    phone: u.phone,
  }));
  if (toAdd.length) await db.commissions.bulkAdd(toAdd as never[]);
  return { added: toAdd.length, skipped: UIKS.length - toAdd.length };
}

/** Ленивое заполнение составов УИК демо-данными */
export async function fillUikMembers() {
  const uiks = await db.commissions.where('level').equals('UIK').toArray();
  let filled = 0;
  let skipped = 0;
  for (const u of uiks) {
    if ((await db.members.where('commissionId').equals(u.id).count()) > 0 || typeof u.uikNo !== 'number') {
      skipped += 1;
      continue;
    }
    const gen = genUikMembers(u.uikNo);
    await db.members.bulkAdd(
      gen.map((g) => ({
        commissionId: u.id,
        fio: g.fio,
        role: g.role,
        status: 'нештатный',
        rate: RATES[g.role],
        source: 'demo',
      })) as never[],
    );
    await db.commissions.update(u.id, { chair: gen[0].fio });
    filled += 1;
  }
  return { filled, skipped };
}

/** Миграция старого единого коэффициента vedK → vedC по ролям */
async function migrateVedC() {
  const [vedC, vedK] = await Promise.all([db.settings.get('vedC'), db.settings.get('vedK')]);
  if (!vedC && vedK) {
    const k = Math.min(3, Math.max(0, (Number(vedK.value) || 1) - 1));
    await db.settings.put({ key: 'vedC', value: JSON.stringify({ chair: k, deputy: k, secretary: k, member: k }) });
    await db.settings.delete('vedK');
  }
}

export async function ensureSeed() {
  await migrateVedC();
  if (await db.settings.get(SEED_V3)) return;
  if (await db.settings.get(SEED_V2)) {
    await db.settings.bulkPut([
      { key: SEED_V3, value: '1' },
      { key: SEED_DEFERRED, value: '1' },
    ]);
    return;
  }
  if (await db.settings.get(SEED_V1)) {
    await fillUikMembers();
    await db.settings.bulkPut([
      { key: SEED_V3, value: '1' },
      { key: SEED_DEFERRED, value: '1' },
    ]);
    return;
  }
  await clearData();
  await seedBase();
}

async function clearData() {
  await db.transaction('rw', [db.commissions, db.members, db.estimate, db.operations, db.timesheet, db.advances, db.settings], async () => {
    await Promise.all([
      db.commissions.clear(),
      db.members.clear(),
      db.estimate.clear(),
      db.operations.clear(),
      db.timesheet.clear(),
      db.advances.clear(),
    ]);
  });
}

export async function reseed() {
  await clearData();
  await seedBase();
  await seedDeferred();
  await db.settings.put({ key: SEED_DEFERRED, value: '1' });
}

async function seedBase() {
  await db.transaction('rw', [db.commissions, db.members, db.estimate, db.operations, db.timesheet, db.advances, db.settings], async () => {
    const { tik } = await ensureRoots();
    await ensureUiks();
    const m = (fio: string, role: Role) => ({ commissionId: tik, fio, role, status: 'нештатный', rate: 0 });
    await db.members.bulkAdd([
      m(TIK.chair, 'chair'),
      m(TIK.deputy, 'deputy'),
      m(TIK.secretary, 'secretary'),
      ...TIK.members.map((f) => m(f, 'member')),
    ] as never[]);

    // Смета: краевой бюджет
    const decisionKrai = 'решение ТИК города Норильска от 08.07.2026 № 12/3';
    const kraiLimits: Record<string, number> = {
      PAY: 2400000,
      GPD: 120000,
      INF: 260000,
      POLIGRAF: 190000,
      TRANSPORT: 90000,
      SVYAZ: 60000,
      EQUIP: 340000,
      OBUCH: 60000,
      PROCHEE: 20000,
    };
    await db.estimate.bulkAdd(
      Object.keys(kraiLimits).map((code) => ({
        commissionId: tik,
        budget: 'krai',
        lineCode: code,
        limit: kraiLimits[code],
        decision: decisionKrai,
      })) as never[],
    );

    // Смета: федеральный бюджет
    const decisionFed = 'пост. ЦИК от 24.06.2026 № 10/102-9 / распределение ИК КК от 14.07.2026 № 45/2';
    const fedLimits: Record<string, number> = { PAY: 1800000, INF: 160000, PROCHEE: 30000 };
    await db.estimate.bulkAdd(
      Object.entries(fedLimits).map(([code, limit]) => ({
        commissionId: tik,
        budget: 'fed',
        lineCode: code,
        limit,
        decision: decisionFed,
      })) as never[],
    );

    // Демонстрационные операции (краевой бюджет)
    const op = (
      date: string,
      kind: 'in' | 'out',
      lineCode: string,
      amount: number,
      docNo: string,
      docDate: string,
      counterparty: string,
      purpose: string,
      channel: 'bank' | 'cash' | 'advance' = 'bank',
    ) => ({ commissionId: tik, budget: 'krai' as const, date, kind, lineCode, amount, docNo, docDate, counterparty, purpose, channel });
    await db.operations.bulkAdd([
      op('2026-09-01', 'in', 'PROCHEE', 2200000, '14', '01.09.2026', 'ИК Красноярского края', 'Транш: средства краевого бюджета на подготовку и проведение выборов'),
      op('2026-09-12', 'in', 'PROCHEE', 1340000, '17', '12.09.2026', 'ИК Красноярского края', 'Транш 2: доведение сметы до лимита'),
      op('2026-09-05', 'out', 'POLIGRAF', 176000, '101', '05.09.2026', 'Типография «Заполярная правда»', 'Печать информационных материалов для 63 участков, договор 3-П от 28.08.2026'),
      op('2026-09-08', 'out', 'INF', 84000, '104', '08.09.2026', 'Редакция «Заполярная правда»', 'Информирование избирателей: публикации о местах голосования'),
      op('2026-09-10', 'out', 'EQUIP', 298600, '109', '10.09.2026', 'ООО «Северный офис»', 'Кабины для голосования, урны, стеллажи — Центральный, Талнах, Кайеркан'),
      op('2026-09-11', 'out', 'TRANSPORT', 42300, '112', '11.09.2026', 'ООО «НорильскАвто»', 'Доставка документов и оборудования на участки (вкл. Снежногорск)'),
      op('2026-09-15', 'out', 'SVYAZ', 27600, '118', '15.09.2026', 'ПАО «Ростелеком»', 'Каналы связи ГАС «Выборы»: ТИК + 63 УИК, резервный LTE'),
      op('2026-09-16', 'out', 'GPD', 60000, '121', '16.09.2026', 'ИП Горелов В.К.', 'ГПД № 7: настройка и сопровождение ГАС «Выборы»'),
      op('2026-09-17', 'out', 'INF', 79200, '124', '17.09.2026', 'ООО «Полиграф-Сервис»', 'Листовки и плакаты для информирования (проект «ИнформУИК»)'),
      op('2026-09-17', 'out', 'PROCHEE', 25000, 'КО-3', '17.09.2026', 'Ермолаева И.П. (УИК № 592)', 'Подотчёт: хозяйственные нужды участка', 'advance'),
      {
        commissionId: tik,
        budget: 'fed',
        date: '2026-07-10',
        kind: 'in',
        lineCode: 'PAY',
        amount: 1990000,
        docNo: '3',
        docDate: '10.07.2026',
        counterparty: 'ИК Красноярского края',
        purpose: 'Средства федерального бюджета (пост. ЦИК 10/102-9): вознаграждения и информирование',
        channel: 'bank',
      },
    ] as never[]);

    await db.settings.bulkPut([
      { key: SEED_V3, value: '1' },
      { key: 'vedC', value: JSON.stringify({ chair: 0, deputy: 0, secretary: 0, member: 0 }) },
      { key: 'regionK', value: String(REGION_K) },
      { key: 'bankConfirmed', value: '0' },
    ]);
  });
}

/** Отложенный сид: демо по УИК № 592 (состав, табель, аванс) */
export async function seedDeferred() {
  const uik = await db.commissions.where('uikNo').equals(592).first();
  let uikId: number | null = null;
  if (uik) {
    uikId = uik.id;
    if ((await db.members.where('commissionId').equals(uikId).count()) === 0) {
      await db.commissions.update(uikId, { chair: 'Ермолаева И.П.' });
      const m = (fio: string, role: Role) => ({
        commissionId: uikId!,
        fio,
        role,
        status: 'нештатный',
        rate: RATES[role],
        source: 'demo',
      });
      await db.members.bulkAdd([
        m('Ермолаева И.П.', 'chair'),
        m('Савельев Д.Н.', 'deputy'),
        m('Костромитина А.В.', 'secretary'),
        m('Белоусова М.С.', 'member'),
        m('Гаршин В.О.', 'member'),
        m('Терехова Л.Г.', 'member'),
        m('Прохорова Н.А.', 'member'),
        m('Широких В.Д.', 'member'),
      ] as never[]);
    }
  }
  await fillUikMembers();

  if (uikId != null && (await db.timesheet.count()) === 0) {
    const members = await db.members.where('commissionId').equals(uikId).toArray();
    const e = (memberId: number, date: string, dayH: number, nightH = 0, weekendH = 0) => ({ memberId, date, dayH, nightH, weekendH });
    const rows: Array<ReturnType<typeof e>> = [];
    members.forEach((mem) => {
      const id = mem.id;
      const isChair = mem.role === 'chair';
      rows.push(e(id, '2026-09-17', isChair ? 9 : 8));
      rows.push(e(id, '2026-09-18', 12, 2));
      rows.push(e(id, '2026-09-19', 0, 0, isChair ? 14 : 13));
      rows.push(e(id, '2026-09-20', 0, isChair ? 4 : 3, isChair ? 15 : 14));
    });
    if (rows.length) await db.timesheet.bulkAdd(rows as never[]);
  }

  if (uikId != null && (await db.advances.count()) === 0) {
    await db.advances.add({
      commissionId: uikId,
      person: 'Ермолаева И.П.',
      date: '2026-09-17',
      purpose: 'Хозяйственные нужды участка № 592 (вода, канцелярия, освещение кабин)',
      amount: 25000,
      reported: 18240,
      docsCount: 6,
      status: 'частично',
    } as never);
  }
}

/** Отложенный сид выполняется один раз */
export async function ensureDeferredSeed() {
  if (!(await db.settings.get(SEED_DEFERRED))) {
    await seedDeferred();
    await db.settings.put({ key: SEED_DEFERRED, value: '1' });
  }
}
