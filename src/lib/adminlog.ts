import { db } from './db';

const KEY = 'adminLog';
const MAX = 200;

export interface AdminLogEntry {
  at: string;
  action: string;
}

/** Журнал действий администратора (локальный, кольцевой до 200 записей) */
export async function logAdmin(action: string): Promise<void> {
  let items: AdminLogEntry[] = [];
  try {
    const rec = await db.settings.get(KEY);
    if (rec) items = JSON.parse(rec.value);
  } catch {
    items = [];
  }
  items.unshift({ at: new Date().toISOString(), action });
  if (items.length > MAX) items = items.slice(0, MAX);
  await db.settings.put({ key: KEY, value: JSON.stringify(items) });
}

export async function readAdminLog(): Promise<AdminLogEntry[]> {
  const rec = await db.settings.get(KEY);
  if (!rec) return [];
  try {
    return JSON.parse(rec.value);
  } catch {
    return [];
  }
}

export async function clearAdminLog(): Promise<void> {
  await db.settings.put({ key: KEY, value: '[]' });
}

// ── Пользовательские страницы ────────────────────────────────────────
export async function addPage(title: string): Promise<number> {
  const last = await db.pages.orderBy('order').last();
  const id = await db.pages.add({
    title: title.trim() || 'Новая страница',
    body: '',
    order: (last?.order ?? 0) + 1,
    createdAt: new Date().toISOString(),
  } as never);
  await logAdmin(`Создана страница «${title.trim() || 'Новая страница'}»`);
  return id;
}

export async function updatePage(id: number, patch: Partial<{ title: string; body: string; order: number }>): Promise<void> {
  await db.pages.update(id, patch as never);
}

export async function removePage(id: number): Promise<void> {
  const page = await db.pages.get(id);
  await db.pages.delete(id);
  if (page) await logAdmin(`Удалена страница «${page.title}»`);
}

/** Перемещение пользовательской страницы вверх/вниз (обмен order с соседней) */
export async function movePage(id: number, delta: number): Promise<void> {
  const pages = await db.pages.orderBy('order').toArray();
  const idx = pages.findIndex((p) => p.id === id);
  const swap = idx + delta;
  if (idx < 0 || swap < 0 || swap >= pages.length) return;
  const a = pages[idx];
  const b = pages[swap];
  await db.pages.update(a.id, { order: b.order } as never);
  await db.pages.update(b.id, { order: a.order } as never);
}

// ── Очистка разделов данных ──────────────────────────────────────────
export const DATA_SECTION_NAME: Record<string, string> = {
  operations: 'Операции (банк и касса)',
  timesheet: 'Табели рабочего времени',
  advances: 'Подотчётные суммы',
  estimate: 'Сметы (все комиссии и бюджеты)',
  members: 'Составы всех комиссий',
  documents: 'Библиотека документов',
  accounts: 'Реестр расчётных счетов',
};

export async function clearDataSection(table: keyof typeof DATA_SECTION_NAME): Promise<void> {
  await (db as unknown as Record<string, { clear(): Promise<void> }>)[table].clear();
  await logAdmin(`Очищен раздел данных: ${DATA_SECTION_NAME[table]}`);
}
