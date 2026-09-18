import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Trash2 } from 'lucide-react';
import { db } from '../lib/db';
import { fmtDate, rub } from '../lib/fmt';
import { logAdmin } from '../lib/adminlog';
import { Bar, Card, CardHead, Dot, Num, SectionHead, Table, type Tone } from '../components/app/kit';

const STATUS_TONE: Record<string, Tone> = {
  выдан: 'bad',
  частично: 'warn',
  сдан: 'ok',
  проверен: 'ok',
};

const STATUS_NEXT: Record<string, string> = {
  выдан: 'частично',
  частично: 'сдан',
  сдан: 'проверен',
  проверен: 'проверен',
};

export default function Advances({ commissionId }: { commissionId: number }) {
  const data = useLiveQuery(async () => {
    const commission = await db.commissions.get(commissionId);
    const children = await db.commissions.where('parentId').equals(commissionId).toArray();
    const ids = [commissionId, ...children.map((c) => c.id)];
    const list = await db.advances.where('commissionId').anyOf(ids).toArray();
    const commMap = new Map((await db.commissions.bulkGet(ids)).filter(Boolean).map((c) => [c!.id, c!]));
    return { commission, list, commMap };
  }, [commissionId]);

  const [form, setForm] = useState({ person: '', purpose: '', amount: '', date: '2026-09-20' });
  const [showForm, setShowForm] = useState(false);

  if (!data) return <div className="text-slate-500">Загрузка…</div>;

  const addAdvance = async () => {
    const amount = Number(form.amount.replace(/\s/g, '').replace(',', '.'));
    if (!(amount > 0) || !form.person.trim()) return;
    await db.advances.add({
      commissionId,
      person: form.person.trim(),
      date: form.date,
      purpose: form.purpose.trim(),
      amount,
      reported: 0,
      docsCount: 0,
      status: 'выдан',
    } as never);
    await logAdmin(`Подотчёт: выдано ${amount.toLocaleString('ru-RU')} ₽ — ${form.person.trim()}`);
    setForm({ person: '', purpose: '', amount: '', date: '2026-09-20' });
    setShowForm(false);
  };

  const totalAmount = data.list.reduce((s, a) => s + a.amount, 0);
  const totalReported = data.list.reduce((s, a) => s + a.reported, 0);

  return (
    <div>
      <SectionHead
        label="Модуль М6"
        title="Подотчёт и первичные документы УИК"
        right={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 bg-navy px-3 py-2 text-[12px] font-medium text-white hover:bg-navy-800"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> Выдать подотчёт
          </button>
        }
      />

      <div className="mb-5 grid grid-cols-3 gap-px border border-slate-200 bg-slate-200">
        {[
          { l: 'Выдано подотчёт', v: rub(totalAmount) },
          { l: 'Отчитано по авансовым отчётам', v: rub(totalReported) },
          { l: 'Не закрыто', v: rub(totalAmount - totalReported) },
        ].map((c) => (
          <div key={c.l} className="bg-white px-3 py-3 sm:px-4">
            <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 sm:text-[10px] sm:tracking-[0.14em]">
              {c.l}
            </div>
            <Num strong className="mt-1 block text-[15px] sm:text-[20px]">
              {c.v}
            </Num>
          </div>
        ))}
      </div>

      {showForm && (
        <Card className="mb-5">
          <CardHead>Новая выдача под отчёт</CardHead>
          <div className="flex flex-wrap items-end gap-3 px-4 py-4">
            <label className="max-sm:w-full">
              <span className="lbl">Подотчётное лицо</span>
              <input
                value={form.person}
                onChange={(e) => setForm({ ...form, person: e.target.value })}
                placeholder="ФИО (председатель УИК)"
                className="inp w-56 max-sm:w-full"
              />
            </label>
            <label className="max-sm:w-[calc(50%-6px)]">
              <span className="lbl">Дата</span>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="inp max-sm:w-full"
              />
            </label>
            <label className="max-sm:w-[calc(50%-6px)]">
              <span className="lbl">Сумма, ₽</span>
              <input
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="0"
                className="inp num w-32 max-sm:w-full"
              />
            </label>
            <label className="w-full min-w-0 flex-1 sm:min-w-[260px]">
              <span className="lbl">Назначение</span>
              <input
                value={form.purpose}
                onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                placeholder="Хозяйственные нужды участка"
                className="inp w-full"
              />
            </label>
            <button
              onClick={addAdvance}
              disabled={!form.person || !form.amount}
              className="h-9 bg-red px-4 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40 max-sm:w-full"
            >
              Выдать
            </button>
          </div>
        </Card>
      )}

      <Table head={['Статус', 'Подотчётное лицо / комиссия', 'Выдано', 'Отчитано (авансовый отчёт ф. 0504505)', 'Документы', 'Закрытие', '']}>
        {data.list.map((a) => (
          <tr key={a.id} data-rec={`advances:${a.id}`}>
            <td className="w-[110px]">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-navy">
                <Dot tone={STATUS_TONE[a.status] ?? 'idle'} /> {a.status}
              </span>
            </td>
            <td className="min-w-[240px]">
              <div className="text-[13px] font-medium text-navy">{a.person}</div>
              <div className="text-[11px] text-slate-500">
                {data.commMap.get(a.commissionId)?.code} · {fmtDate(a.date)}
              </div>
              <div className="mt-0.5 text-[12px] text-slate-500">{a.purpose}</div>
            </td>
            <td className="w-[110px]">
              <Num strong>{rub(a.amount)}</Num>
            </td>
            <td className="w-[220px]">
              <div className="flex items-center gap-2">
                <input
                  key={a.id + ':' + a.reported}
                  defaultValue={a.reported}
                  onBlur={async (e) => {
                    const val = Math.min(a.amount, Math.max(0, Number(e.target.value.replace(/\s/g, '').replace(',', '.')) || 0));
                    const status = val === 0 ? 'выдан' : val < a.amount ? 'частично' : 'сдан';
                    await db.advances.update(a.id, { reported: val, status } as never);
                  }}
                  className="num w-28 border border-transparent bg-transparent px-1.5 py-1 text-right text-[13px] font-semibold text-navy outline-none hover:border-slate-300 focus:border-navy focus:bg-white"
                />
                <div className="w-20">
                  <Bar value={a.reported} max={a.amount} />
                </div>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">остаток {rub(a.amount - a.reported)} — вернуть в кассу/на счёт</div>
            </td>
            <td className="w-[90px]">
              <input
                key={a.id + ':d' + a.docsCount}
                defaultValue={a.docsCount}
                onBlur={async (e) => db.advances.update(a.id, { docsCount: Math.max(0, Number(e.target.value) || 0) } as never)}
                className="num w-14 border border-transparent bg-transparent px-1.5 py-1 text-center text-[13px] outline-none hover:border-slate-300 focus:border-navy focus:bg-white"
                title="Число приложенных документов"
              />
              <span className="text-[10px] text-slate-400"> шт.</span>
            </td>
            <td className="w-[130px]">
              <button
                onClick={() => db.advances.update(a.id, { status: STATUS_NEXT[a.status] ?? a.status } as never)}
                className="border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-navy hover:bg-slate-50"
              >
                → {(STATUS_NEXT[a.status] ?? a.status) === a.status ? 'проверен' : STATUS_NEXT[a.status]}
              </button>
            </td>
            <td className="w-[50px] text-right">
              <button
                onClick={async () => {
                  if (window.confirm(`Удалить подотчётную сумму: ${a.person}, ${rub(a.amount)}?`)) {
                    await db.advances.delete(a.id);
                    await logAdmin(`Удалена подотчётная сумма: ${a.person}`);
                  }
                }}
                className="text-slate-300 hover:text-red"
                title="Удалить"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </td>
          </tr>
        ))}
      </Table>

      <p className="mt-4 text-[12px] text-slate-500">
        Первичные документы прошнуровываются, нумеруются и сдаются вместе с отчётом: УИК → ТИК до 30.09.2026, ТИК → ИК КК до
        10.10.2026 (Порядок ИК КК по шаблону решения 98/1080-8).
      </p>
    </div>
  );
}
