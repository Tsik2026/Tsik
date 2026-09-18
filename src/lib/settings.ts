import { db } from './db';
import { C_DEFAULT, RATES, REGION_K } from './rules';
import type { Role, VedC } from '../types';

const KEY_VED_C = 'vedC';
const KEY_VED_K = 'vedK';
const KEY_REGION_K = 'regionK';

export async function getVedC(): Promise<VedC> {
  const rec = await db.settings.get(KEY_VED_C);
  if (rec) {
    try {
      const p = JSON.parse(rec.value);
      return {
        chair: p.chair ?? 0,
        deputy: p.deputy ?? 0,
        secretary: p.secretary ?? 0,
        member: p.member ?? 0,
      };
    } catch {
      return { ...C_DEFAULT };
    }
  }
  // совместимость со старой схемой: единый коэффициент vedK
  const legacy = await db.settings.get(KEY_VED_K);
  if (legacy) {
    const k = Math.min(3, Math.max(0, (Number(legacy.value) || 1) - 1));
    return { chair: k, deputy: k, secretary: k, member: k };
  }
  return { ...C_DEFAULT };
}

export async function setVedC(c: VedC): Promise<void> {
  await db.settings.put({ key: KEY_VED_C, value: JSON.stringify(c) });
}

export async function getRegionK(): Promise<number> {
  const rec = await db.settings.get(KEY_REGION_K);
  const n = rec ? Number(rec.value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : REGION_K;
}

export async function setRegionK(k: number): Promise<void> {
  await db.settings.put({ key: KEY_REGION_K, value: String(k) });
}

export async function isBankConfirmed(): Promise<boolean> {
  return (await db.settings.get('bankConfirmed'))?.value === '1';
}

export async function setBankConfirmed(v: boolean): Promise<void> {
  await db.settings.put({ key: 'bankConfirmed', value: v ? '1' : '0' });
}

// ── Ставки вознаграждения (₽/час) ────────────────────────────────────
const KEY_RATES = 'rates:override';

/** Текущие ставки: переопределения администратора поверх умолчаний пост. ЦИК 10/101-9 */
export async function loadRates(): Promise<Record<Role, number>> {
  const rec = await db.settings.get(KEY_RATES);
  if (!rec) return { ...RATES };
  try {
    const p = JSON.parse(rec.value);
    return {
      chair: p.chair ?? RATES.chair,
      deputy: p.deputy ?? RATES.deputy,
      secretary: p.secretary ?? RATES.secretary,
      member: p.member ?? RATES.member,
    };
  } catch {
    return { ...RATES };
  }
}

/** Сохранение ставок; при apply=true — массовое обновление по ролям */
export async function applyRates(rates: Record<Role, number>, apply: boolean): Promise<number> {
  await db.settings.put({ key: KEY_RATES, value: JSON.stringify(rates) });
  let n = 0;
  if (apply) {
    for (const role of Object.keys(rates) as Role[]) {
      n += await db.members.where('role').equals(role).modify({ rate: rates[role] });
    }
  }
  return n;
}

// ── Реестр пользовательских статей сметы (задача 21) ────────────────
const KEY_LINE_NAMES = 'lineNames';

export async function getLineNames(): Promise<Record<string, string>> {
  const rec = await db.settings.get(KEY_LINE_NAMES);
  if (!rec) return {};
  try {
    return JSON.parse(rec.value) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function putLineName(code: string, name: string): Promise<void> {
  const all = await getLineNames();
  all[code] = name;
  await db.settings.put({ key: KEY_LINE_NAMES, value: JSON.stringify(all) });
}
