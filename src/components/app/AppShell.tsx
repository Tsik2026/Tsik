import type { ReactNode } from 'react';
import {
  ArrowLeftRight,
  BookOpen,
  CalendarClock,
  FileSpreadsheet,
  FileText,
  HardDrive,
  LayoutDashboard,
  ReceiptText,
  Users,
  Vote,
  Wallet,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { BUDGET_NAME, ELECT } from '../../lib/rules';
import { cls } from '../../lib/fmt';
import type { Budget, Commission } from '../../types';
import type { NavItem } from '../../lib/nav';
import InfoTicker, { SyncIndicator } from './InfoTicker';
import HelpButton from './HelpGuide';
import SettingsButton from './SettingsPanel';
import pandaAdmin from '../../assets/panda-admin.png';

const SECTION_ICON: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  estimate: Wallet,
  payroll: Users,
  operations: ArrowLeftRight,
  advances: ReceiptText,
  reports: FileSpreadsheet,
  control: CalendarClock,
  directory: BookOpen,
};

const iconFor = (id: string): LucideIcon => SECTION_ICON[id] ?? FileText;

interface AppShellProps {
  view: string;
  setView: (v: string) => void;
  navItems: NavItem[];
  commissions: Commission[];
  commissionId: number | null;
  setCommissionId: (id: number) => void;
  budget: Budget;
  setBudget: (b: Budget) => void;
  online: boolean;
  children: ReactNode;
}

export default function AppShell(props: AppShellProps) {
  const { view, setView, navItems, commissions, commissionId, setCommissionId, budget, setBudget, online } = props;
  return (
    <div className="app-shell flex min-h-screen bg-paper">
      <SyncIndicator />
      {/* ── Боковая панель (десктоп) ── */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-[248px] flex-col bg-navy text-white max-lg:hidden">
        <div className="border-b border-white/10 px-5 pb-5 pt-6">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center border border-white/25">
              <Vote className="h-5 w-5 text-white" strokeWidth={1.75} />
            </span>
            <div>
              <div className="text-[15px] font-semibold leading-tight tracking-wide">Комиссия.Финансы</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-white/50">МО город Норильск</div>
            </div>
          </div>
          <div className="mt-4 h-[2px] w-10 bg-red" />
          <div className="mt-2 text-[11px] leading-snug text-white/60">{ELECT.title}</div>
          <div className="mt-1.5 text-[11px] leading-snug text-white/45">ТИК города Норильска · 63 УИК</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-3">
          {navItems
            .filter((n) => !n.hidden)
            .map((n) => {
              const active = view === n.id;
              const Icon = iconFor(n.id);
              return (
                <button
                  key={n.id}
                  onClick={() => setView(n.id)}
                  className={cls(
                    'group relative flex w-full items-center gap-3 px-5 py-[9px] text-left transition-colors',
                    active ? 'bg-white/[0.07] text-white' : 'text-white/65 hover:bg-white/[0.04] hover:text-white',
                  )}
                >
                  <span className={cls('absolute left-0 top-0 h-full w-[3px]', active ? 'bg-red' : 'bg-transparent')} />
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span>
                    <span className="block text-[13px] font-medium leading-tight">{n.label}</span>
                    <span className="block text-[10px] text-white/40">{n.hint}</span>
                  </span>
                </button>
              );
            })}
        </nav>
        <div className="border-t border-white/10 px-3 py-2">
          <button
            onClick={() => setView('admin')}
            className={cls(
              'flex w-full items-center gap-3 px-2 py-2 text-left transition-colors',
              view === 'admin' ? 'bg-white/[0.07] text-white' : 'text-white/65 hover:bg-white/[0.04] hover:text-white',
            )}
          >
            <img src={pandaAdmin} alt="" className="panda-admin h-5 w-5 shrink-0" />
            <span>
              <span className="block text-[13px] font-medium leading-tight">Admin</span>
              <span className="block text-[10px] text-white/40">Управление приложением</span>
            </span>
          </button>
        </div>
        <div className="border-t border-white/10 px-5 py-4 text-[10px] leading-relaxed text-white/45">
          <div className="flex items-center gap-1.5">
            <HardDrive className="h-3 w-3" strokeWidth={1.75} />
            Данные — локально в IndexedDB этого браузера
          </div>
          <div className="mt-1">
            Матрица правил: пост. ЦИК 7/59-7, 10/101-9; решение ИК КК 98/1080-8; пост. Администрации Норильска 442 (ред.
            111)
          </div>
        </div>
      </aside>

      {/* ── Основная колонка ── */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-paper/95 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 sm:gap-3 sm:px-5">
            <div className="flex items-center gap-2 lg:hidden">
              <Vote className="h-5 w-5 text-navy" strokeWidth={1.75} />
              <span className="text-[15px] font-semibold text-navy">Комиссия.Финансы</span>
            </div>
            <div className="ms-auto flex flex-wrap items-center gap-2 max-lg:w-full">
              {!online && (
                <span className="flex items-center gap-1.5 border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 max-lg:w-full">
                  <WifiOff className="h-3.5 w-3.5" /> офлайн — изменения сохранятся локально
                </span>
              )}
              <select
                value={commissionId ?? ''}
                onChange={(e) => setCommissionId(Number(e.target.value))}
                className="h-10 max-w-[320px] border border-slate-300 bg-white px-2.5 text-[13px] text-navy outline-none focus:border-navy max-lg:w-full max-lg:max-w-none lg:h-9"
                title="Комиссия (ТИК Норильска и 63 УИК)"
              >
                {commissions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                    {c.district ? ` · ${c.district}` : ''}
                    {c.uikNo ? '' : ` — ${c.name}`}
                  </option>
                ))}
              </select>
              <div className="flex border border-slate-300 bg-white text-[12px] font-medium max-lg:w-full">
                {(['krai', 'fed'] as Budget[]).map((b) => (
                  <button
                    key={b}
                    onClick={() => setBudget(b)}
                    className={cls(
                      'px-3 py-2.5 transition-colors max-lg:flex-1 max-lg:py-2 lg:py-2',
                      budget === b ? 'bg-navy text-white' : 'text-slate-600 hover:bg-slate-50',
                    )}
                    title={BUDGET_NAME[b]}
                  >
                    {b === 'krai' ? 'Краевой 40202' : 'Федеральный 40201'}
                  </button>
                ))}
              </div>
              {/* Задача 16: «Как работать на сайте», Admin, «Настройки» — всегда одной строкой */}
              <div className="flex items-stretch gap-2 max-lg:w-full">
                <HelpButton />
                <button
                  onClick={() => setView('admin')}
                  title="Панель администрирования"
                  className={cls(
                    'flex h-10 items-center justify-center gap-1.5 border px-3 text-[12px] font-semibold transition-colors max-lg:flex-1 lg:h-9',
                    view === 'admin'
                      ? 'border-navy bg-navy text-white'
                      : 'border-slate-300 bg-white text-navy hover:bg-slate-50',
                  )}
                >
                  <img src={pandaAdmin} alt="" className="panda-admin h-5 w-5" />
                  Admin
                </button>
                <SettingsButton onOpenAdmin={() => setView('admin')} />
              </div>
            </div>
          </div>
        </header>
        <InfoTicker />
        <main className="min-w-0 flex-1 px-4 py-5 pb-24 sm:px-5 sm:py-6 lg:px-8 lg:pb-6">{props.children}</main>

        {/* ── Нижняя панель (мобильная) — задача 20: тёмный фон ── */}
        <nav
          className="fixed inset-x-0 bottom-0 z-30 border-t border-navy-900 bg-navy/95 text-white backdrop-blur lg:hidden"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="flex overflow-x-auto">
            {navItems
              .filter((n) => !n.hidden)
              .map((n) => {
                const active = view === n.id;
                const Icon = iconFor(n.id);
                return (
                  <button
                    key={n.id}
                    onClick={() => setView(n.id)}
                    className={cls(
                      'relative flex min-w-[68px] flex-1 flex-col items-center gap-1 px-1.5 pb-1.5 pt-2',
                      active ? 'text-white' : 'text-white/50',
                    )}
                  >
                    <span className={cls('absolute inset-x-3 top-0 h-[2px]', active ? 'bg-red' : 'bg-transparent')} />
                    <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} />
                    <span className="whitespace-nowrap text-[9px] font-medium leading-none">{n.short}</span>
                  </button>
                );
              })}
            <button
              onClick={() => setView('admin')}
              className={cls(
                'relative flex min-w-[68px] flex-1 flex-col items-center gap-1 px-1.5 pb-1.5 pt-2',
                view === 'admin' ? 'text-white' : 'text-white/50',
              )}
            >
              <span className={cls('absolute inset-x-3 top-0 h-[2px]', view === 'admin' ? 'bg-red' : 'bg-transparent')} />
              <img src={pandaAdmin} alt="" className="panda-admin h-5 w-5" />
              <span className="whitespace-nowrap text-[9px] font-medium leading-none">Admin</span>
            </button>
          </div>
        </nav>

        <footer className="border-t border-slate-200 px-5 py-4 text-[11px] text-slate-500 lg:px-8">
          Учёт ведётся раздельно по средствам федерального и краевого бюджетов (ст. 21 УЗ КК 11-4807). Формы носят
          подготовительный характер — подпись и подача осуществляются комиссией по регламенту.
        </footer>
      </div>
    </div>
  );
}
