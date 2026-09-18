import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CircleAlert, Plus } from 'lucide-react';
import { db } from '../lib/db';
import { lineName, lineSort } from '../lib/calc';
import { rub } from '../lib/fmt';
import { BUDGET_NAME, LINE_CODES } from '../lib/rules';
import { getLineNames, putLineName } from '../lib/settings';
import { logAdmin } from '../lib/adminlog';
import { Bar, Card, CardHead, Num, SectionHead, Table } from '../components/app/kit';
import type { Budget, EstimateLine } from '../types';

const NEW_ARTICLE = '__new__';

function parseAmount(s: string): number {
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

export default function Estimate({ commissionId, budget }: { commissionId: number; budget: Budget }) {
  const data = useLiveQuery(async () => {
    const estimate = await db.estimate.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const ops = await db.operations.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const commission = await db.commissions.get(commissionId);
    const customNames = await getLineNames();
    return { estimate, ops, commission, customNames };
  }, [commissionId, budget]);

  // ── форма добавления направления (задача 21) ──
  const [sel, setSel] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [limitStr, setLimitStr] = useState('');
  const [decision, setDecision] = useState('');
  const [formError, setFormError] = useState('');

  if (!data) return <div className="text-slate-500">Загрузка…</div>;

  const spent = (code: string) =>
    data.ops.filter((o) => o.kind === 'out' && o.lineCode === code).reduce((s, o) => s + o.amount, 0);

  const nameOf = (row: EstimateLine) => row.name ?? lineName(row.lineCode, data.customNames);

  // доступные для выбора статьи: неиспользованные стандартные + неиспользованные пользовательские
  const used = new Set(data.estimate.map((e) => e.lineCode));
  const freeStandard = LINE_CODES.filter((c) => !used.has(c));
  const freeCustom = Object.keys(data.customNames)
    .filter((c) => !used.has(c) && !(LINE_CODES as readonly string[]).includes(c))
    .sort((a, b) => a.localeCompare(b, 'ru'));

  const isNew = sel === NEW_ARTICLE;
  const effCode = isNew ? newCode.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '') : sel;
  const limit = parseAmount(limitStr);
  const codeClash = isNew && !!effCode && used.has(effCode);
  const codeInvalid = isNew && !!newCode.trim() && !/^[A-Z0-9_]{2,12}$/.test(effCode);
  const canAdd =
    !!sel &&
    (!isNew || (effCode.length >= 2 && !codeClash && newName.trim().length >= 3)) &&
    Number.isFinite(limit) &&
    limit >= 0 &&
    limitStr.trim() !== '' &&
    decision.trim().length >= 5;

  const update = (id: number, patch: Partial<EstimateLine>) => db.estimate.update(id, patch as never);

  const addLine = async () => {
    if (!canAdd) return;
    if (isNew) {
      await putLineName(effCode, newName.trim());
      await db.estimate.add({
        commissionId,
        budget,
        lineCode: effCode,
        limit,
        decision: decision.trim(),
        name: newName.trim(),
      } as never);
      await logAdmin(`Смета (${BUDGET_NAME[budget]}): создана статья ${effCode} «${newName.trim()}» и включена в смету`);
    } else {
      await db.estimate.add({ commissionId, budget, lineCode: sel, limit, decision: decision.trim() } as never);
      await logAdmin(`Смета (${BUDGET_NAME[budget]}): добавлено направление ${sel}`);
    }
    setSel('');
    setNewCode('');
    setNewName('');
    setLimitStr('');
    setDecision('');
    setFormError('');
  };

  const removeLine = async (row: EstimateLine) => {
    const linked = data.ops.filter((o) => o.lineCode === row.lineCode).length;
    const msg =
      linked > 0
        ? `По статье ${row.lineCode} есть ${linked} операций — они останутся в журнале без строки сметы. Удалить направление?`
        : `Удалить направление ${row.lineCode} из сметы?`;
    if (!window.confirm(msg)) return;
    await db.estimate.delete(row.id);
    await logAdmin(`Смета (${BUDGET_NAME[budget]}): удалено направление ${row.lineCode}`);
  };

  const totalLimit = data.estimate.reduce((s, e) => s + e.limit, 0);
  const totalOut = data.ops.filter((o) => o.kind === 'out').reduce((s, o) => s + o.amount, 0);

  return (
    <div>
      <SectionHead
        label="Модуль М2"
        title="Смета расходов комиссии"
        right={
          <span className="text-[12px] text-slate-500">Изменение сметы — только решением комиссии в новой редакции</span>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-3">
        {[
          { l: 'Итого лимит', v: rub(totalLimit) },
          { l: 'Израсходовано', v: rub(totalOut) },
          { l: 'Остаток средств', v: rub(totalLimit - totalOut) },
        ].map((c) => (
          <div key={c.l} className="bg-white px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{c.l}</div>
            <Num strong className="mt-1 block text-[16px] sm:text-[20px]">
              {c.v}
            </Num>
          </div>
        ))}
      </div>

      <Table head={['Код', 'Направление расходов', 'Лимит, ₽', 'Использование', 'Решение комиссии (версия сметы)', '']}>
        {[...data.estimate]
          .sort((a, b) => lineSort(a.lineCode, b.lineCode))
          .map((row) => {
            const out = spent(row.lineCode);
            const over = out > row.limit && row.limit > 0;
            return (
              <tr key={row.id} data-rec={`estimate:${row.id}`}>
                <td className="w-[70px]">
                  <span className="border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold text-navy">{row.lineCode}</span>
                </td>
                <td className="min-w-[220px]">
                  <div className="text-[13px] font-medium text-navy">{nameOf(row)}</div>
                  {!(LINE_CODES as readonly string[]).includes(row.lineCode) && (
                    <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-slate-400">
                      пользовательская статья
                    </div>
                  )}
                  {over && <div className="mt-0.5 text-[11px] font-semibold text-red">Превышение лимита на {rub(out - row.limit)}</div>}
                </td>
                <td className="w-[140px]">
                  <input
                    key={row.id + ':' + row.limit}
                    defaultValue={row.limit}
                    onBlur={(e) => {
                      const n = parseAmount(e.target.value);
                      if (!Number.isNaN(n) && n !== row.limit) update(row.id, { limit: n });
                    }}
                    className="num w-full border border-transparent bg-transparent px-1.5 py-1 text-right text-[13px] font-semibold text-navy outline-none hover:border-slate-300 focus:border-navy focus:bg-white"
                  />
                </td>
                <td className="w-[220px]">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Bar value={out} max={row.limit} />
                    </div>
                    <span className="num w-12 text-right text-[11px] text-slate-500">
                      {row.limit ? Math.round((out / row.limit) * 100) : 0}%
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {rub(out)} из {rub(row.limit)}
                  </div>
                </td>
                <td className="min-w-[240px]">
                  <input
                    key={row.id + ':' + row.decision}
                    defaultValue={row.decision}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== row.decision && update(row.id, { decision: e.target.value.trim() })}
                    className="w-full border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-slate-600 outline-none hover:border-slate-300 focus:border-navy focus:bg-white"
                  />
                </td>
                <td className="w-[60px] text-right">
                  <button
                    onClick={() => removeLine(row)}
                    className="text-[11px] text-slate-400 underline decoration-dotted hover:text-red"
                  >
                    удалить
                  </button>
                </td>
              </tr>
            );
          })}
      </Table>

      <Card className="mt-5">
        <CardHead>Добавить направление в смету</CardHead>
        <div className="flex flex-wrap items-end gap-3 px-4 py-4">
          <label className="w-full text-[12px] text-slate-600 sm:w-auto">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Статья</span>
            <select
              value={sel}
              onChange={(e) => {
                setSel(e.target.value);
                setFormError('');
              }}
              className="h-9 w-full border border-slate-300 bg-white px-2 text-[13px] outline-none focus:border-navy sm:w-72"
            >
              <option value="">— выберите статью —</option>
              {freeStandard.length > 0 && (
                <optgroup label="Стандартная матрица">
                  {freeStandard.map((c) => (
                    <option key={c} value={c}>
                      {c} · {lineName(c)}
                    </option>
                  ))}
                </optgroup>
              )}
              {freeCustom.length > 0 && (
                <optgroup label="Пользовательские статьи">
                  {freeCustom.map((c) => (
                    <option key={c} value={c}>
                      {c} · {lineName(c, data.customNames)}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={NEW_ARTICLE}>➕ Новая статья…</option>
            </select>
          </label>

          {isNew && (
            <>
              <label className="w-full text-[12px] text-slate-600 sm:w-auto">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Код статьи</span>
                <input
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                  placeholder="ARENDA"
                  className={`h-9 w-full border px-2 text-[13px] uppercase outline-none focus:border-navy sm:w-32 ${
                    codeClash || codeInvalid ? 'border-red' : 'border-slate-300'
                  }`}
                />
                {codeClash && <span className="mt-1 block text-[11px] text-red">Код уже есть в смете</span>}
                {codeInvalid && <span className="mt-1 block text-[11px] text-red">2–12 символов: A–Z, 0–9, _</span>}
              </label>
              <label className="w-full min-w-0 flex-1 text-[12px] text-slate-600 sm:min-w-[220px]">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Название статьи</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Аренда помещений для участков"
                  className="h-9 w-full border border-slate-300 px-2 text-[13px] outline-none focus:border-navy"
                />
              </label>
            </>
          )}

          <label className="w-full text-[12px] text-slate-600 sm:w-auto">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Лимит, ₽</span>
            <input
              value={limitStr}
              onChange={(e) => setLimitStr(e.target.value)}
              placeholder="150 000"
              className="num h-9 w-full border border-slate-300 px-2 text-[13px] outline-none focus:border-navy sm:w-36"
            />
          </label>

          <label className="w-full min-w-0 flex-1 text-[12px] text-slate-600 sm:min-w-[260px]">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Решение комиссии (дата, номер)
            </span>
            <input
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              placeholder="решение ТИК от … № …"
              className="h-9 w-full border border-slate-300 px-2 text-[13px] outline-none focus:border-navy"
            />
          </label>

          <button
            onClick={addLine}
            disabled={!canAdd}
            className="flex h-9 items-center gap-1.5 bg-navy px-4 text-[13px] font-medium text-white hover:bg-navy-800 disabled:opacity-40 max-sm:w-full max-sm:justify-center"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} /> Включить в смету
          </button>
        </div>
        {formError && <div className="border-t border-slate-100 px-4 py-2 text-[12px] text-red">{formError}</div>}
      </Card>

      <p className="mt-4 flex items-start gap-2 text-[12px] text-slate-500">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        Правила зафиксированы в матрице Фазы 0: смета версионируется решением комиссии; допвыделение оформляется из
        резерва/экономии (форма прил. № 13 краевого Порядка / серия постановлений ЦИК «О дополнительном выделении…»).
        Пользовательские статьи действуют в рамках выбранного бюджета и доступны при проведении операций.
      </p>
    </div>
  );
}
