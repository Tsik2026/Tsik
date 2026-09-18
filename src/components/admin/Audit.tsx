// ── Аудит: карточка проверки финансовой отчётности (Admin) ───────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  ScanSearch,
  ChevronDown,
  ListChecks,
  Landmark,
  Timer,
  RefreshCw,
} from 'lucide-react';
import {
  runAudit,
  loadLastAudit,
  markAuditSeen,
  unseenAutoAudit,
  AUDIT_STATUS_NAME,
  type AuditReport,
  type AuditStatus,
  type AuditFinding,
} from '../../lib/audit';

const STATUS_STYLE: Record<AuditStatus, { badge: string; icon: typeof ShieldCheck; border: string }> = {
  ok: { badge: 'bg-emerald-100 text-emerald-800 border-emerald-300', icon: ShieldCheck, border: 'border-emerald-200' },
  fail: { badge: 'bg-red-100 text-red-800 border-red-300', icon: ShieldAlert, border: 'border-red-300' },
  fix: { badge: 'bg-amber-100 text-amber-900 border-amber-300', icon: ShieldQuestion, border: 'border-amber-300' },
};

const RUN_STAGES = [
  'Загрузка данных из локальной базы…',
  'Проверка смет и лимитов…',
  'Контроль операций и первичных документов…',
  'Подотчёт, вознаграждения и табель…',
  'Сверка счетов с выписками банка…',
  'Состав, реестр и готовность к рубежу…',
  'Формирование рекомендаций принимающей стороне…',
];

function fmtAt(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Мигающее окно результата ночного автопрогона ─────────────────────
export function AutoAuditBanner() {
  const [report, setReport] = useState<AuditReport | null>(null);
  useEffect(() => {
    void unseenAutoAudit().then(setReport);
  }, []);
  if (!report) return null;
  const hasIssues = report.fail > 0 || report.fix > 0;
  return (
    <div
      className={`audit-blink relative mb-4 overflow-hidden rounded-xl border-2 p-4 shadow-lg ${
        report.fail > 0
          ? 'border-red-500 bg-red-50'
          : hasIssues
            ? 'border-amber-400 bg-amber-50'
            : 'border-emerald-500 bg-emerald-50'
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <ScanSearch className="h-6 w-6 shrink-0 text-slate-700" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-slate-900">
            Ночной автопрогон аудита — {fmtAt(report.at)}
          </div>
          <div className="text-xs text-slate-700">
            {report.fail > 0 ? (
              <>Несоответствий: <b className="text-red-700">{report.fail}</b> · </>
            ) : null}
            {report.fix > 0 ? (
              <>Правок: <b className="text-amber-700">{report.fix}</b> · </>
            ) : null}
            Соответствует: <b className="text-emerald-700">{report.ok}</b>
            {hasIssues ? ' — откройте карточку «Аудит» ниже и устраните замечания.' : ' — замечаний нет.'}
          </div>
        </div>
        <button
          onClick={() => {
            void markAuditSeen(report.at).then(() => setReport(null));
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
        >
          Понятно, скрыть
        </button>
      </div>
    </div>
  );
}

// ── Пункт разбора ────────────────────────────────────────────────────
function FindingRow({ f, defaultOpen }: { f: AuditFinding; defaultOpen: boolean }) {
  const st = STATUS_STYLE[f.status];
  const Icon = st.icon;
  return (
    <details
      open={defaultOpen}
      className={`group rounded-lg border bg-white ${st.border} open:shadow-sm`}
    >
      <summary className="flex cursor-pointer list-none items-start gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" size={18} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">{f.title}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${st.badge}`}>
              {AUDIT_STATUS_NAME[f.status]}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{f.scope}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{f.detail}</p>
        </div>
        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-slate-100 px-3 pb-3 pt-2">
        <p className="text-[11px] text-slate-500">
          <Landmark className="mr-1 inline h-3 w-3 align-[-1px]" />
          Основание: {f.norm}
        </p>
        {f.fix && f.fix.length > 0 && (
          <div className="mt-2 rounded-md bg-amber-50/70 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
              <ListChecks className="h-3.5 w-3.5" />
              Пошаговая рекомендация — где и что исправить
            </div>
            <ol className="space-y-1.5">
              {f.fix.map((step, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-700">
                  <span className="flex shrink-0 items-center justify-center rounded-full bg-amber-200/80 text-[10px] font-bold text-amber-900" style={{ minWidth: 18, height: 18 }}>
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </details>
  );
}

// ── Основная карточка ────────────────────────────────────────────────
export default function AuditCard() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(0);
  const [filter, setFilter] = useState<'all' | AuditStatus>('all');
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void loadLastAudit().then(setReport);
    return () => {
      if (stageTimer.current) clearInterval(stageTimer.current);
    };
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setStage(0);
    stageTimer.current = setInterval(() => {
      setStage((s) => Math.min(s + 1, RUN_STAGES.length - 1));
    }, 700);
    const started = performance.now();
    try {
      const rep = await runAudit('manual');
      const minTime = RUN_STAGES.length * 700;
      const rest = minTime - (performance.now() - started);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
      setReport(rep);
      setFilter(rep.fail > 0 ? 'all' : 'all');
    } finally {
      if (stageTimer.current) clearInterval(stageTimer.current);
      setRunning(false);
    }
  }, [running]);

  const grouped = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, AuditFinding[]>();
    for (const f of report.findings) {
      if (filter !== 'all' && f.status !== filter) continue;
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return [...map.entries()];
  }, [report, filter]);

  const counts = report ? { ok: report.ok, fail: report.fail, fix: report.fix } : null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-slate-800">
            <ScanSearch className="h-5 w-5 text-slate-600" />
            Аудит · проверка финансовой отчётности
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
            Тщательный разбор от лица принимающей стороны (ИК КК ← ТИК ← УИК): соответствие требованиям
            Красноярского края — сметы и лимиты, первичка, раздельный учёт (ст. 21 УЗ КК 11-4807), подотчёт,
            вознаграждения, сверка счетов, реестр. Каждый пункт — «Соответствует» / «Несоответствие» / «Правки»
            с пошаговой рекомендацией. Ручное формирование и проверка доступны на любом этапе, вплоть до дня сдачи
            отчётов; ночью выполняется автопрогон, его результат появится мигающим окном вверху панели.
          </p>
        </div>
        {report && (
          <div className="text-right text-[11px] text-slate-400">
            Последняя проверка: <b className="text-slate-600">{fmtAt(report.at)}</b>
            <br />({report.trigger === 'auto' ? 'ночной автопрогон' : 'вручную'})
          </div>
        )}
      </div>

      {/* Интерактивная кнопка с погружением */}
      <button
        onClick={() => void run()}
        disabled={running}
        className={`audit-dive-btn group relative mt-4 w-full overflow-hidden rounded-xl border-2 px-5 py-4 text-left transition-all ${
          running
            ? 'cursor-wait border-slate-700 bg-slate-900'
            : 'border-slate-800 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 hover:shadow-lg hover:shadow-slate-400/40 active:scale-[0.995]'
        }`}
      >
        <span className="audit-dive-shine pointer-events-none absolute inset-0" aria-hidden />
        <span className="relative flex items-center gap-3">
          {running ? (
            <RefreshCw className="h-6 w-6 animate-spin text-white" />
          ) : (
            <ScanSearch className="h-6 w-6 text-white transition-transform group-hover:scale-110" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-white sm:text-base">
              {running ? 'Идёт проверка…' : 'Подготовить полный отчёт / Проверить и дать совет'}
            </span>
            <span className="block truncate text-[11px] text-slate-300">
              {running ? RUN_STAGES[stage] : 'Полный цикл: база → сметы → первичка → подотчёт → табель → сверка → рекомендации'}
            </span>
          </span>
          {running && (
            <span className="hidden shrink-0 text-xs font-semibold text-slate-300 sm:block">
              {stage + 1}/{RUN_STAGES.length}
            </span>
          )}
        </span>
        {running && (
          <span className="relative mt-3 block h-1.5 overflow-hidden rounded-full bg-slate-700">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-emerald-400 to-amber-300 transition-all duration-700"
              style={{ width: `${((stage + 1) / RUN_STAGES.length) * 100}%` }}
            />
          </span>
        )}
      </button>

      {/* Сводка и фильтры */}
      {report && counts && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`Все проверки · ${report.findings.length}`} tone="slate" />
          <FilterChip active={filter === 'ok'} onClick={() => setFilter('ok')} label={`Соответствует · ${counts.ok}`} tone="emerald" />
          <FilterChip active={filter === 'fail'} onClick={() => setFilter('fail')} label={`Несоответствие · ${counts.fail}`} tone="red" />
          <FilterChip active={filter === 'fix'} onClick={() => setFilter('fix')} label={`Правки · ${counts.fix}`} tone="amber" />
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-slate-400 sm:flex">
            <Timer className="h-3 w-3" />
            ночной автопрогон ежедневно 00:00–05:00
          </span>
        </div>
      )}

      {/* Разбор по категориям */}
      {report && grouped.length > 0 && (
        <div className="mt-4 space-y-5">
          {grouped.map(([category, list]) => (
            <div key={category}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{category}</span>
                <span className="h-px flex-1 bg-slate-200" />
                <span className="text-[11px] text-slate-400">{list.length}</span>
              </div>
              <div className="space-y-2">
                {list.map((f) => (
                  <FindingRow key={f.id} f={f} defaultOpen={f.status !== 'ok'} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {report && grouped.length === 0 && (
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          По выбранному фильтру пунктов нет — переключите фильтр выше.
        </p>
      )}

      {!report && !running && (
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          Проверка ещё не запускалась. Нажмите кнопку выше — отчёт строится по данным локальной базы за секунды,
          без передачи данных наружу.
        </p>
      )}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone: 'slate' | 'emerald' | 'red' | 'amber';
}) {
  const tones = {
    slate: active ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50',
    emerald: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50',
    red: active ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-300 hover:bg-red-50',
    amber: active ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-800 border-amber-300 hover:bg-amber-50',
  };
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors ${tones[tone]}`}
    >
      {label}
    </button>
  );
}
