import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { db } from '../lib/db';
import { lineName } from '../lib/calc';
import { fmtDate, rub, rub2 } from '../lib/fmt';
import { ACCOUNT_NAME, BUDGET_NAME, CHANNEL_NAME, LINE_CODES } from '../lib/rules';
import { getLineNames } from '../lib/settings';
import { exportXlsx } from '../lib/excel';
import { logAdmin } from '../lib/adminlog';
import { Card, CardHead, Num, SectionHead, Table } from '../components/app/kit';
import type { Budget, Channel, OpKind } from '../types';

interface OpForm {
  date: string;
  kind: OpKind;
  lineCode: string;
  amount: string;
  docNo: string;
  docDate: string;
  counterparty: string;
  purpose: string;
  channel: Channel;
}

const EMPTY: OpForm = {
  date: '2026-09-20',
  kind: 'out',
  lineCode: 'PROCHEE',
  amount: '',
  docNo: '',
  docDate: '',
  counterparty: '',
  purpose: '',
  channel: 'bank',
};

export default function Operations({ commissionId, budget }: { commissionId: number; budget: Budget }) {
  const data = useLiveQuery(async () => {
    const ops = await db.operations.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const estimate = await db.estimate.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const commission = await db.commissions.get(commissionId);
    const customNames = await getLineNames();
    return { ops, estimate, commission, customNames };
  }, [commissionId, budget]);

  const [form, setForm] = useState<OpForm>(EMPTY);
  const [showForm, setShowForm] = useState(false);

  if (!data) return <div className="text-slate-500">Загрузка…</div>;

  const sorted = [...data.ops].sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalIn = sorted.filter((o) => o.kind === 'in').reduce((s, o) => s + o.amount, 0);
  const totalOut = sorted.filter((o) => o.kind === 'out').reduce((s, o) => s + o.amount, 0);

  // статьи: строки сметы этой комиссии+бюджета (задача 21), иначе стандартная матрица
  const lineOptions = (
    data.estimate.length
      ? data.estimate.map((e) => ({ code: e.lineCode, name: e.name ?? lineName(e.lineCode, data.customNames) }))
      : LINE_CODES.map((c) => ({ code: c as string, name: lineName(c, data.customNames) }))
  ).filter((v, i, arr) => arr.findIndex((x) => x.code === v.code) === i);

  const addOp = async () => {
    const amount = Number(form.amount.replace(/\s/g, '').replace(',', '.'));
    if (!(amount > 0) || !form.docNo.trim() || !form.counterparty.trim()) return;
    await db.operations.add({
      commissionId,
      budget,
      date: form.date,
      kind: form.kind,
      lineCode: form.lineCode,
      amount,
      docNo: form.docNo.trim(),
      docDate: form.docDate.trim(),
      counterparty: form.counterparty.trim(),
      purpose: form.purpose.trim(),
      channel: form.channel,
    } as never);
    await logAdmin(
      `Операция (${ACCOUNT_NAME[budget].split(' ')[0]}): ${form.kind === 'in' ? 'поступление' : 'расход'} ${amount.toLocaleString('ru-RU')} ₽, док. № ${form.docNo.trim()}`,
    );
    setForm(EMPTY);
    setShowForm(false);
  };

  const removeOp = async (id: number, docNo: string) => {
    if (!window.confirm(`Удалить операцию по документу № ${docNo}?`)) return;
    await db.operations.delete(id);
    await logAdmin(`Удалена операция, док. № ${docNo}`);
  };

  const exportJournal = () => {
    const rows = [
      ['Дата', 'Приход/расход', 'Статья сметы', 'Сумма, ₽', '№ документа', 'Дата документа', 'Контрагент', 'Назначение', 'Канал'],
      ...[...sorted].reverse().map((o) => [
        fmtDate(o.date),
        o.kind === 'in' ? 'поступление' : 'расход',
        `${o.lineCode} · ${lineName(o.lineCode, data.customNames)}`,
        o.amount,
        o.docNo,
        o.docDate,
        o.counterparty,
        o.purpose,
        CHANNEL_NAME[o.channel] ?? o.channel,
      ]),
    ];
    exportXlsx(`Журнал_операций_${ACCOUNT_NAME[budget].split(' ')[0]}.xlsx`, [
      { name: 'Журнал операций', rows, widths: [11, 13, 34, 12, 11, 13, 30, 50, 9] },
    ]);
  };

  return (
    <div>
      <SectionHead
        label="Модуль М3"
        title="Банк и касса — журнал операций"
        right={
          <div className="flex gap-2">
            <button
              onClick={exportJournal}
              className="flex items-center gap-1.5 border border-navy bg-white px-3 py-2 text-[12px] font-medium text-navy hover:bg-slate-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={1.75} /> Excel
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-1.5 bg-navy px-3 py-2 text-[12px] font-medium text-white hover:bg-navy-800"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> Операция
            </button>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 lg:grid-cols-4">
        <div className="bg-navy px-4 py-3 text-white">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">Счёт</div>
          <div className="mt-1 break-all text-[13px] font-medium">{ACCOUNT_NAME[budget]}</div>
          <div className="mt-0.5 text-[11px] text-white/55">{data.commission?.bank ?? '—'}</div>
        </div>
        {[
          { l: 'Поступило', v: rub(totalIn) },
          { l: 'Израсходовано', v: rub(totalOut) },
          { l: 'Остаток на счёте', v: rub(totalIn - totalOut) },
        ].map((c) => (
          <div key={c.l} className="bg-white px-3 py-3 sm:px-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{c.l}</div>
            <Num strong className="mt-1 block text-[16px] sm:text-[20px]">
              {c.v}
            </Num>
          </div>
        ))}
      </div>

      {showForm && (
        <Card className="mb-5">
          <CardHead>Новая операция · {BUDGET_NAME[budget].toLowerCase()}</CardHead>
          <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="lbl">Дата</span>
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="inp" />
            </label>
            <label className="block">
              <span className="lbl">Приход/расход</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as OpKind })} className="inp">
                <option value="in">поступление</option>
                <option value="out">расход</option>
              </select>
            </label>
            <label className="block">
              <span className="lbl">Статья сметы</span>
              <select value={form.lineCode} onChange={(e) => setForm({ ...form, lineCode: e.target.value })} className="inp">
                {lineOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} · {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="lbl">Сумма, ₽</span>
              <input
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="0,00"
                className="inp num"
              />
            </label>
            <label className="block">
              <span className="lbl">№ документа</span>
              <input
                value={form.docNo}
                onChange={(e) => setForm({ ...form, docNo: e.target.value })}
                placeholder="127"
                className="inp"
              />
            </label>
            <label className="block">
              <span className="lbl">Дата документа</span>
              <input
                value={form.docDate}
                onChange={(e) => setForm({ ...form, docDate: e.target.value })}
                placeholder="20.09.2026"
                className="inp"
              />
            </label>
            <label className="block">
              <span className="lbl">Канал</span>
              <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })} className="inp">
                {Object.entries(CHANNEL_NAME).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="lbl">Контрагент</span>
              <input
                value={form.counterparty}
                onChange={(e) => setForm({ ...form, counterparty: e.target.value })}
                placeholder="ООО «…»"
                className="inp"
              />
            </label>
            <label className="block sm:col-span-2 lg:col-span-3">
              <span className="lbl">Назначение платежа</span>
              <input
                value={form.purpose}
                onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                placeholder="Основание и содержание операции"
                className="inp"
              />
            </label>
            <div className="flex items-end">
              <button
                onClick={addOp}
                className="h-9 w-full bg-red px-4 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
                disabled={!form.amount || !form.docNo || !form.counterparty}
              >
                Провести
              </button>
            </div>
          </div>
        </Card>
      )}

      <Table head={['Дата', 'Документ', 'Статья', 'Контрагент / назначение', 'Канал', 'Приход', 'Расход', '']}>
        {sorted.map((o) => (
          <tr key={o.id} data-rec={`operations:${o.id}`}>
            <td className="w-[90px]">
              <Num>{fmtDate(o.date)}</Num>
            </td>
            <td className="w-[110px]">
              <div className="text-[12px] font-medium text-navy">№ {o.docNo}</div>
              <div className="text-[10px] text-slate-500">{o.docDate}</div>
            </td>
            <td className="w-[70px]">
              <span className="border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold text-navy" title={lineName(o.lineCode, data.customNames)}>
                {o.lineCode}
              </span>
            </td>
            <td className="min-w-[280px]">
              <div className="text-[13px] font-medium text-navy">{o.counterparty}</div>
              <div className="text-[12px] text-slate-500">{o.purpose}</div>
            </td>
            <td className="w-[80px] text-[12px] text-slate-500">{CHANNEL_NAME[o.channel] ?? o.channel}</td>
            <td className="w-[130px] text-right">{o.kind === 'in' && <Num strong>{rub2(o.amount)}</Num>}</td>
            <td className="w-[130px] text-right">{o.kind === 'out' && <Num className="text-red">{rub2(o.amount)}</Num>}</td>
            <td className="w-[40px] text-right">
              <button onClick={() => removeOp(o.id, o.docNo)} className="text-slate-300 hover:text-red" title="Удалить">
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
