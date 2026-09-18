import { FileSpreadsheet, Printer } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { budgetLines } from '../lib/calc';
import { getLineNames } from '../lib/settings';
import { exportXlsx, printPage } from '../lib/excel';
import { ACCOUNT_NAME, BUDGET_NAME, ELECT } from '../lib/rules';
import { rub } from '../lib/fmt';
import { Card, CardHead, Num, SectionHead, Table } from '../components/app/kit';
import type { Budget } from '../types';

export default function Reports({ commissionId, budget }: { commissionId: number; budget: Budget }) {
  const data = useLiveQuery(async () => {
    const commission = await db.commissions.get(commissionId);
    const estimate = await db.estimate.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const ops = await db.operations.where('[commissionId+budget]').equals([commissionId, budget]).toArray();
    const customNames = await getLineNames();
    return { commission, estimate, ops, customNames };
  }, [commissionId, budget]);

  if (!data) return <div className="text-slate-500">Загрузка…</div>;

  const lines = budgetLines(data.estimate, data.ops, data.customNames);
  const totLimit = lines.reduce((s, l) => s + l.limit, 0);
  const totIn = lines.reduce((s, l) => s + l.inSum, 0);
  const totOut = lines.reduce((s, l) => s + l.outSum, 0);

  const doExport = () => {
    exportXlsx(`Отчёт_прил10_${data.commission?.code ?? ''}_${budget}.xlsx`, [
      {
        name: 'Прил.10 Отчёт',
        rows: [
          [
            `Отчёт о поступлении и расходовании средств, выделенных из ${BUDGET_NAME[budget].toLowerCase()} на подготовку и проведение выборов`,
          ],
          [`${data.commission?.name ?? ''} · счёт ${ACCOUNT_NAME[budget]} · кампания: ${ELECT.title}`],
          [],
          ['Код', 'Наименование направления', 'Выделено по смете, ₽', 'Поступило, ₽', 'Израсходовано, ₽', 'Остаток, ₽'],
          ...lines.map((l) => [l.code, l.name, l.limit, l.inSum, l.outSum, l.rest]),
          ['', 'ИТОГО', totLimit, totIn, totOut, totLimit - totOut],
          [],
          [
            'Председатель комиссии',
            data.commission?.chair ?? '',
            '',
            'Бухгалтер',
            data.commission?.accountant ?? '',
            '',
          ],
        ],
        widths: [10, 44, 18, 16, 18, 16],
      },
    ]);
  };

  return (
    <div>
      <SectionHead
        label="Модуль М8 · прил. № 9"
        title="Отчёт о поступлении и расходовании средств"
        right={
          <div className="flex gap-2">
            <button
              onClick={doExport}
              className="flex items-center gap-1.5 border border-navy bg-white px-3 py-2 text-[12px] font-medium text-navy hover:bg-slate-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={1.75} /> Excel (машиночитаемый вид)
            </button>
            <button
              onClick={printPage}
              className="flex items-center gap-1.5 bg-navy px-3 py-2 text-[12px] font-medium text-white hover:bg-navy-800"
            >
              <Printer className="h-3.5 w-3.5" strokeWidth={1.75} /> Печать формы
            </button>
          </div>
        }
      />
      <Card className="mb-5">
        <CardHead>Параметры формы</CardHead>
        <div className="grid gap-3 px-4 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="lbl">Комиссия</div>
            <div className="font-medium text-navy">{data.commission?.name}</div>
          </div>
          <div>
            <div className="lbl">Контур</div>
            <div className="font-medium text-navy">{BUDGET_NAME[budget]}</div>
          </div>
          <div>
            <div className="lbl">Счёт</div>
            <div className="font-medium text-navy">{ACCOUNT_NAME[budget]}</div>
          </div>
          <div>
            <div className="lbl">Кампания</div>
            <div className="font-medium text-navy">{ELECT.title}</div>
          </div>
        </div>
      </Card>
      <Table head={['Код', 'Наименование направления', 'Выделено по смете', 'Поступило', 'Израсходовано', 'Остаток']}>
        {lines.map((l) => (
          <tr key={l.code}>
            <td className="w-[70px]">
              <span className="border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold text-navy">{l.code}</span>
            </td>
            <td className="min-w-[260px] text-[13px] font-medium text-navy">{l.name}</td>
            <td className="w-[150px] text-right">
              <Num>{rub(l.limit)}</Num>
            </td>
            <td className="w-[150px] text-right">
              <Num>{rub(l.inSum)}</Num>
            </td>
            <td className="w-[150px] text-right">
              <Num strong>{rub(l.outSum)}</Num>
            </td>
            <td className="w-[150px] text-right">
              <Num className={l.rest < 0 ? 'text-red' : ''}>{rub(l.rest)}</Num>
            </td>
          </tr>
        ))}
        <tr className="bg-slate-50">
          <td colSpan={2} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Итого
          </td>
          <td className="text-right">
            <Num strong>{rub(totLimit)}</Num>
          </td>
          <td className="text-right">
            <Num strong>{rub(totIn)}</Num>
          </td>
          <td className="text-right">
            <Num strong>{rub(totOut)}</Num>
          </td>
          <td className="text-right">
            <Num strong className="text-red">
              {rub(totLimit - totOut)}
            </Num>
          </td>
        </tr>
      </Table>
      <p className="mt-4 text-[12px] text-slate-500">
        К отчёту прилагаются первичные финансовые документы, сброшюрованные и со сквозной нумерацией, подтверждение
        банка о закрытии счёта либо об остатках средств. Отчёт представляется на бумажном носителе и в машиночитаемом
        виде (MS Excel).
      </p>
      <div className="print-doc hidden">
        <div className="doc">
          <p className="doc-right">
            Приложение № 9<br />к Инструкции о порядке открытия и ведения счетов,
            <br />
            учёта, отчётности и перечисления средств (7/59-7)
          </p>
          <h2 className="doc-title">
            ОТЧЁТ<br />о поступлении и расходовании средств, выделенных из {BUDGET_NAME[budget].toLowerCase()},<br />
            на подготовку и проведение выборов
          </h2>
          <p className="doc-sub">
            {data.commission?.name} · {ACCOUNT_NAME[budget]} · {ELECT.title}
          </p>
          <table className="doc-table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Наименование направления расходов</th>
                <th>Выделено по смете, ₽</th>
                <th>Поступило, ₽</th>
                <th>Израсходовано, ₽</th>
                <th>Остаток, ₽</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.code}>
                  <td>{l.code}</td>
                  <td className="l">{l.name}</td>
                  <td>{l.limit.toFixed(2)}</td>
                  <td>{l.inSum.toFixed(2)}</td>
                  <td>{l.outSum.toFixed(2)}</td>
                  <td>{l.rest.toFixed(2)}</td>
                </tr>
              ))}
              <tr className="tot">
                <td colSpan={2}>ИТОГО</td>
                <td>{totLimit.toFixed(2)}</td>
                <td>{totIn.toFixed(2)}</td>
                <td>{totOut.toFixed(2)}</td>
                <td>{(totLimit - totOut).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
          <p className="doc-note">
            Первичные финансовые документы, подтверждающие поступление и расходование средств, прилагаются
            (прошнурованы, пронумерованы, на ____ листах). Подтверждение банка прилагается.
          </p>
          <div className="doc-sign">
            <div>Председатель комиссии ____________________ / {data.commission?.chair ?? '________'} /</div>
            <div>Бухгалтер ____________________ / {data.commission?.accountant ?? '________'} /</div>
            <div>«___» ______________ 2026 г.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
