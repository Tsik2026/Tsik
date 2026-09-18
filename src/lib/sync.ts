import { db } from './db';
import { logAdmin } from './adminlog';
import { RATES } from './rules';
import type { Role } from '../types';

// ── Источники данных: автообновление реестра комиссий ────────────────
const KEY_SOURCES = 'dataSources';
const KEY_AUTO = 'autoSync';
const KEY_LAST = 'sync:last';
const appliedKey = (id: string) => `sync:applied:${id}`;

export interface DataSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export const DEFAULT_SOURCES: DataSource[] = [
  {
    id: 'registry-norilsk',
    name: 'Реестр комиссий Норильска (ТИК + 63 УИК)',
    url: 'https://tsik2026.github.io/Tsik/data/registry-norilsk.json',
    enabled: true,
  },
];

export interface SyncReport {
  at: string;
  trigger: 'start' | 'gesture' | 'manual';
  ok: boolean;
  changed: boolean;
  lines: string[];
}

export async function getSources(): Promise<DataSource[]> {
  const rec = await db.settings.get(KEY_SOURCES);
  if (!rec) return DEFAULT_SOURCES;
  try {
    const parsed = JSON.parse(rec.value);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_SOURCES;
  } catch {
    return DEFAULT_SOURCES;
  }
}

export async function saveSources(list: DataSource[]) {
  await db.settings.put({ key: KEY_SOURCES, value: JSON.stringify(list) });
}

export async function isAutoUpdate(): Promise<boolean> {
  const rec = await db.settings.get(KEY_AUTO);
  return rec ? rec.value !== '0' : true;
}

export async function setAutoUpdate(on: boolean) {
  await db.settings.put({ key: KEY_AUTO, value: on ? '1' : '0' });
}

export async function getLastSync(): Promise<SyncReport | null> {
  const rec = await db.settings.get(KEY_LAST);
  if (!rec) return null;
  try {
    return JSON.parse(rec.value) as SyncReport;
  } catch {
    return null;
  }
}

// ── Применение реестра комиссий (type: "registry") ───────────────────
interface RegistryUik {
  num: number;
  district?: string;
  venue?: string;
  address?: string;
  phone?: string;
}

async function applyRegistry(data: {
  updated?: string;
  tik?: Record<string, string>;
  uik?: RegistryUik[];
}, src: DataSource) {
  const updated = String(data.updated ?? '');
  const applied = await db.settings.get(appliedKey(src.id));
  if (updated && applied?.value === updated) {
    return { line: `${src.name}: уже актуально (ред. ${updated})`, changed: false };
  }
  let added = 0;
  let updatedCount = 0;
  for (const u of data.uik ?? []) {
    const existing = await db.commissions.where('uikNo').equals(u.num).first();
    if (existing) {
      if (
        existing.venue !== u.venue ||
        existing.address !== u.address ||
        existing.phone !== u.phone ||
        existing.district !== u.district
      ) {
        await db.commissions.update(existing.id, {
          venue: u.venue,
          address: u.address,
          phone: u.phone,
          district: u.district,
        });
        updatedCount += 1;
      }
    } else {
      const tik = await db.commissions.where('level').equals('TIK').first();
      await db.commissions.add({
        code: `УИК № ${u.num}`,
        name: `Участковая избирательная комиссия № ${u.num}`,
        level: 'UIK',
        parentId: tik?.id,
        budget: 'krai',
        uikNo: u.num,
        district: u.district,
        venue: u.venue,
        address: u.address,
        phone: u.phone,
      } as never);
      added += 1;
    }
  }
  if (data.tik) {
    const t = data.tik;
    const tik = await db.commissions
      .where('level')
      .equals('TIK')
      .filter((c) => c.code === 'ТИК Норильск')
      .first();
    if (tik) {
      await db.commissions.update(tik.id, {
        name: t.name ?? tik.name,
        address: t.address ?? tik.address,
        phone: t.phone ?? tik.phone,
        bank: t.bank ?? tik.bank,
        account: t.account ?? tik.account,
        chair: t.chair ?? tik.chair,
      });
    }
  }
  if (updated) await db.settings.put({ key: appliedKey(src.id), value: updated });
  return {
    line: `${src.name}: применена ред. ${updated || 'без версии'} — карточек обновлено: ${updatedCount}, добавлено: ${added}`,
    changed: added > 0 || updatedCount > 0,
  };
}

// ── Применение официальных составов (type: "rosters") ────────────────
async function applyRosters(
  data: { updated?: string; uik?: Record<string, { fio: string; role: Role }[]> },
  src: DataSource,
) {
  const updated = String(data.updated ?? '');
  const applied = await db.settings.get(appliedKey(src.id));
  if (updated && applied?.value === updated) {
    return { line: `${src.name}: уже актуально (ред. ${updated})`, changed: false };
  }
  let filled = 0;
  let alreadyOfficial = 0;
  for (const [numStr, roster] of Object.entries(data.uik ?? {})) {
    const num = Number(numStr);
    const uik = await db.commissions.where('uikNo').equals(num).first();
    if (!uik) continue;
    const members = await db.members.where('commissionId').equals(uik.id).toArray();
    if (members.some((m) => m.source === 'official')) {
      alreadyOfficial += 1;
      continue;
    }
    if (members.length) await db.members.bulkDelete(members.map((m) => m.id));
    await db.members.bulkAdd(
      roster.map((r) => ({
        commissionId: uik.id,
        fio: r.fio,
        role: r.role,
        status: 'нештатный',
        rate: RATES[r.role],
        source: 'official',
      })) as never,
    );
    const chair = roster.find((r) => r.role === 'chair');
    if (chair) await db.commissions.update(uik.id, { chair: chair.fio });
    filled += 1;
  }
  if (updated) await db.settings.put({ key: appliedKey(src.id), value: updated });
  return {
    line:
      `${src.name}: официальные составы применены для ${filled} УИК` +
      (alreadyOfficial ? `, уже официальные: ${alreadyOfficial}` : ''),
    changed: filled > 0,
  };
}

// ── Запуск синхронизации ─────────────────────────────────────────────
export async function runSync(trigger: 'start' | 'gesture' | 'manual'): Promise<SyncReport> {
  window.dispatchEvent(new CustomEvent('komfin:sync', { detail: { state: 'run', trigger } }));
  const lines: string[] = [];
  let ok = true;
  let changed = false;
  const sources = (await getSources()).filter((s) => s.enabled && s.url.trim());
  if (!sources.length) lines.push('Подключённых источников нет — работаем на локальных данных.');
  for (const src of sources) {
    try {
      const sep = src.url.includes('?') ? '&' : '?';
      const res = await fetch(`${src.url}${sep}_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.type === 'registry' || Array.isArray(data.uik)) {
        const r = await applyRegistry(data, src);
        lines.push(r.line);
        changed = changed || r.changed;
      } else if (data.type === 'rosters' || (data.uik && typeof data.uik === 'object')) {
        const r = await applyRosters(data, src);
        lines.push(r.line);
        changed = changed || r.changed;
      } else {
        lines.push(`${src.name}: формат не распознан — пропущено.`);
      }
    } catch (e) {
      ok = false;
      lines.push(`${src.name}: источник недоступен (${e instanceof Error ? e.message : 'сеть'}) — данные не изменились.`);
    }
  }
  const report: SyncReport = { at: new Date().toISOString(), trigger, ok, changed, lines };
  await db.settings.put({ key: KEY_LAST, value: JSON.stringify(report) });
  window.dispatchEvent(new CustomEvent('komfin:sync', { detail: { state: 'done', report } }));
  if (trigger === 'manual') {
    await logAdmin(`Синхронизация источников: ${lines.join('; ')}`);
  }
  return report;
}
