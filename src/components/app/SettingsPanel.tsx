import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  CircleQuestionMark,
  Database,
  Download,
  FileUp,
  HardDrive,
  Palette,
  Scale,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import { db } from '../../lib/db';
import { loadPrefs, savePrefs } from '../../lib/prefs';
import { getLastSync, isAutoUpdate, setAutoUpdate } from '../../lib/sync';
import { exportBackup, importBackup } from '../../lib/backup';
import { ELECT } from '../../lib/rules';
import { cls } from '../../lib/fmt';
import type { Prefs } from '../../types';

// ── Вкладки (упоминания облачной базы убраны — задача 18) ────────────
const TABS: { id: string; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: 'Оформление', hint: 'Тема фона, масштаб', icon: Palette },
  { id: 'data', label: 'Данные', hint: 'Хранилище, резервные копии', icon: Database },
  { id: 'help', label: 'Справка', hint: 'Руководство, нормативка', icon: CircleQuestionMark },
];

const THEMES: { id: Prefs['theme']; name: string; desc: string; rgb: string; recommended?: boolean }[] = [
  { id: 'light', name: 'Стандартный', desc: 'Исходный светлый фон приложения.', rgb: '244 245 247' },
  {
    id: 'dim',
    name: 'Приглушённый',
    desc: 'Чуть темнее стандартного — снижает нагрузку на зрение при длительной работе.',
    rgb: '226 229 235',
    recommended: true,
  },
  {
    id: 'warm',
    name: 'Тёплый бумажный',
    desc: 'Меньше синей составляющей — мягче для глаз в вечернее время.',
    rgb: '236 231 221',
  },
];

const ZOOMS: Prefs['zoom'][] = [90, 100, 110];

// ── Мелкие элементы ──────────────────────────────────────────────────
function GroupTitle({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{children}</div>;
}

function OutlineBtn({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 border border-navy bg-white px-3 py-2 text-[12px] font-semibold text-navy transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cls(
        'relative h-[20px] w-[36px] shrink-0 border transition-colors',
        checked ? 'border-navy bg-navy' : 'border-slate-300 bg-slate-200',
      )}
    >
      <span className={cls('absolute top-[2px] h-[14px] w-[14px] bg-white transition-all', checked ? 'left-[18px]' : 'left-[2px]')} />
    </button>
  );
}

// ── Вкладка «Оформление» ─────────────────────────────────────────────
function AppearanceTab() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const patch = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    savePrefs(next);
  };
  return (
    <div className="grid gap-5">
      <section>
        <GroupTitle>Тема фона</GroupTitle>
        <div className="grid gap-2 sm:grid-cols-3">
          {THEMES.map((t) => {
            const active = prefs.theme === t.id;
            return (
              <button
                key={t.id}
                data-theme-option={t.id}
                onClick={() => patch({ theme: t.id })}
                className={cls(
                  'border p-3 text-left transition-colors',
                  active ? 'border-navy bg-slate-50' : 'border-slate-200 bg-white hover:border-slate-300',
                )}
              >
                <span className="mb-2 flex items-center justify-between">
                  <span className="text-[12.5px] font-semibold text-navy">{t.name}</span>
                  {active && <Check className="h-4 w-4 text-red" strokeWidth={2} />}
                </span>
                <span className="block border border-slate-300/60 p-2" style={{ background: `rgb(${t.rgb})` }}>
                  <span className="block border border-slate-200 bg-white px-2 py-1.5">
                    <span className="block h-[3px] w-3/4 bg-slate-300" />
                    <span className="mt-1 block h-[3px] w-1/2 bg-slate-200" />
                  </span>
                </span>
                <span className="mt-2 block text-[11px] leading-snug text-slate-500">{t.desc}</span>
                {t.recommended && (
                  <span className="mt-1.5 inline-block border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    рекомендуется
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <GroupTitle>Масштаб интерфейса</GroupTitle>
        <div className="flex border border-slate-300 bg-white text-[12px] font-medium max-sm:w-full sm:w-fit">
          {ZOOMS.map((z) => (
            <button
              key={z}
              data-zoom-option={z}
              onClick={() => patch({ zoom: z })}
              className={cls(
                'px-4 py-2 transition-colors max-sm:flex-1',
                prefs.zoom === z ? 'bg-navy text-white' : 'text-slate-600 hover:bg-slate-50',
              )}
            >
              {z}%
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Увеличенный масштаб удобен на проекторах и при слабом зрении, уменьшенный — на небольших экранах ноутбуков.
        </p>
      </section>
      <section>
        <GroupTitle>Приветственный экран</GroupTitle>
        <label className="flex items-center gap-2 text-[12.5px] text-slate-600">
          <Switch checked={prefs.welcome} onChange={(v) => patch({ welcome: v })} />
          Показывать при запуске приложения
        </label>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          Краткий экран приветствия с плавным автоматическим закрытием за 2–4 секунды. Пропуск — кликом или клавишей
          Esc.
        </p>
      </section>
      <p className="border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        Настройки оформления применяются сразу и хранятся на этом устройстве — на учётные данные они не влияют.
      </p>
    </div>
  );
}

// ── Вкладка «Данные» ─────────────────────────────────────────────────
const COUNT_TABLES: [string, string][] = [
  ['commissions', 'Комиссии'],
  ['members', 'Члены комиссий'],
  ['estimate', 'Смета'],
  ['operations', 'Операции'],
  ['timesheet', 'Табели'],
  ['advances', 'Подотчёт'],
  ['accounts', 'Счета'],
  ['documents', 'Документы'],
  ['pages', 'Страницы'],
];

function DataTab({ onOpenAdmin }: { onOpenAdmin?: () => void }) {
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  const [counts, setCounts] = useState<[string, number][] | null>(null);
  const [autoUpd, setAutoUpd] = useState<boolean | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const est = await navigator.storage?.estimate?.();
        if (est) setStorage({ used: est.usage ?? 0, quota: est.quota ?? 0 });
      } catch {
        /* ignore */
      }
      const rows = await Promise.all(
        COUNT_TABLES.map(async ([table, label]) => {
          try {
            return [label, await (db as unknown as Record<string, { count(): Promise<number> }>)[table].count()] as [string, number];
          } catch {
            return [label, 0] as [string, number];
          }
        }),
      );
      setCounts(rows);
      setAutoUpd(await isAutoUpdate());
      const last = await getLastSync();
      setLastSyncAt(last ? new Date(last.at).toLocaleString('ru-RU') : null);
    })();
  }, []);

  const mb = (n: number) => (n / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 });

  const restore = async (file: File) => {
    if (!window.confirm('Восстановление заменит ВСЕ текущие данные содержимым резервной копии. Продолжить?')) return;
    try {
      const message = await importBackup(file);
      window.alert(message);
      window.location.reload();
    } catch (e) {
      setErr(`Восстановление не выполнено: ${e instanceof Error ? e.message : 'ошибка файла'}`);
    }
  };

  return (
    <div className="grid gap-5">
      <section>
        <GroupTitle>Локальное хранилище</GroupTitle>
        <div className="border border-slate-200 bg-slate-50 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12px] text-slate-600">
            <HardDrive className="h-4 w-4 text-slate-400" strokeWidth={1.75} />
            {storage ? (
              <>
                Занято <b className="text-navy">{mb(storage.used)} МБ</b> из доступных ≈{mb(storage.quota)} МБ
              </>
            ) : (
              'Оценка объёма недоступна в этом браузере'
            )}
          </div>
          {storage && storage.quota > 0 && (
            <div className="mt-2 h-1.5 bg-slate-200">
              <div
                className="h-full bg-navy"
                style={{ width: `${Math.min(100, (storage.used / storage.quota) * 100).toFixed(2)}%` }}
              />
            </div>
          )}
        </div>
        {counts && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {counts.map(([label, n]) => (
              <span key={label} className="border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600">
                {label}: <b className="text-navy">{n}</b>
              </span>
            ))}
          </div>
        )}
      </section>
      <section>
        <GroupTitle>Обновление из источников</GroupTitle>
        {autoUpd !== null && (
          <label className="flex items-center gap-2 text-[12.5px] text-slate-600">
            <Switch
              checked={autoUpd}
              onChange={(v) => {
                setAutoUpd(v);
                setAutoUpdate(v);
              }}
            />
            Автообновление при запуске и жестом «потянуть вниз»
          </label>
        )}
        <p className="mt-1.5 text-[11px] text-slate-500">
          {lastSyncAt ? `Последнее обновление: ${lastSyncAt}` : 'Обновление из источников ещё не выполнялось.'}
        </p>
      </section>
      <section>
        <GroupTitle>Резервные копии</GroupTitle>
        <div className="flex flex-wrap gap-2">
          <OutlineBtn onClick={() => exportBackup()}>
            <Download className="h-3.5 w-3.5" /> Скачать резервную копию
          </OutlineBtn>
          <OutlineBtn onClick={() => fileRef.current?.click()}>
            <FileUp className="h-3.5 w-3.5" /> Восстановить из файла
          </OutlineBtn>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) restore(f);
              e.target.value = '';
            }}
          />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Резервная копия содержит все таблицы приложения в одном JSON-файле. Рекомендуется выгружать перед массовыми
          правками и сдачей отчётности.
        </p>
        {err && <div className="mt-2 border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{err}</div>}
      </section>
      <section>
        <button
          onClick={onOpenAdmin}
          className="flex w-full items-center justify-between border border-slate-300 bg-white px-3 py-2.5 text-left text-[12.5px] font-semibold text-navy transition-colors hover:bg-slate-50"
        >
          Открыть панель Admin
          <span className="text-[11px] font-normal text-slate-400">вкладки, ставки, очистка, журнал</span>
        </button>
      </section>
    </div>
  );
}

// ── Вкладка «Справка» ────────────────────────────────────────────────
function HelpTab({ onClose }: { onClose: () => void }) {
  const openGuide = () => {
    onClose();
    window.dispatchEvent(new CustomEvent('komfin:help'));
  };
  return (
    <div className="grid gap-4">
      <button
        onClick={openGuide}
        className="flex items-center gap-3 border border-navy bg-navy px-4 py-3 text-left text-white transition-colors hover:bg-navy-800"
      >
        <CircleQuestionMark className="h-5 w-5 shrink-0" strokeWidth={1.75} />
        <span>
          <span className="block text-[13px] font-semibold">Как работать на сайте</span>
          <span className="block text-[11px] text-white/60">полное руководство по всем разделам</span>
        </span>
      </button>
      <section>
        <GroupTitle>О приложении</GroupTitle>
        <div className="grid gap-1.5 text-[12.5px] leading-relaxed text-slate-600">
          <p>Рабочее место финансового учёта ТИК города Норильска и 63 УИК.</p>
          <p className="text-[12px] text-slate-500">
            {ELECT.title} · голосование 18–20.09.2026.
          </p>
          <p className="text-[12px] text-slate-500">
            Технологии: автономное PWA-приложение, локальная база IndexedDB, работа без интернета, экспорт в Excel и
            отправка по электронной почте.
          </p>
        </div>
      </section>
      <section>
        <GroupTitle>Нормативная база расчётов</GroupTitle>
        <ul className="grid gap-1.5 text-[12px] leading-relaxed text-slate-600">
          <li className="flex gap-2">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            ФЗ-67 (ст. 57, 58); ФЗ-20 «О выборах депутатов Государственной Думы».
          </li>
          <li className="flex gap-2">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            Инструкция ЦИК России № 7/59-7 (ред. от 16.07.2025).
          </li>
          <li className="flex gap-2">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            Постановление ЦИК России № 10/101-9 от 24.06.2026 (ставки и порядок выплат).
          </li>
          <li className="flex gap-2">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            Уставный закон Красноярского края № 11-4807; решение ИК КК 98/1080-8.
          </li>
        </ul>
        <p className="mt-2 border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          Формы носят подготовительный характер: подпись и подача отчётности осуществляются комиссией по регламенту.
        </p>
      </section>
    </div>
  );
}

// ── Модальное окно настроек ──────────────────────────────────────────
function SettingsModal({ onClose, onOpenAdmin }: { onClose: () => void; onOpenAdmin?: () => void }) {
  const [tab, setTab] = useState('appearance');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-navy/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      data-edit-ui
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[94vh] w-full max-w-[820px] flex-col border border-slate-200 bg-white shadow-2xl sm:max-h-[88vh]">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <Settings className="h-4 w-4 shrink-0 text-red" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Приложение</div>
            <div className="truncate text-[14px] font-semibold text-navy">Настройки</div>
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 text-slate-400 hover:text-navy" title="Закрыть (Esc)">
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 max-sm:flex-col">
          <div className="shrink-0 border-slate-200 bg-slate-50 max-sm:overflow-x-auto max-sm:border-b sm:w-[196px] sm:border-r">
            <div className="flex sm:flex-col sm:gap-0.5 sm:p-2">
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    data-settings-tab={t.id}
                    onClick={() => setTab(t.id)}
                    className={cls(
                      'flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors max-sm:shrink-0 max-sm:border-b-2 sm:border-l-2 sm:border-transparent',
                      active
                        ? 'bg-white text-navy max-sm:border-navy sm:border-navy'
                        : 'text-slate-500 hover:bg-white/70 hover:text-navy max-sm:border-transparent',
                    )}
                  >
                    <Icon className={cls('h-4 w-4 shrink-0', active ? 'text-red' : 'text-slate-400')} strokeWidth={1.75} />
                    <span>
                      <span className="block whitespace-nowrap text-[12.5px] font-semibold leading-tight">{t.label}</span>
                      <span className="block whitespace-nowrap text-[10px] text-slate-400 max-sm:hidden">{t.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'data' && <DataTab onOpenAdmin={onOpenAdmin} />}
            {tab === 'help' && <HelpTab onClose={onClose} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Кнопка «Настройки» в шапке (задача 16 — в одну строку с «Как работать на сайте» и Admin) */
export default function SettingsButton({ onOpenAdmin }: { onOpenAdmin?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Настройки приложения"
        className="group flex h-10 items-center justify-center gap-1.5 border border-slate-300 bg-white px-3 text-[12px] font-semibold text-navy transition-colors hover:bg-slate-50 max-lg:flex-1 lg:h-9 lg:w-9 lg:px-0"
      >
        <Settings className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90" strokeWidth={1.75} />
        <span className="lg:hidden">Настройки</span>
      </button>
      {open &&
        createPortal(
          <SettingsModal
            onClose={() => setOpen(false)}
            onOpenAdmin={() => {
              setOpen(false);
              onOpenAdmin?.();
            }}
          />,
          document.body,
        )}
    </>
  );
}
