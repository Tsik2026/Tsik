import type { Budget, Role, VedC } from '../types';

// ── Календарь выборов ────────────────────────────────────────────────
export const ELECT = {
  title: 'Госдума-2026 · ЗС Красноярского края-2026',
  votingDays: ['2026-09-18', '2026-09-19', '2026-09-20'],
  votingLastDay: '2026-09-20',
} as const;

export const BUDGET_NAME: Record<Budget, string> = {
  fed: 'Федеральный бюджет',
  krai: 'Краевой бюджет',
};

export const BUDGET_SHORT: Record<Budget, string> = {
  fed: 'Федеральный 40201',
  krai: 'Краевой 40202',
};

export const ACCOUNT_NAME: Record<Budget, string> = {
  fed: '40201 «Средства федерального бюджета»',
  krai: '40202 «Средства бюджета субъекта РФ»',
};

// ── Вознаграждения: пост. ЦИК 10/101-9 ───────────────────────────────
/** Ставки, ₽/ч (прил. № 9 к пост. ЦИК 10/101-9) */
export const RATES: Record<Role, number> = {
  chair: 63,
  deputy: 57,
  secretary: 57,
  member: 45,
};

export const ROLE_NAME: Record<Role, string> = {
  chair: 'Председатель',
  deputy: 'Зам. председателя',
  secretary: 'Секретарь',
  member: 'Член комиссии',
};

export const LEVEL_NAME: Record<string, string> = {
  IKK: 'Комиссия субъекта (ИК КК)',
  TIK: 'Территориальная (ТИК)',
  UIK: 'Участковая (УИК)',
};

/** Множитель ночных часов */
export const NIGHT_K = 2;
/** Множитель часов в выходные/праздничные */
export const WEEKEND_K = 2;
/** Районный коэффициент (Норильск) */
export const REGION_K = 1.8;
/** Пределы коэффициента C по ролям (обычная местность) */
export const C_CAP: Record<Role, number> = {
  chair: 2,
  deputy: 1.5,
  secretary: 1.5,
  member: 1.5,
};
/** Предел C для районов, приравненных к Крайнему Северу */
export const C_CAP_FAR = 3;
/** Коэффициенты C по умолчанию */
export const C_DEFAULT: VedC = { chair: 0, deputy: 0, secretary: 0, member: 0 };

export function capC(role: Role, far = false): number {
  return far ? C_CAP_FAR : C_CAP[role];
}

// ── Статьи сметы ─────────────────────────────────────────────────────
export const LINE_NAME: Record<string, string> = {
  PAY: 'Доп. оплата труда (вознаграждение) членов комиссий',
  GPD: 'Выплаты по гражданско-правовым договорам',
  INF: 'Информирование избирателей',
  POLIGRAF: 'Полиграфия: бюллетени, бланки, пособия',
  TRANSPORT: 'Транспорт, доставка документов',
  SVYAZ: 'Связь, сопровождение ГАС «Выборы»',
  EQUIP: 'Оборудование участков, оргтехника',
  OBUCH: 'Обучение организаторов выборов',
  PROCHEE: 'Прочие расходы по решению комиссии',
};

/** Стандартный порядок статей */
export const LINE_CODES = [
  'PAY',
  'GPD',
  'INF',
  'POLIGRAF',
  'TRANSPORT',
  'SVYAZ',
  'EQUIP',
  'OBUCH',
  'PROCHEE',
] as const;

// ── Рубежи отчётности ────────────────────────────────────────────────
export const DEADLINES = [
  {
    id: 'uik-tik',
    title: 'УИК → ТИК: отчёт (прил. № 9) + первичка',
    date: '2026-09-30',
    rule: '≤ 10 дней со дня голосования',
  },
  {
    id: 'tik-ikk',
    title: 'ТИК → ИК КК: отчёт, Главная книга, регистры, закрытие счёта',
    date: '2026-10-10',
    rule: '≤ 20 дней со дня голосования',
  },
  {
    id: 'pay',
    title: 'Выплата вознаграждений УИК (один раз после голосования)',
    date: '2026-10-20',
    rule: 'пост. ЦИК 10/101-9',
  },
  {
    id: 'ikk-final',
    title: 'ИК КК: итоговый отчёт (≤ 3 мес. после публикации итогов)',
    date: '2026-12-31',
    rule: 'дата зависит от официальной публикации результатов',
  },
] as const;

// ── Чек-лист закрытия ────────────────────────────────────────────────
export const CHECKLIST = [
  { id: 'reconcile', title: 'Сверка учёта с выпиской банка (остаток = подтверждение банка)' },
  { id: 'vedomost', title: 'Расчётная ведомость (прил. № 6) утверждена и оплачена' },
  { id: 'primary', title: 'Первичка прошнурована, пронумерована, описана' },
  { id: 'glavkniga', title: 'Главная книга (ф. 0504072) и журналы операций сформированы' },
  { id: 'report10', title: 'Отчёт о поступлении и расходовании (прил. № 9) подписан' },
  { id: 'close', title: 'Счёт 40202 закрыт, подтверждение банка получено' },
] as const;

export const CHANNEL_NAME: Record<string, string> = {
  bank: 'банк',
  cash: 'касса',
  advance: 'подотчёт',
};
