import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './lib/db';
import { ensureDeferredSeed, ensureSeed } from './lib/seed';
import { isAutoUpdate, runSync } from './lib/sync';
import { loadPrefs } from './lib/prefs';
import { buildNav, loadNav } from './lib/nav';
import { usePullToRefresh } from './hooks/usePullToRefresh';
import { maybeAutoAudit } from './lib/audit';
import { applyAiSetupFromHash } from './lib/aiconf';
import AppShell from './components/app/AppShell';
import WelcomeSplash from './components/app/WelcomeSplash';
import EditMode from './components/app/EditMode';
import Dashboard from './sections/Dashboard';
import Estimate from './sections/Estimate';
import Payroll from './sections/Payroll';
import SberPay from './sections/SberPay';
import Operations from './sections/Operations';
import Advances from './sections/Advances';
import Reports from './sections/Reports';
import ControlCalendar from './sections/ControlCalendar';
import Directory from './sections/Directory';
import CustomPage from './sections/CustomPage';
import type { Budget } from './types';

const Admin = lazy(() => import('./admin/Admin'));

export default function App() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState('dashboard');
  const [commissionId, setCommissionId] = useState<number | null>(null);
  const [budget, setBudget] = useState<Budget>('krai');
  const [online, setOnline] = useState(navigator.onLine);
  const [welcomeEnabled] = useState(() => loadPrefs().welcome);
  const [welcomeDone, setWelcomeDone] = useState(false);

  useEffect(() => {
    applyAiSetupFromHash(); // мгновенная настройка «Помощи» по ссылке #aisetup=провайдер:ключ
    ensureSeed().then(() => setReady(true));
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const commissions = useLiveQuery(() => db.commissions.orderBy('id').toArray(), []);
  const navCfg = useLiveQuery(() => loadNav(), []);
  const pages = useLiveQuery(() => db.pages.orderBy('order').toArray(), []);
  const navItems = navCfg ? buildNav(navCfg, pages ?? []) : undefined;

  // если текущий раздел скрыли/удалили — вернуться на дашборд
  useEffect(() => {
    if (!navItems || view === 'admin') return;
    const current = navItems.find((n) => n.id === view);
    if (!current || current.hidden) setView('dashboard');
  }, [view, navItems]);

  // комиссия по умолчанию — ТИК Норильска
  useEffect(() => {
    if (commissionId == null && commissions?.length) {
      const def =
        commissions.find((c) => c.code === 'ТИК Норильск') ?? commissions.find((c) => c.level === 'TIK') ?? commissions[0];
      setCommissionId(def.id);
    }
  }, [commissions, commissionId]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  // Ночной автопрогон аудита: раз в сутки в окне 00:00–05:00,
  // при первом открытии после окна — догоняющий. Результат — мигающее окно в Admin.
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const kick = () => {
      if (stopped) return;
      void maybeAutoAudit().catch(() => {});
    };
    const t0 = setTimeout(kick, 15_000); // не мешаем первичной загрузке
    const iv = setInterval(kick, 30 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === 'visible') kick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearTimeout(t0);
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ready]);

  // отложенный сид + автообновление из источников при запуске (в idle-время)
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const kick = () => {
      if (cancelled) return;
      ensureDeferredSeed()
        .then(() => isAutoUpdate())
        .then((auto) => {
          if (auto && !cancelled) runSync('start');
        })
        .catch(() => {});
    };
    let idleId: number | undefined;
    let timerId: number | undefined;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === 'function') {
      idleId = w.requestIdleCallback(kick, { timeout: 3000 });
    } else {
      timerId = window.setTimeout(kick, 1500);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && w.cancelIdleCallback) w.cancelIdleCallback(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [ready]);

  const refreshByGesture = useCallback(() => {
    isAutoUpdate().then((auto) => {
      if (auto) runSync('gesture');
    });
  }, []);
  usePullToRefresh(refreshByGesture);

  if (!ready || !commissions || !navItems || commissionId == null) {
    return (
      <>
        <div className="grid min-h-screen place-items-center bg-navy text-white">
          <div className="text-center">
            <div className="mx-auto mb-4 h-[2px] w-12 bg-red" />
            <div className="text-[18px] font-semibold">Комиссия.Финансы — Норильск</div>
            <div className="mt-1 text-[12px] text-white/60">реестр комиссий МО город Норильск…</div>
          </div>
        </div>
        {welcomeEnabled && !welcomeDone && <WelcomeSplash appReady={false} onDone={() => setWelcomeDone(true)} />}
      </>
    );
  }

  const sectionProps = { commissionId, budget };

  return (
    <>
      {welcomeEnabled && !welcomeDone && <WelcomeSplash appReady onDone={() => setWelcomeDone(true)} />}
      <AppShell
        view={view}
        setView={setView}
        navItems={navItems}
        commissions={commissions}
        commissionId={commissionId}
        setCommissionId={setCommissionId}
        budget={budget}
        setBudget={setBudget}
        online={online}
      >
        {view === 'dashboard' && <Dashboard {...sectionProps} />}
        {view === 'estimate' && <Estimate {...sectionProps} />}
        {view === 'payroll' && <Payroll {...sectionProps} />}
        {view === 'sberpay' && <SberPay />}
        {view === 'operations' && <Operations {...sectionProps} />}
        {view === 'advances' && <Advances {...sectionProps} />}
        {view === 'reports' && <Reports {...sectionProps} />}
        {view === 'control' && <ControlCalendar />}
        {view === 'directory' && <Directory {...sectionProps} onSelectCommission={setCommissionId} />}
        {view === 'admin' && (
          <Suspense fallback={<div className="py-10 text-center text-[13px] text-slate-500">Загрузка панели управления…</div>}>
            <Admin commissionId={commissionId} budget={budget} commissions={commissions} />
          </Suspense>
        )}
        {view.startsWith('page-') && <CustomPage id={Number(view.slice(5))} />}
        <EditMode />
      </AppShell>
    </>
  );
}
