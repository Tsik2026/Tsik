import type { ReactNode } from 'react';
import { cls } from '../../lib/fmt';

/** Шапка раздела: метка модуля, заголовок, красная черта */
export function SectionHead({ label, title, right }: { label: string; title: string; right?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-end justify-between gap-4 max-sm:flex-col max-sm:items-start max-sm:gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
          <h1 className="mt-1 text-[19px] font-semibold leading-tight text-navy sm:text-[22px]">{title}</h1>
        </div>
        {right}
      </div>
      <div className="mt-3 h-[2px] w-14 bg-red" />
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/** Точка статуса */
export function Dot({ tone }: { tone: Tone }) {
  const map: Record<Tone, string> = {
    ok: 'bg-emerald-500',
    warn: 'bg-amber-400',
    bad: 'bg-red',
    idle: 'bg-slate-300',
  };
  return <span className={cls('inline-block h-2 w-2 rounded-full', map[tone])} />;
}

/** Полоса использования лимита */
export function Bar({ value, max, danger = false }: { value: number; max: number; danger?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const over = max > 0 && value > max;
  return (
    <div className="h-[5px] w-full bg-slate-200/80">
      <div
        className={cls('h-full', over || danger ? 'bg-red' : pct > 85 ? 'bg-amber-400' : 'bg-navy')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Карточка */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cls('border border-slate-200 bg-white', className)}>{children}</div>;
}

/** Заголовок карточки */
export function CardHead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cls('border-b border-slate-200 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500', className)}>
      {children}
    </div>
  );
}

/** Таблица с шапкой */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cls('overflow-x-auto border border-slate-200 bg-white [-webkit-overflow-scrolling:touch]', className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b-2 border-navy bg-slate-50 text-left">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_tr]:border-b [&_tr]:border-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

/** Число (моноширинное) */
export function Num({ children, className, strong }: { children: ReactNode; className?: string; strong?: boolean }) {
  return <span className={cls('num', strong && 'font-semibold text-navy', className)}>{children}</span>;
}
