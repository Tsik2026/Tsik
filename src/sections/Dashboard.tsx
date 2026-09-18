import { useLiveQuery } from 'dexie-react-hooks';
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import { db } from '../lib/db';
import { getRegionK, getVedC, isBankConfirmed } from '../lib/settings';
import { buildChecks, budgetLines, calcPayroll } from '../lib/calc';
import { daysLeft, rub } from '../lib/fmt';
import { ACCOUNT_NAME, BUDGET_NAME, DEADLINES } from '../lib/rules';
import { Bar, Card, CardHead, Dot, Num, SectionHead, type Tone } from '../components/app/kit';
import type { Budget } from '../types';

export default function Dashboard({ commissionId, budget }: { commissionId: number; budget: Budget }) {
  const data = useLiveQuery(async () => {
    const commission = await db.commissions.get(commissionId);
    const estimate = await db.estimate.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const ops = await db.operations.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const uikIds = (await db.commissions.where('parentId').equals(commissionId).toArray())
      .filter((c) => c.level === 'UIK')
      .map((c) => c.id);
    const members = await db.members.where('commissionId').anyOf(uikIds.length ? uikIds : [-1]).toArray();
    const entries = await db.timesheet.where('memberId').anyOf(members.map((m) => m.id)).toArray();
    const [vedC, regionK, bankConfirmed] = await Promise.all([getVedC(), getRegionK(), isBankConfirmed()]);
    return { commission, estimate, ops, members, entries, vedC, regionK, bankConfirmed };
  }, [commissionId, budget]);

  if (!data) return <div className="text-slate-500">Загрузка данных…</div>;

  const lines = budgetLines(data.estimate, data.ops);
  const totalIn = lines.reduce((s, l) => s + l.inSum, 0);
  const totalOut = lines.reduce((s, l) => s + l.outSum, 0);
  const totalLimit = lines.reduce((s, l) => s + l.limit, 0);
  const { totals } = calcPayroll(data.members, data.entries, data.vedC, data.regionK);
  const payLimit = data.estimate.filter((e) => e.lineCode === 'PAY').reduce((s, e) => s + e.limit, 0);
  const missingDocs = data.ops.filter((o) => o.kind === 'out' && !o.docNo.trim()).length;
  const checks = buildChecks(lines, totals.total, payLimit, data.bankConfirmed, missingDocs);

  const cards = [
    { label: 'Смета (лимит)', value: rub(totalLimit), sub: BUDGET_NAME[budget] },
    { label: 'Поступило', value: rub(totalIn), sub: `счёт ${ACCOUNT_NAME[budget].split(' ')[0]}` },
    { label: 'Израсходовано', value: rub(totalOut), sub: `${totalLimit ? Math.round((totalOut / totalLimit) * 100) : 0}% сметы` },
    { label: 'Начислено вознаграждений', value: rub(totals.total), sub: `лимит PAY ${rub(payLimit)}` },
  ];

  return (
    <div>
      <SectionHead
        label="Панель контроля"
        title={data.commission?.name ?? ''}
        right={
          <span className="border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600">
            {BUDGET_NAME[budget]}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 xl:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-navy px-5 py-4 text-white">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/50">{c.label}</div>
            <div className="num mt-1.5 text-[20px] font-semibold leading-none sm:text-[26px]">{c.value}</div>
            <div className="mt-1.5 text-[11px] text-white/55">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHead>Смета / факт по направлениям — {BUDGET_NAME[budget].toLowerCase()}</CardHead>
          <div className="divide-y divide-slate-100">
            {lines
              .filter((l) => l.limit > 0 || l.outSum > 0)
              .map((l) => (
                <div
                  key={l.code}
                  className="grid grid-cols-[1fr_72px] items-center gap-3 px-4 py-2.5 sm:grid-cols-[1fr_110px_110px_120px]"
                >
                  <div>
                    <div className="text-[13px] font-medium text-navy">{l.name}</div>
                    <div className="mt-1.5">
                      <Bar value={l.outSum} max={l.limit} />
                    </div>
                  </div>
                  <div className="text-right text-[12px] text-slate-500 max-sm:hidden">
                    лимит
                    <br />
                    <Num strong>{rub(l.limit)}</Num>
                  </div>
                  <div className="text-right text-[12px] text-slate-500 max-sm:hidden">
                    факт
                    <br />
                    <Num strong>{rub(l.outSum)}</Num>
                  </div>
                  <div className="text-right">
                    {l.outSum > l.limit && l.limit > 0 ? (
                      <span className="text-[11px] font-semibold text-red">ПРЕВЫШЕНИЕ</span>
                    ) : (
                      <span className="num text-[12px] text-slate-500">{l.limit ? Math.round((l.outSum / l.limit) * 100) : 0}%</span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHead>Контрольные соотношения</CardHead>
            <div className="divide-y divide-slate-100">
              {checks.map((c) => (
                <div key={c.id} className="flex items-start gap-3 px-4 py-3">
                  {c.ok === true && <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" strokeWidth={1.75} />}
                  {c.ok === false && <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red" strokeWidth={1.75} />}
                  {c.ok === null && <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" strokeWidth={1.75} />}
                  <div>
                    <div className="text-[13px] font-medium text-navy">{c.title}</div>
                    <div className="mt-0.5 text-[12px] text-slate-500">{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHead>Рубежи отчётности</CardHead>
            <div className="divide-y divide-slate-100">
              {DEADLINES.map((d) => {
                const left = daysLeft(d.date);
                const tone: Tone = left < 0 ? 'bad' : left <= 7 ? 'warn' : 'ok';
                return (
                  <div key={d.id} className="flex items-start gap-3 px-4 py-3">
                    <Dot tone={tone} />
                    <div className="flex-1">
                      <div className="text-[13px] font-medium text-navy">{d.title}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">{d.rule}</div>
                    </div>
                    <div className="text-right">
                      <div className="num text-[15px] font-semibold text-navy">
                        {new Date(d.date + 'T00:00:00').toLocaleDateString('ru-RU')}
                      </div>
                      <div
                        className={`text-[11px] font-medium ${left < 0 ? 'text-red' : left <= 7 ? 'text-amber-600' : 'text-slate-500'}`}
                      >
                        {left < 0 ? `просрочено на ${-left} дн.` : `осталось ${left} дн.`}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
