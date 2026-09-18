import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronRight, Download, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { ensureUiks, fillUikMembers, reseed } from '../lib/seed';
import { getLastSync, getSources, isAutoUpdate, runSync, saveSources, setAutoUpdate, type DataSource, type SyncReport } from '../lib/sync';
import { exportXlsx } from '../lib/excel';
import { DISTRICTS, TIK, UIKS } from '../data/registry';
import { RATES, ROLE_NAME } from '../lib/rules';
import { cls } from '../lib/fmt';
import { Card, CardHead, Num, SectionHead } from '../components/app/kit';
import type { Commission, Role } from '../types';

const LEVEL_SHORT: Record<string, string> = {
  IKK: 'Комиссия субъекта',
  TIK: 'Территориальная',
  UIK: 'Участковая',
};

export default function Directory({
  commissionId,
  onSelectCommission,
}: {
  commissionId: number;
  onSelectCommission: (id: number) => void;
}) {
  const data = useLiveQuery(async () => {
    const commissions = await db.commissions.toArray();
    const members = await db.members.where('commissionId').equals(commissionId).toArray();
    const commission = await db.commissions.get(commissionId);
    return { commissions, members, commission };
  }, [commissionId]);

  const [form, setForm] = useState({ fio: '', role: 'member' as Role, status: 'нештатный' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const rosterRef = useRef<HTMLDivElement>(null);

  const selectAndScroll = (id: number) => {
    onSelectCommission(id);
    window.setTimeout(() => {
      rosterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const [sources, setSources] = useState<DataSource[]>([]);
  const [autoUpdate, setAutoUpd] = useState(true);
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    (async () => {
      setSources(await getSources());
      setAutoUpd(await isAutoUpdate());
      setLastSync(await getLastSync());
    })();
  }, []);

  const toggleAuto = (on: boolean) => {
    setAutoUpd(on);
    setAutoUpdate(on);
  };

  const patchSource = (i: number, patch: Partial<DataSource>) => {
    const next = sources.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setSources(next);
    saveSources(next);
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      setLastSync(await runSync('manual'));
    } finally {
      setSyncing(false);
    }
  };

  if (!data) return <div className="text-slate-500">Загрузка…</div>;

  const ikk = data.commissions.find((c) => c.level === 'IKK');
  const tiks = data.commissions.filter((c) => c.level === 'TIK');
  const uiks = data.commissions.filter((c) => c.level === 'UIK');
  const byDistrict = (d: string) => uiks.filter((c) => c.district === d).sort((a, b) => (a.uikNo ?? 0) - (b.uikNo ?? 0));

  const fillCards = async () => {
    setBusy(true);
    try {
      const r1 = await ensureUiks();
      const r2 = await fillUikMembers();
      setMsg(
        `Готово: карточек добавлено — ${r1.added}, уже были в реестре — ${r1.skipped}; составы заполнены для ${r2.filled} УИК (демонстрационные ФИО, по 9 человек на участок).`,
      );
    } finally {
      setBusy(false);
    }
  };

  const fullReseed = async () => {
    if (
      window.confirm(
        'Полная перезагрузка: все введённые данные (операции, табели, авансы) будут удалены, реестр комиссий МО город Норильск будет создан заново. Продолжить?',
      )
    ) {
      setBusy(true);
      try {
        await reseed();
        setMsg(
          'Реестр перезагружен: ИК Красноярского края → ТИК города Норильска → 63 УИК, составы всех участков заполнены (демонстрационные ФИО).',
        );
      } finally {
        setBusy(false);
      }
    }
  };

  const exportRegistry = () => {
    const rows: (string | number)[][] = [
      ['Реестр комиссий МО город Норильск — выборы 2026'],
      ['Источник: постановление Администрации г. Норильска от 21.12.2012 № 442 (ред. от 13.04.2026 № 111)'],
      [],
      ['№ участка', 'Комиссия', 'Район', 'Помещение для голосования', 'Адрес', 'Телефон'],
    ];
    for (const u of UIKS) rows.push([u.num, `УИК № ${u.num}`, u.district, u.venue, u.address, u.phone]);
    rows.push([], ['Итого участков', UIKS.length]);
    rows.push(['ТИК', TIK.fullName, '', TIK.address, TIK.phone, '']);
    exportXlsx('Реестр_комиссий_Норильск_2026.xlsx', [{ name: 'Реестр УИК', rows, widths: [10, 12, 14, 52, 34, 12] }]);
  };

  const addMember = async () => {
    if (!form.fio.trim()) return;
    await db.members.add({
      commissionId,
      fio: form.fio.trim(),
      role: form.role,
      status: form.status,
      rate: RATES[form.role],
    } as never);
    setForm({ fio: '', role: 'member', status: 'нештатный' });
  };

  const row = (c: Commission, indent = 0) => (
    <div
      key={c.id}
      data-rec={`commissions:${c.id}`}
      onClick={() => selectAndScroll(c.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectAndScroll(c.id);
        }
      }}
      title={`Открыть состав: ${c.code}`}
      className={cls(
        'group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2.5 transition-colors hover:bg-slate-50 sm:gap-x-4 sm:px-4',
        c.id === commissionId && 'bg-sky-50 hover:bg-sky-50',
      )}
      style={{ paddingLeft: 12 + indent * 20 }}
    >
      <span className="w-[96px] text-[12px] font-semibold text-navy sm:w-[130px] sm:text-[13px]">{c.code}</span>
      <span className="w-[90px] text-[11px] text-slate-500 max-sm:hidden">{LEVEL_SHORT[c.level]}</span>
      <span className="min-w-0 flex-1 text-[13px] text-navy sm:min-w-[200px]">
        {c.name}
        {c.venue && (
          <span className="block text-[11px] font-normal text-slate-500">
            {c.venue}
            {c.address ? ` · ${c.address}` : ''}
            {c.phone ? ` · тел. ${c.phone}` : ''}
          </span>
        )}
        {!c.venue && c.address && (
          <span className="block text-[11px] font-normal text-slate-500">
            {c.address}
            {c.phone ? ` · ${c.phone}` : ''}
          </span>
        )}
      </span>
      <span className="num text-[11px] text-slate-500 max-sm:hidden">
        {c.account ? `счёт ${c.account}` : 'подотчёт'}
      </span>
      <span className="text-[11px] text-slate-500 max-sm:hidden">{c.bank ?? ''}</span>
      {c.level !== 'IKK' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            db.commissions.delete(c.id);
          }}
          className="p-1 text-slate-300 hover:text-red"
          title="Удалить"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      )}
      <ChevronRight
        className={cls('h-4 w-4 shrink-0 transition-colors', c.id === commissionId ? 'text-navy' : 'text-slate-300 group-hover:text-navy')}
        strokeWidth={1.75}
      />
    </div>
  );

  return (
    <div>
      <SectionHead label="Модуль М1" title="Справочники: комиссии МО город Норильск" />
      <Card className="mb-6">
        <CardHead>Автозаполнение карточек комиссий</CardHead>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
          <div className="min-w-[280px] flex-1 text-[12px] leading-relaxed text-slate-600">
            Официальный реестр: <b className="text-navy">1 ТИК + {UIKS.length} УИК</b> (Центральный — 38, Талнах — 17,
            Кайеркан — 7, Снежногорск — 1). Источник: постановление Администрации города Норильска от 21.12.2012 № 442
            в редакции от 13.04.2026 № 111. Повторное заполнение не дублирует карточки. Состав каждого УИК — 9 человек
            (председатель, заместитель, секретарь, 6 членов комиссии); ФИО демонстрационные — официальные списки из
            решения ТИК заменяют их при загрузке.
          </div>
          <div className="flex flex-wrap gap-2.5 max-sm:w-full max-sm:flex-col">
            <button
              onClick={fillCards}
              disabled={busy}
              className="flex h-9 items-center gap-1.5 bg-navy px-4 text-[13px] font-medium text-white hover:bg-navy-800 disabled:opacity-40 max-sm:justify-center"
            >
              <Sparkles className="h-4 w-4" strokeWidth={1.75} /> Сформировать карточки (ТИК + {UIKS.length} УИК)
            </button>
            <button
              onClick={exportRegistry}
              className="flex h-9 items-center gap-1.5 border border-slate-300 px-4 text-[13px] font-medium text-navy hover:border-navy max-sm:justify-center"
            >
              <Download className="h-4 w-4" strokeWidth={1.75} /> Реестр в Excel
            </button>
            <button
              onClick={fullReseed}
              disabled={busy}
              className="flex h-9 items-center gap-1.5 border border-red/40 px-4 text-[13px] font-medium text-red hover:bg-red hover:text-white disabled:opacity-40 max-sm:justify-center"
            >
              <RefreshCw className="h-4 w-4" strokeWidth={1.75} /> Полная перезагрузка реестра
            </button>
          </div>
        </div>
        {msg && <div className="border-t border-slate-100 px-4 py-2.5 text-[12px] font-medium text-emerald-700">{msg}</div>}
      </Card>

      <Card className="mb-6">
        <CardHead>Источники данных · автообновление</CardHead>
        <div className="space-y-3 px-4 py-4">
          <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-slate-700">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => toggleAuto(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-navy"
            />
            <span>
              <b className="text-navy">Автообновление включено</b> — работает в фоне: при запуске приложения и жестом
              «потянуть вниз» на любом экране. Работе на сайте не мешает — изменения применяются по мере поступления, о
              поступлении появляется короткое уведомление. Полные пути источников — ниже.
            </span>
          </label>
          {sources.map((s, i) => (
            <div key={s.id} className="flex items-start gap-2.5 border-t border-slate-100 pt-3">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => patchSource(i, { enabled: e.target.checked })}
                className="mt-1 h-4 w-4 accent-navy"
                title="Источник подключён"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-navy">{s.name}</div>
                <input
                  value={s.url}
                  onChange={(e) => patchSource(i, { url: e.target.value })}
                  className="inp mt-1 w-full font-mono text-[11px]"
                  spellCheck={false}
                  title="Полный путь источника"
                />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-3">
            <button
              onClick={syncNow}
              disabled={syncing}
              className="flex h-9 items-center gap-1.5 bg-navy px-4 text-[13px] font-medium text-white hover:bg-navy-800 disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} strokeWidth={1.75} /> Обновить сейчас
            </button>
            <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-500">
              {lastSync ? (
                <>
                  <div>
                    Последняя синхронизация: {new Date(lastSync.at).toLocaleString('ru-RU')} (
                    {lastSync.trigger === 'start' ? 'запуск' : lastSync.trigger === 'gesture' ? 'жест' : 'вручную'})
                  </div>
                  {lastSync.lines.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </>
              ) : (
                'Синхронизация ещё не выполнялась.'
              )}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1fr_460px]">
        <Card>
          <CardHead>
            Иерархия комиссий · {uiks.length} из {UIKS.length} УИК
          </CardHead>
          <div>
            {ikk && row(ikk)}
            {tiks.map((tik) => (
              <div key={tik.id}>
                {row(tik, 1)}
                {DISTRICTS.map((d) => {
                  const list = byDistrict(d);
                  return list.length ? (
                    <div key={d}>
                      <div
                        className="flex items-center gap-2 border-b border-slate-100 bg-paper px-4 py-1.5"
                        style={{ paddingLeft: 28 }}
                      >
                        <Building2 className="h-3.5 w-3.5 text-slate-400" strokeWidth={1.75} />
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          {d} район · {list.length} УИК
                        </span>
                      </div>
                      {list.map((u) => row(u, 2))}
                    </div>
                  ) : null;
                })}
                {uiks.filter((u) => !u.district).map((u) => row(u, 2))}
              </div>
            ))}
          </div>
          <div className="border-t border-slate-200 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
            ТИК — не юридические лица: при открытии счёта ИНН плательщика указывается «0», карточка подписей —
            председатель + бухгалтер (по договору). УИК счетов не открывают — работают подотчётом. Счёт ТИК города
            Норильска — 40202 в РКЦ г. Норильск (решение ИК КК от 11.04.2022 № 98/1080-8).
          </div>
        </Card>

        <div ref={rosterRef} className="space-y-6 scroll-mt-20">
          <Card>
            <CardHead>Состав: {data.commission?.code} · ставки по 10/101-9</CardHead>
            {data.members.some((m) => m.source === 'demo') && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-relaxed text-amber-800">
                Состав сгенерирован для демонстрации (ФИО не официальные). Когда будет решение ТИК с приложениями —
                пришлите файл, заменим списки автоматически.
              </div>
            )}
            <div className="divide-y divide-slate-100">
              {data.members.map((m) => (
                <div key={m.id} data-rec={`members:${m.id}`} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex-1">
                    <div className="text-[13px] font-medium text-navy">{m.fio}</div>
                    <div className="text-[11px] text-slate-500">
                      {ROLE_NAME[m.role]} · {m.status}
                    </div>
                  </div>
                  <Num strong>{m.rate} ₽/ч</Num>
                  <button onClick={() => db.members.delete(m.id)} className="text-slate-300 hover:text-red">
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              ))}
              {data.members.length === 0 && (
                <div className="px-4 py-4 text-[12px] text-slate-400">
                  Состав не заполнен — нажмите на комиссию в иерархии слева или выберите её в переключателе сверху
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2.5 border-t border-slate-200 px-4 py-3">
              <input
                value={form.fio}
                onChange={(e) => setForm({ ...form, fio: e.target.value })}
                placeholder="ФИО"
                className="inp min-w-0 flex-1 max-sm:w-full max-sm:flex-none"
              />
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
                className="inp max-sm:flex-1"
              >
                {Object.keys(RATES).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_NAME[r as Role]} · {RATES[r as Role]} ₽/ч
                  </option>
                ))}
              </select>
              <button
                onClick={addMember}
                disabled={!form.fio}
                className="flex h-9 items-center justify-center gap-1 bg-navy px-3 text-[12px] font-medium text-white hover:bg-navy-800 disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </Card>

          <Card>
            <CardHead>Карточка ТИК города Норильска</CardHead>
            <div className="space-y-1.5 px-4 py-4 text-[12px] leading-relaxed text-slate-600">
              <div>
                <b className="text-navy">{TIK.fullName}</b>
              </div>
              <div>
                {TIK.address} · {TIK.phone}
              </div>
              <div>Председатель — {TIK.chair}</div>
              <div>Заместитель — {TIK.deputy}</div>
              <div>Секретарь — {TIK.secretary}</div>
              <div className="pt-1 text-[11px] text-slate-500">
                Состав 2025–2030: решение Избирательной комиссии Красноярского края от 14.05.2025 № 41/427-8.
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
