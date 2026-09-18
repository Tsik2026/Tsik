import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
import { logAdmin } from '../../lib/adminlog';
import { ROLE_NAME } from '../../lib/rules';
import { fmtDate } from '../../lib/fmt';
import type { Role } from '../../types';

const ROLE_ORDER: Role[] = ['chair', 'deputy', 'secretary', 'member'];

export default function TimesheetEditor({ commissionId, code }: { commissionId: number | null; code: string }) {
  const data = useLiveQuery(async () => {
    if (!commissionId) return null;
    const members = await db.members.where('commissionId').equals(commissionId).toArray();
    const entries = await db.timesheet.where('memberId').anyOf(members.map((m) => m.id)).toArray();
    return { members, entries };
  }, [commissionId]);
  const [newDate, setNewDate] = useState('2026-09-21');

  if (!commissionId) return <div className="px-1 py-4 text-[12px] text-slate-500">Выберите УИК выше — откроется сетка табеля.</div>;
  if (!data) return <div className="px-1 py-4 text-[12px] text-slate-500">Загрузка…</div>;

  const dates = Array.from(new Set(data.entries.map((e) => e.date))).sort();
  const members = [...data.members].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const entryOf = (memberId: number, date: string) => data.entries.find((e) => e.memberId === memberId && e.date === date);

  const setHours = async (memberId: number, date: string, field: 'dayH' | 'nightH' | 'weekendH', raw: string) => {
    const value = Math.min(24, Math.max(0, Number(raw.replace(',', '.')) || 0));
    const existing = entryOf(memberId, date);
    if (existing) {
      await db.timesheet.update(existing.id, { [field]: value });
    } else {
      await db.timesheet.add({ memberId, date, dayH: 0, nightH: 0, weekendH: 0, [field]: value } as never);
    }
  };

  const addDate = async () => {
    if (!newDate || dates.includes(newDate) || !members.length) return;
    await db.timesheet.bulkAdd(
      members.map((m) => ({ memberId: m.id, date: newDate, dayH: 0, nightH: 0, weekendH: 0 })) as never[],
    );
    await logAdmin(`Табель ${code}: добавлена дата ${fmtDate(newDate)}`);
  };

  const removeDate = async (date: string) => {
    if (!window.confirm(`Удалить из табеля ${code} дату ${fmtDate(date)} со всеми часами?`)) return;
    const ids = data.entries.filter((e) => e.date === date).map((e) => e.id);
    await db.timesheet.bulkDelete(ids);
    await logAdmin(`Табель ${code}: удалена дата ${fmtDate(date)} (записей: ${ids.length})`);
  };

  if (!members.length) {
    return (
      <div className="border border-dashed border-slate-300 px-4 py-5 text-center text-[12px] leading-relaxed text-slate-500">
        В составе {code} нет ни одного человека. Добавьте членов комиссии в разделе «Справочники» или загрузите табель
        файлом — люди из него попадут в состав автоматически.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Добавить дату
          </span>
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="inp h-9" />
        </label>
        <button
          onClick={addDate}
          disabled={!newDate || dates.includes(newDate)}
          className="flex h-9 items-center gap-1 border border-slate-300 bg-white px-3 text-[12px] font-medium text-navy hover:bg-slate-50 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> День
        </button>
        <span className="text-[11px] text-slate-400">
          Записей: {data.entries.length} · людей: {members.length} · дат: {dates.length}
        </span>
      </div>
      <div className="overflow-x-auto border border-slate-200 [-webkit-overflow-scrolling:touch]">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b-2 border-navy bg-slate-50 text-left">
              <th className="sticky left-0 z-10 min-w-[170px] bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Член комиссии
              </th>
              {dates.map((date) => (
                <th key={date} colSpan={3} className="border-l border-slate-200 px-2 py-1 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <span className="text-[11px] font-semibold text-navy">{fmtDate(date)}</span>
                    <button onClick={() => removeDate(date)} title="Удалить дату" className="text-slate-300 hover:text-red">
                      <X className="h-3 w-3" strokeWidth={1.75} />
                    </button>
                  </div>
                  <div className="mt-0.5 grid grid-cols-3 text-[9px] font-medium uppercase tracking-wide text-slate-400">
                    <span>день</span>
                    <span>ночь</span>
                    <span>вых.</span>
                  </div>
                </th>
              ))}
              <th className="border-l border-slate-200 px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Всего
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const total = data.entries
                .filter((e) => e.memberId === m.id)
                .reduce((s, e) => s + e.dayH + e.nightH + e.weekendH, 0);
              return (
                <tr key={m.id} className="border-b border-slate-100">
                  <td className="sticky left-0 z-10 bg-white px-3 py-1.5">
                    <div className="text-[13px] font-medium text-navy">{m.fio}</div>
                    <div className="text-[10px] text-slate-500">
                      {ROLE_NAME[m.role]} · {m.rate} ₽/ч
                    </div>
                  </td>
                  {dates.map((date) => {
                    const entry = entryOf(m.id, date);
                    const cell = (field: 'dayH' | 'nightH' | 'weekendH', value: number, shaded = false) => (
                      <td key={field} className={`px-0.5 py-1 text-center ${shaded ? 'bg-slate-50' : ''}`}>
                        <input
                          key={`${entry?.id ?? 'n'}:${field}:${value}`}
                          defaultValue={value || ''}
                          placeholder="—"
                          inputMode="decimal"
                          onBlur={(e) => setHours(m.id, date, field, e.target.value)}
                          className="num h-8 w-10 border border-transparent bg-transparent text-center text-[12px] outline-none hover:border-slate-300 focus:border-navy focus:bg-white"
                        />
                      </td>
                    );
                    return (
                      <td
                        key={date}
                        className="border-l border-slate-200 px-0 py-0"
                        colSpan={3}
                        data-rec={entry?.id != null ? `timesheet:${entry.id}` : undefined}
                      >
                        <div className="grid grid-cols-3">
                          {cell('dayH', entry?.dayH ?? 0)}
                          {cell('nightH', entry?.nightH ?? 0, true)}
                          {cell('weekendH', entry?.weekendH ?? 0)}
                        </div>
                      </td>
                    );
                  })}
                  <td className="border-l border-slate-200 px-3 py-1.5 text-right">
                    <span className="num font-semibold text-navy">{total}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        Правки сохраняются сразу (при выходе из ячейки). Ячейку с записью можно открыть и в универсальном редакторе:
        включите «Режим правки» переключателем вверху панели Admin и кликните по записи.
      </div>
    </div>
  );
}
