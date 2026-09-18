import { db } from './db';
import type { PageRec } from '../types';

export interface NavDef {
  id: string;
  label: string;
  short: string;
  hint: string;
}

/** Штатные разделы приложения */
export const SECTIONS: NavDef[] = [
  { id: 'dashboard', label: 'Дашборд', short: 'Дашборд', hint: 'Контроль и статус' },
  { id: 'estimate', label: 'Смета', short: 'Смета', hint: 'Лимиты и решения' },
  { id: 'payroll', label: 'Вознаграждения', short: 'Вознагр.', hint: 'Табель → ведомость (прил. 6)' },
  { id: 'operations', label: 'Банк и касса', short: 'Операции', hint: 'Счета 40201/40202' },
  { id: 'advances', label: 'Подотчёт', short: 'Подотчёт', hint: 'Авансовые отчёты УИК' },
  { id: 'reports', label: 'Отчётность', short: 'Отчёты', hint: 'Прил. № 10, Excel, печать' },
  { id: 'control', label: 'Календарь контроля', short: 'Контроль', hint: 'Дедлайны и чек-лист' },
  { id: 'directory', label: 'Справочники', short: 'Справочн.', hint: 'Комиссии и состав' },
];

export const SECTION_IDS = SECTIONS.map((s) => s.id);

export interface NavItem extends NavDef {
  hidden?: boolean;
  custom?: boolean;
}

export interface NavConfig {
  order: string[];
  items: Record<string, Partial<Pick<NavItem, 'label' | 'short' | 'hint' | 'hidden'>>>;
}

const KEY = 'navConfig';

export async function loadNav(): Promise<NavConfig> {
  const rec = await db.settings.get(KEY);
  if (!rec) return { order: [...SECTION_IDS], items: {} };
  try {
    const parsed = JSON.parse(rec.value);
    const order: string[] = Array.isArray(parsed.order)
      ? parsed.order.filter((id: string) => SECTION_IDS.includes(id))
      : [];
    for (const id of SECTION_IDS) if (!order.includes(id)) order.push(id);
    return { order, items: parsed.items ?? {} };
  } catch {
    return { order: [...SECTION_IDS], items: {} };
  }
}

export async function saveNav(cfg: NavConfig): Promise<void> {
  await db.settings.put({ key: KEY, value: JSON.stringify(cfg) });
}

/** Итоговая навигация: штатные разделы по конфигу + пользовательские страницы */
export function buildNav(cfg: NavConfig, pages: PageRec[]): NavItem[] {
  const defs = new Map(SECTIONS.map((s) => [s.id, s]));
  const out: NavItem[] = [];
  for (const id of cfg.order) {
    const def = defs.get(id);
    if (!def) continue;
    const o = cfg.items[id] ?? {};
    out.push({
      id,
      label: o.label?.trim() || def.label,
      short: o.short?.trim() || def.short,
      hint: o.hint?.trim() || def.hint,
      hidden: o.hidden === true,
    });
  }
  const sortedPages = [...pages].sort((a, b) => a.order - b.order);
  for (const p of sortedPages) {
    out.push({
      id: `page-${p.id}`,
      label: p.title,
      short: p.title.length > 9 ? `${p.title.slice(0, 8)}…` : p.title,
      hint: 'Пользовательская страница',
      hidden: false,
      custom: true,
    });
  }
  return out;
}

export async function moveNav(cfg: NavConfig, id: string, delta: number): Promise<NavConfig> {
  const order = [...cfg.order];
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return cfg;
  [order[i], order[j]] = [order[j], order[i]];
  const next = { ...cfg, order };
  await saveNav(next);
  return next;
}

export async function patchNavItem(
  cfg: NavConfig,
  id: string,
  patch: Partial<Pick<NavItem, 'label' | 'short' | 'hint' | 'hidden'>>,
): Promise<NavConfig> {
  const next: NavConfig = { ...cfg, items: { ...cfg.items, [id]: { ...cfg.items[id], ...patch } } };
  await saveNav(next);
  return next;
}
