import { useState } from 'react';
import { Check, Landmark, ListPlus, Plus, Trash2, WandSparkles } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { logAdmin } from '../lib/adminlog';
import { setBankConfirmed } from '../lib/settings';
import { BUDGET_NAME, CHECKLIST, DEADLINES } from '../lib/rules';
import { buildRecon, reconTotals, type ReconRow } from '../lib/calc';
import { cls, daysLeft, fmtDate, rub } from '../lib/fmt';
import { Card, CardHead, Dot, Num, SectionHead, Table, type Tone } from '../components/app/kit';
import type { AccountRec, Budget, Commission } from '../types';

// ── Валидация и операции со счетами ──────────────────────────────────
function isAccountNumber(n: string) {
  return /^\d{20}$/.test(n.replace(/\s/g, ''));
}

async function addAccount(rec: {
  commissionId: number;
  budget: Budget;
  number: string;
  bank: string;
  bik?: string;
  opened?: string;
  note?: string;
}) {
  const number = rec.number.replace(/\s/g, '');
  if (!isAccountNumber(number)) throw new Error('Номер расчётного счёта — 20 цифр');
  const dup = await db.accounts
    .where('number')
    .equals(number)
    .filter((a) => a.budget === rec.budget && !a.closed)
    .first();
  if (dup) throw new Error('Такой счёт уже есть в реестре (по этому бюджету)');
  const id = await db.accounts.add({
    commissionId: rec.commissionId,
    budget: rec.budget,
    number,
    bank: rec.bank.trim(),
    bik: rec.bik?.trim() || undefined,
    opened: rec.opened || undefined,
    note: rec.note?.trim() || undefined,
  } as never);
  const c = await db.commissions.get(rec.commissionId);
  await logAdmin(
    `В реестр добавлен счёт ${number} (${c?.code ?? 'комиссия'}, ${rec.budget === 'fed' ? 'федеральный' : 'краевой'} бюджет)`,
  );
  return id;
}

async function updateAccount(id: number, patch: Partial<AccountRec>) {
  await db.accounts.update(id, patch);
}

async function deleteAccount(id: number) {
  const acc = await db.accounts.get(id);
  await db.accounts.delete(id);
  if (acc) await logAdmin(`Из реестра удалён счёт ${acc.number}`);
}

async function fillAccountsFromDirectory() {
  const [commissions, accounts] = await Promise.all([db.commissions.toArray(), db.accounts.toArray()]);
  const have = new Set(accounts.map((a) => `${a.number}|${a.budget}`));
  let added = 0;
  for (const c of commissions) {
    const number = (c.account ?? '').replace(/\s/g, '');
    if (!isAccountNumber(number) || !c.bank) continue;
    const key = `${number}|${c.budget}`;
    if (have.has(key)) continue;
    await db.accounts.add({
      commissionId: c.id,
      budget: c.budget,
      number,
      bank: c.bank,
      note: 'добавлен из справочника комиссий',
    } as never);
    have.add(key);
    added += 1;
  }
  await logAdmin(`Реестр счетов автозаполнен из справочника: добавлено ${added}`);
  return added > 0
    ? `Реестр сформирован: добавлено счетов из справочника — ${added}.`
    : 'Новых счетов нет: все счета из справочника уже в реестре.';
}

// ── Сверка с банком ──────────────────────────────────────────────────
function ReconRowView({ row }: { row: ReconRow }) {
  const a = row.account;
  return (
    <tr data-rec={`accounts:${a.id}`} className={cls(row.status === 'bad' && 'bg-red-50/60')}>
      <td>
        <div className="font-medium text-navy">{a.number}</div>
        <div className="text-[11px] text-slate-500">
          {row.commission?.code ?? '—'} · {a.bank}
        </div>
      </td>
      <td className="text-[12px] text-slate-600">{BUDGET_NAME[a.budget]}</td>
      <td>
        <Num>{rub(row.paidIn)}</Num>
      </td>
      <td>
        <Num>{rub(row.paidOut)}</Num>
      </td>
      <td>
        <Num strong>{rub(row.bookBalance)}</Num>
      </td>
      <td className="min-w-[130px]">
        <input
          key={`sb:${a.id}:${a.statementBalance ?? ''}`}
          type="number"
          step="0.01"
          inputMode="decimal"
          defaultValue={a.statementBalance ?? ''}
          placeholder="по выписке"
          onBlur={(e) => {
            const v = e.target.value.trim();
            updateAccount(a.id, { statementBalance: v === '' ? undefined : Number(v) });
          }}
          className="inp num w-full"
        />
      </td>
      <td className="min-w-[120px]">
        <input
          key={`sd:${a.id}:${a.statementDate ?? ''}`}
          type="date"
          defaultValue={a.statementDate ?? ''}
          onBlur={(e) => updateAccount(a.id, { statementDate: e.target.value || undefined })}
          onChange={(e) => updateAccount(a.id, { statementDate: e.target.value || undefined })}
          className="inp w-full"
        />
      </td>
      <td>
        {row.status === 'none' && <span className="text-[11px] text-slate-400">нет выписки</span>}
        {row.status === 'ok' && (
          <span className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            совпадает
          </span>
        )}
        {row.status === 'bad' && (
          <span className="border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
            {row.diff! > 0 ? '+' : ''}
            {rub(row.diff!)}
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Реестр расчётных счетов (ручной ввод) ────────────────────────────
function AccountRegistry({ commissions }: { commissions: Commission[] }) {
  const accounts = useLiveQuery(() => db.accounts.toArray(), []);
  const [form, setForm] = useState({
    commissionId: 0,
    budget: 'krai' as Budget,
    number: '',
    bank: '',
    bik: '',
    opened: '',
    note: '',
  });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  if (!accounts) return null;

  const codeById = new Map(commissions.map((c) => [c.id, c.code]));
  const sorted = [...accounts].sort(
    (a, b) =>
      (codeById.get(a.commissionId) ?? '').localeCompare(codeById.get(b.commissionId) ?? '', 'ru') ||
      a.budget.localeCompare(b.budget),
  );
  const effCommissionId = form.commissionId || commissions[0]?.id || 0;

  const add = async () => {
    setErr('');
    setOk('');
    try {
      await addAccount({
        commissionId: effCommissionId,
        budget: form.budget,
        number: form.number,
        bank: form.bank,
        bik: form.bik,
        opened: form.opened,
        note: form.note,
      });
      setForm((f) => ({ ...f, number: '', bank: '', bik: '', note: '' }));
      setOk('Счёт добавлен в реестр.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const fill = async () => {
    setErr('');
    setOk('');
    setOk(await fillAccountsFromDirectory());
  };

  return (
    <Card>
      <CardHead className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <ListPlus className="h-3.5 w-3.5" /> Реестр расчётных счетов · ручной ввод
        </span>
        <button
          onClick={fill}
          title="Создать строки реестра из счетов, указанных в карточках комиссий справочника"
          className="flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium normal-case tracking-normal text-navy hover:bg-slate-50"
        >
          <WandSparkles className="h-3.5 w-3.5" /> Заполнить из справочника
        </button>
      </CardHead>
      <div className="grid gap-2 border-b border-slate-200 px-4 py-3 sm:grid-cols-2 lg:grid-cols-[1.2fr_0.9fr_1.4fr_1.4fr_0.8fr_0.9fr_auto]">
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Комиссия</span>
          <select
            value={effCommissionId}
            onChange={(e) => setForm({ ...form, commissionId: Number(e.target.value) })}
            className="inp w-full"
          >
            {commissions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Бюджет</span>
          <select
            value={form.budget}
            onChange={(e) => setForm({ ...form, budget: e.target.value as Budget })}
            className="inp w-full"
          >
            {Object.keys(BUDGET_NAME).map((b) => (
              <option key={b} value={b}>
                {BUDGET_NAME[b as Budget]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
            Расчётный счёт (20 цифр)
          </span>
          <input
            value={form.number}
            inputMode="numeric"
            placeholder="40202810400003000001"
            onChange={(e) => setForm({ ...form, number: e.target.value.replace(/[^\d\s]/g, '') })}
            className="inp num w-full"
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Банк</span>
          <input
            value={form.bank}
            placeholder="Отделение Красноярск Банка России"
            onChange={(e) => setForm({ ...form, bank: e.target.value })}
            className="inp w-full"
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">БИК</span>
          <input
            value={form.bik}
            inputMode="numeric"
            placeholder="040407001"
            onChange={(e) => setForm({ ...form, bik: e.target.value.replace(/\D/g, '').slice(0, 9) })}
            className="inp num w-full"
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Дата открытия</span>
          <input
            type="date"
            value={form.opened}
            onChange={(e) => setForm({ ...form, opened: e.target.value })}
            className="inp w-full"
          />
        </label>
        <div className="flex items-end">
          <button
            onClick={add}
            disabled={!form.number.trim() || !form.bank.trim()}
            className="flex w-full items-center justify-center gap-1.5 border border-navy bg-navy px-3 py-2 text-[12px] font-medium text-white hover:bg-navy/90 disabled:opacity-40 lg:w-auto"
          >
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
        </div>
      </div>
      {(err || ok) && (
        <div
          className={cls(
            'border-b px-4 py-2 text-[12px]',
            err ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800',
          )}
        >
          {err || ok}
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-[12.5px] text-slate-500">
          Счетов пока нет. Введите первый счёт вручную выше или нажмите «Заполнить из справочника» — реестр
          сформируется автоматически из карточек комиссий.
        </div>
      ) : (
        <Table head={['Комиссия', 'Бюджет', 'Расчётный счёт', 'Банк / БИК', 'Открыт', 'Статус', '']} className="border-0">
          {sorted.map((a) => (
            <tr key={a.id} data-rec={`accounts:${a.id}`} className={cls(a.closed && 'opacity-60')}>
              <td className="font-medium text-navy">{codeById.get(a.commissionId) ?? '—'}</td>
              <td className="text-[12px] text-slate-600">{BUDGET_NAME[a.budget]}</td>
              <td>
                <Num className="text-[13px]">{a.number}</Num>
              </td>
              <td>
                <div className="text-[12.5px] text-slate-700">{a.bank}</div>
                {a.bik && <div className="text-[11px] text-slate-500">БИК {a.bik}</div>}
              </td>
              <td className="text-[12px] text-slate-600">{a.opened ? fmtDate(a.opened) : '—'}</td>
              <td>
                {a.closed ? (
                  <span className="border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                    закрыт {fmtDate(a.closed)}
                  </span>
                ) : (
                  <span className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                    действующий
                  </span>
                )}
              </td>
              <td className="text-right">
                <button
                  onClick={() => {
                    window.confirm(`Удалить счёт ${a.number} из реестра?`) && deleteAccount(a.id);
                  }}
                  title="Удалить счёт"
                  className="p-1 text-slate-400 hover:text-red"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <div className="border-t border-slate-200 px-4 py-2.5 text-[11px] leading-relaxed text-slate-500">
        Любую строку можно исправить в режиме правки (переключатель «Режим правки» вверху панели Admin, затем клик по
        строке): номер, банк, даты, закрытие счёта, остаток по выписке.
      </div>
    </Card>
  );
}

// ── Секция сверки с банком ───────────────────────────────────────────
function BankRecon({ bankConfirmed }: { bankConfirmed: boolean }) {
  const commissions = useLiveQuery(() => db.commissions.orderBy('id').toArray(), []);
  const accounts = useLiveQuery(() => db.accounts.toArray(), []);
  const ops = useLiveQuery(() => db.operations.toArray(), []);
  if (!commissions || !accounts || !ops) return null;

  const rows = buildRecon(accounts, ops, commissions);
  const t = reconTotals(rows);
  const allMatched = t.total > 0 && t.withStatement === t.total && t.matched === t.withStatement;

  return (
    <div className="mt-6 space-y-6">
      <AccountRegistry commissions={commissions} />
      <Card>
        <CardHead className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Landmark className="h-3.5 w-3.5" /> Сверка с банком · реестр средств (автоформирование)
          </span>
          <span
            className={cls(
              'border px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal',
              allMatched
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : t.withStatement > 0 && t.matched < t.withStatement
                  ? 'border-red-300 bg-red-50 text-red-700'
                  : 'border-slate-300 bg-slate-100 text-slate-600',
            )}
          >
            {t.total === 0 ? 'нет счетов' : `сверено: ${t.matched}/${t.total}`}
          </span>
        </CardHead>
        {t.total === 0 ? (
          <div className="px-4 py-6 text-[12.5px] leading-relaxed text-slate-500">
            Реестр средств формируется автоматически по мере появления счетов выше: поступления и расходы берутся из
            операций по безналичному каналу каждой комиссии и бюджета, остаток по выписке банка вводится вручную —
            расхождение подсвечивается.
          </div>
        ) : (
          <>
            <Table
              head={[
                'Счёт / комиссия',
                'Бюджет',
                'Поступило',
                'Израсходовано',
                'Остаток по учёту',
                'Остаток по выписке',
                'Дата выписки',
                'Расхождение',
              ]}
              className="border-0"
            >
              {rows.map((r) => (
                <ReconRowView key={r.account.id} row={r} />
              ))}
              <tr className="bg-slate-50 font-semibold text-navy">
                <td>Итого по реестру</td>
                <td />
                <td>
                  <Num strong>{rub(t.paidIn)}</Num>
                </td>
                <td>
                  <Num strong>{rub(t.paidOut)}</Num>
                </td>
                <td>
                  <Num strong>{rub(t.bookBalance)}</Num>
                </td>
                <td colSpan={3} />
              </tr>
            </Table>
            <div className="flex flex-wrap items-start justify-between gap-3 border-t border-slate-200 px-4 py-3">
              <div className="max-w-[560px] text-[11.5px] leading-relaxed text-slate-500">
                Контрольное соотношение «Остаток по учёту = подтверждение банка» (прил. № 9/11): введите остаток и дату
                выписки по каждому счёту — строки без расхождений отмечаются автоматически. Когда сверены все счета
                реестра, подтверждение выставляется одной кнопкой и участвует в контроле на дашборде.
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <button
                  onClick={() => setBankConfirmed(true)}
                  disabled={!allMatched}
                  title={
                    allMatched
                      ? 'Все счета сверены без расхождений'
                      : 'Доступно, когда по всем счетам введена выписка и нет расхождений'
                  }
                  className="border border-navy bg-navy px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-navy/90 disabled:opacity-40"
                >
                  Подтвердить сверку по всем счетам
                </button>
                {bankConfirmed && (
                  <button
                    onClick={() => setBankConfirmed(false)}
                    className="text-[11px] text-slate-500 underline decoration-dotted hover:text-navy"
                  >
                    сверка подтверждена — снять отметку
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ── Раздел «Контроль» ────────────────────────────────────────────────
export default function ControlCalendar() {
  const state = useLiveQuery(async () => {
    const checks: Record<string, boolean> = {};
    for (const item of CHECKLIST) {
      checks[item.id] = (await db.settings.get('chk_' + item.id))?.value === '1';
    }
    const bankConfirmed = (await db.settings.get('bankConfirmed'))?.value === '1';
    return { checks, bankConfirmed };
  }, []);
  if (!state) return <div className="text-slate-500">Загрузка…</div>;

  const toggle = async (id: string) => {
    await db.settings.put({ key: 'chk_' + id, value: state.checks[id] ? '0' : '1' });
  };
  const done = Object.values(state.checks).filter(Boolean).length;

  return (
    <div>
      <SectionHead
        label="Модуль М9"
        title="Календарь контроля и чек-лист закрытия кампании"
        right={
          <span className="border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600">
            чек-лист: {done}/{CHECKLIST.length}
          </span>
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHead>Рубежи — цикл 2026</CardHead>
          <div className="px-4 py-4">
            {DEADLINES.map((d, i) => {
              const left = daysLeft(d.date);
              const tone: Tone = left < 0 ? 'bad' : left <= 7 ? 'warn' : 'ok';
              return (
                <div key={d.id} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < DEADLINES.length - 1 && (
                    <span className="absolute left-[7px] top-5 h-full w-px bg-slate-200" />
                  )}
                  <span className="relative z-10 mt-1.5">
                    <Dot tone={tone} />
                  </span>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="text-[14px] font-semibold text-navy">{d.title}</div>
                      <div className="num text-[13px] font-semibold text-navy">
                        {new Date(d.date + 'T00:00:00').toLocaleDateString('ru-RU')}
                      </div>
                    </div>
                    <div className="mt-0.5 text-[12px] text-slate-500">{d.rule}</div>
                    <div
                      className={`mt-1 text-[12px] font-medium ${left < 0 ? 'text-red' : left <= 7 ? 'text-amber-600' : 'text-emerald-600'}`}
                    >
                      {left < 0 ? `Просрочено на ${-left} дн.` : `Осталось ${left} дн.`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-slate-200 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
            Неизрасходованные средства возвращаются вышестоящей комиссии после завершения операций; счёт закрывается
            до представления отчёта, подтверждение банка (прил. № 9/11) прилагается к отчёту.
          </div>
        </Card>
        <Card className="self-start">
          <CardHead>Чек-лист закрытия (по Порядку 98/1080-8)</CardHead>
          <div className="divide-y divide-slate-100">
            {CHECKLIST.map((item) => {
              const on = state.checks[item.id];
              return (
                <button
                  key={item.id}
                  onClick={() => toggle(item.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
                >
                  <span
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border ${on ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white'}`}
                  >
                    {on && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                  </span>
                  <span className={`text-[13px] ${on ? 'text-slate-400 line-through' : 'font-medium text-navy'}`}>
                    {item.title}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      </div>
      <BankRecon bankConfirmed={state.bankConfirmed} />
    </div>
  );
}
