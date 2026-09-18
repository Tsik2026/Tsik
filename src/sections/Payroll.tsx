import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileSpreadsheet, Plus, Printer, Trash2 } from 'lucide-react';
import { db } from '../lib/db';
import { calcPayroll } from '../lib/calc';
import { fmtDate, rub2 } from '../lib/fmt';
import { C_DEFAULT, capC, REGION_K, ROLE_NAME } from '../lib/rules';
import { getRegionK, getVedC, setVedC } from '../lib/settings';
import { exportXlsx, printPage } from '../lib/excel';
import { Card, CardHead, Num, SectionHead, Table } from '../components/app/kit';
import type { Commission, Role, TimesheetEntry, VedC } from '../types';

const ROLE_ORDER: Record<Role, number> = { chair: 0, deputy: 1, secretary: 2, member: 3 };
const ROLES = Object.keys(ROLE_NAME) as Role[];

export default function Payroll({ commissionId }: { commissionId: number }) {
  const scope = useLiveQuery(async () => {
    const commission = await db.commissions.get(commissionId);
    let uiks: Commission[] = [];
    if (commission?.level === 'UIK') uiks = [commission];
    else uiks = (await db.commissions.where('parentId').equals(commissionId).toArray()).filter((c) => c.level === 'UIK');
    return { commission, uiks };
  }, [commissionId]);

  const [picked, setPicked] = useState<number | null>(null);
  const [newDate, setNewDate] = useState('2026-09-21');
  const uikId = picked ?? scope?.uiks[0]?.id ?? null;

  const data = useLiveQuery(async () => {
    if (!uikId) return null;
    const uik = await db.commissions.get(uikId);
    const members = await db.members.where('commissionId').equals(uikId).toArray();
    const entries = await db.timesheet.where('memberId').anyOf(members.map((m) => m.id)).toArray();
    const [vedC, regionK] = await Promise.all([getVedC(), getRegionK()]);
    return { uik, members, entries, vedC, regionK };
  }, [uikId]);

  const [farOverride, setFarOverride] = useState<boolean | null>(null);
  useEffect(() => setFarOverride(null), [uikId]);

  const vedC: VedC = data?.vedC ?? C_DEFAULT;
  const regionK = data?.regionK ?? REGION_K;
  const far = farOverride ?? data?.uik?.far === true;
  const { rows, totals } = useMemo(
    () => calcPayroll(data?.members ?? [], data?.entries ?? [], vedC, regionK, far),
    [data, vedC, regionK, far],
  );

  const setC = async (role: Role, value: number) => {
    const cap = capC(role, far);
    const clamped = Math.min(Math.max(0, value || 0), cap);
    await setVedC({ ...vedC, [role]: clamped });
  };

  const toggleFar = async (v: boolean) => {
    setFarOverride(v);
    if (uikId) await db.commissions.update(uikId, { far: v } as never);
  };

  const dates = useMemo(() => Array.from(new Set((data?.entries ?? []).map((e) => e.date))).sort(), [data]);

  if (!scope) return <div className="text-slate-500">Загрузка…</div>;

  if (scope.uiks.length === 0)
    return (
      <div>
        <SectionHead label="Модуль М4" title="Вознаграждения членов комиссий" />
        <Card className="px-4 py-6 text-[13px] text-slate-500">
          У выбранной комиссии нет подчинённых УИК. Выберите ТИК (учёт вознаграждений УИК) либо саму УИК в переключателе
          сверху.
        </Card>
      </div>
    );

  const entryOf = (memberId: number, date: string): TimesheetEntry | undefined =>
    (data?.entries ?? []).find((e) => e.memberId === memberId && e.date === date);

  const setHours = async (memberId: number, date: string, field: 'dayH' | 'nightH' | 'weekendH', raw: string) => {
    const val = Math.max(0, Number(raw.replace(',', '.')) || 0);
    const existing = entryOf(memberId, date);
    if (existing) await db.timesheet.update(existing.id, { [field]: val } as never);
    else await db.timesheet.add({ memberId, date, dayH: 0, nightH: 0, weekendH: 0, [field]: val } as never);
  };

  const addDate = async () => {
    if (!newDate || dates.includes(newDate) || !data) return;
    await db.timesheet.bulkAdd(
      data.members.map((m) => ({ memberId: m.id, date: newDate, dayH: 0, nightH: 0, weekendH: 0 })) as never[],
    );
  };

  const removeDate = async (date: string) => {
    const ids = (data?.entries ?? []).filter((e) => e.date === date).map((e) => e.id);
    await db.timesheet.bulkDelete(ids);
  };

  const exportExcel = () => {
    if (!data) return;
    const head = [
      '№', 'ФИО', 'Должность', 'Ставка ₽/ч', `Ставка с РК ×${regionK} ₽/ч`, 'Часы днём', 'Часы ночью (×2)',
      'Часы в выходные (×2)', 'Начислено за дневные часы', 'Начислено за ночные часы', 'Начислено за выходные',
      'Итого начислено Д1', 'Коэффициент C', 'Доплата за активную работу Д2', 'К выплате Д = Д1 + Д2',
    ];
    const body = rows.map((r, i) => [
      i + 1, r.member.fio, ROLE_NAME[r.member.role], r.member.rate, Math.round(r.rateK * 100) / 100,
      r.dayH, r.nightH, r.weekendH, Math.round(r.daySum * 100) / 100, Math.round(r.nightSum * 100) / 100,
      Math.round(r.weekendSum * 100) / 100, Math.round(r.base * 100) / 100, r.c,
      Math.round(r.d2 * 100) / 100, Math.round(r.total * 100) / 100,
    ]);
    const foot = [
      ['', 'ИТОГО', '', '', '', totals.dayH, totals.nightH, totals.weekendH, totals.daySum, totals.nightSum, totals.weekendSum, totals.base, '', totals.d2, totals.total],
    ];
    exportXlsx(`Ведомость_${data.uik?.code ?? 'УИК'}_прил6.xlsx`, [
      {
        name: 'Прил.6 Расчётная ведомость',
        rows: [
          [`Расчётная ведомость начисления дополнительной оплаты труда (вознаграждения) — ${data.uik?.name ?? ''}`],
          [`Основание: пост. ЦИК от 24.06.2026 № 10/101-9; табель учёта рабочего времени (прил. № 5); районный коэффициент ${regionK}`],
          [],
          head,
          ...body,
          ...foot,
        ],
        widths: [4, 24, 18, 10, 12, 10, 12, 14, 16, 16, 16, 14, 10, 16, 16],
      },
    ]);
  };

  const sorted = [...rows].sort((a, b) => ROLE_ORDER[a.member.role] - ROLE_ORDER[b.member.role]);

  return (
    <div>
      <SectionHead
        label="Модуль М4 · пост. ЦИК 10/101-9"
        title="Вознаграждения: табель → расчётная ведомость"
        right={
          <div className="flex gap-2">
            <button
              onClick={exportExcel}
              className="flex items-center gap-1.5 border border-navy bg-white px-3 py-2 text-[12px] font-medium text-navy hover:bg-slate-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={1.75} /> Excel (прил. 6)
            </button>
            <button
              onClick={printPage}
              className="flex items-center gap-1.5 bg-navy px-3 py-2 text-[12px] font-medium text-white hover:bg-navy-800"
            >
              <Printer className="h-3.5 w-3.5" strokeWidth={1.75} /> Печать ведомости
            </button>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-x-5 gap-y-3">
        <label className="max-sm:w-full">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Комиссия</span>
          <select value={uikId ?? ''} onChange={(e) => setPicked(Number(e.target.value))} className="inp h-9 max-sm:w-full">
            {scope.uiks.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code}
              </option>
            ))}
          </select>
        </label>

        <div>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Коэффициент за активную работу C · Д = Д1 + Д1×C
          </span>
          <div className="flex flex-wrap items-center gap-1.5" data-c-inputs>
            {ROLES.map((role) => {
              const cap = capC(role, far);
              return (
                <label key={role} className="flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1" data-c-role={role}>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{ROLE_NAME[role]}</span>
                  <input
                    type="number"
                    min={0}
                    max={cap}
                    step={0.05}
                    value={vedC[role]}
                    onChange={(e) => setC(role, Number(e.target.value))}
                    className="inp num h-7 w-16 px-1 text-right"
                    title={`Решение комиссии: C ≤ ${cap}`}
                  />
                  <span className="text-[9px] text-slate-400">≤&nbsp;{cap}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 pb-0.5">
          <label
            className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
            title="Для труднодоступных местностей лимит коэффициента C повышен до 3,0"
          >
            <input
              type="checkbox"
              checked={far}
              onChange={(e) => toggleFar(e.target.checked)}
              className="accent-navy"
              data-far-toggle
            />
            Труднодоступная местность (C ≤ 3,0)
          </label>
          <span
            className="w-max border border-navy/20 bg-navy/[0.04] px-2 py-0.5 text-[11px] text-navy"
            data-region-k
            title="Районный коэффициент применяется к ставке в формуле Д1; меняется в Admin → Ставки и данные"
          >
            Районный коэффициент ×&nbsp;{regionK}
          </span>
        </div>

        <div className="ms-auto flex items-end gap-2 max-sm:ms-0 max-sm:w-full">
          <label className="max-sm:flex-1">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Добавить дату табеля
            </span>
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="inp h-9 max-sm:w-full" />
          </label>
          <button
            onClick={addDate}
            className="flex h-9 items-center gap-1 border border-slate-300 bg-white px-3 text-[12px] font-medium text-navy hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> День
          </button>
        </div>
      </div>

      <Card>
        <CardHead>Табель учёта фактически отработанного времени (прил. № 5) — {data?.uik?.name}</CardHead>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b-2 border-navy bg-slate-50 text-left">
                <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Член комиссии</th>
                {dates.map((d) => (
                  <th key={d} colSpan={3} className="border-l border-slate-200 px-2 py-1 text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <span className="text-[11px] font-semibold text-navy">{fmtDate(d)}</span>
                      <button onClick={() => removeDate(d)} title="Удалить дату" className="text-slate-300 hover:text-red">
                        <Trash2 className="h-3 w-3" strokeWidth={1.75} />
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
                  Часов всего
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const totalH = r.dayH + r.nightH + r.weekendH;
                return (
                  <tr key={r.member.id} className="border-b border-slate-100">
                    <td className="px-3 py-1.5">
                      <div className="text-[13px] font-medium text-navy">{r.member.fio}</div>
                      <div className="text-[10px] text-slate-500">
                        {ROLE_NAME[r.member.role]} · {r.member.rate} ₽/ч (с РК {r.rateK.toFixed(2)})
                      </div>
                    </td>
                    {dates.map((d) => {
                      const entry = entryOf(r.member.id, d);
                      const cell = (field: 'dayH' | 'nightH' | 'weekendH', val: number, shade = false) => (
                        <td key={field} className={`px-0.5 py-1 text-center ${shade ? 'bg-slate-50' : ''}`}>
                          <input
                            key={`${entry?.id ?? 'n'}:${field}:${val}`}
                            defaultValue={val || ''}
                            placeholder="—"
                            onBlur={(e) => setHours(r.member.id, d, field, e.target.value)}
                            className="num h-8 w-10 border border-transparent bg-transparent text-center text-[12px] outline-none hover:border-slate-300 focus:border-navy focus:bg-white"
                          />
                        </td>
                      );
                      return (
                        <td
                          key={d}
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
                      <Num strong>{totalH}</Num>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500">
          Ночные часы (22:00–06:00) и часы в выходные/праздничные дни оплачиваются в двойном размере — пост. ЦИК 10/101-9.
          В расчёте применён районный коэффициент ×&nbsp;{regionK}: Д1 = ставка × РК × часы (ночные/выходные — в двойном
          размере).
        </div>
      </Card>

      <div className="mt-6">
        <Table
          head={['№', 'ФИО / должность', `Ставка (с РК ×${regionK})`, 'День', 'Ночь ×2', 'Вых. ×2', 'Итого Д1', 'C', 'Д2 = Д1×C', 'К выплате Д']}
        >
          {sorted.map((r, i) => (
            <tr key={r.member.id} data-rec={`members:${r.member.id}`}>
              <td className="w-[36px]">
                <Num>{i + 1}</Num>
              </td>
              <td className="min-w-[200px]">
                <div className="text-[13px] font-medium text-navy">{r.member.fio}</div>
                <div className="text-[10px] text-slate-500">{ROLE_NAME[r.member.role]}</div>
              </td>
              <td>
                <Num>{r.rateK.toFixed(2)} ₽/ч</Num>
                <div className="text-[10px] text-slate-400">
                  <Num>базовая {r.member.rate}</Num>
                </div>
              </td>
              <td>
                <Num>{r.dayH} ч</Num>
                <div className="text-[11px] text-slate-500">
                  <Num>{rub2(r.daySum)}</Num>
                </div>
              </td>
              <td>
                <Num>{r.nightH} ч</Num>
                <div className="text-[11px] text-slate-500">
                  <Num>{rub2(r.nightSum)}</Num>
                </div>
              </td>
              <td>
                <Num>{r.weekendH} ч</Num>
                <div className="text-[11px] text-slate-500">
                  <Num>{rub2(r.weekendSum)}</Num>
                </div>
              </td>
              <td>
                <Num strong>{rub2(r.base)}</Num>
              </td>
              <td>
                <Num>{r.c.toFixed(2)}</Num>
              </td>
              <td>
                <Num>{rub2(r.d2)}</Num>
              </td>
              <td data-pay-total={r.member.id}>
                <Num strong className="text-[14px]">
                  {rub2(r.total)}
                </Num>
              </td>
            </tr>
          ))}
          <tr className="bg-slate-50 font-semibold">
            <td colSpan={3} className="text-[11px] uppercase tracking-[0.12em] text-slate-500">
              Итого по ведомости
            </td>
            <td>
              <Num strong>{totals.dayH} ч</Num>
              <div className="text-[11px]">
                <Num>{rub2(totals.daySum)}</Num>
              </div>
            </td>
            <td>
              <Num strong>{totals.nightH} ч</Num>
              <div className="text-[11px]">
                <Num>{rub2(totals.nightSum)}</Num>
              </div>
            </td>
            <td>
              <Num strong>{totals.weekendH} ч</Num>
              <div className="text-[11px]">
                <Num>{rub2(totals.weekendSum)}</Num>
              </div>
            </td>
            <td>
              <Num strong>{rub2(totals.base)}</Num>
            </td>
            <td />
            <td>
              <Num strong>{rub2(totals.d2)}</Num>
            </td>
            <td data-pay-grand>
              <Num strong className="text-[14px] text-red">
                {rub2(totals.total)}
              </Num>
            </td>
          </tr>
        </Table>
      </div>

      {/* Печатная форма ведомости */}
      <div className="print-doc hidden">
        <div className="doc">
          <p className="doc-title">
            Расчётная ведомость <br /> начисления дополнительной оплаты труда (вознаграждения) членам комиссии
          </p>
          <p className="doc-sub">
            {data?.uik?.name} · районный коэффициент {regionK}
            {far ? ' · труднодоступная местность' : ''}
          </p>
          <table className="doc-table">
            <thead>
              <tr>
                <th>№</th>
                <th>ФИО</th>
                <th>Должность</th>
                <th>Ставка с РК, ₽/ч</th>
                <th>Дневные часы</th>
                <th>Ночные часы (×2)</th>
                <th>Выходные часы (×2)</th>
                <th>Итого Д1, ₽</th>
                <th>C</th>
                <th>Д2, ₽</th>
                <th>К выплате Д, ₽</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.member.id}>
                  <td>{i + 1}</td>
                  <td className="l">{r.member.fio}</td>
                  <td className="l">{ROLE_NAME[r.member.role]}</td>
                  <td>{r.rateK.toFixed(2)}</td>
                  <td>
                    {r.dayH} / {r.daySum.toFixed(2)}
                  </td>
                  <td>
                    {r.nightH} / {r.nightSum.toFixed(2)}
                  </td>
                  <td>
                    {r.weekendH} / {r.weekendSum.toFixed(2)}
                  </td>
                  <td>{r.base.toFixed(2)}</td>
                  <td>{r.c.toFixed(2)}</td>
                  <td>{r.d2.toFixed(2)}</td>
                  <td>
                    <b>{r.total.toFixed(2)}</b>
                  </td>
                </tr>
              ))}
              <tr className="tot">
                <td colSpan={4}>ИТОГО</td>
                <td>
                  {totals.dayH} / {totals.daySum.toFixed(2)}
                </td>
                <td>
                  {totals.nightH} / {totals.nightSum.toFixed(2)}
                </td>
                <td>
                  {totals.weekendH} / {totals.weekendSum.toFixed(2)}
                </td>
                <td>{totals.base.toFixed(2)}</td>
                <td />
                <td>{totals.d2.toFixed(2)}</td>
                <td>
                  <b>{totals.total.toFixed(2)}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="doc-sign">
            <div>Председатель комиссии ____________________ / {data?.uik?.chair ?? '________'} /</div>
            <div>Бухгалтер ____________________ / ________________ /</div>
            <div>«___» ______________ 2026 г.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
