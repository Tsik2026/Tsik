// Панель администратора: файлы, сметы, документы, табели, шаблоны,
// вкладки и страницы, ставки и данные, экспорт, журнал действий.
// Задача 17: карточка «Помощь» — AI-ассистент (компонент Chat).
// Задача 18: облачной синхронизации нет — всё хранится локально.
// Задача 19: отправка — только через штатную почтовую программу / «Поделиться».
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Database,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  HardDriveDownload,
  HardDriveUpload,
  LayoutTemplate,
  LoaderCircle,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  ScrollText,
  Settings2,
  Share2,
  Shield,
  Trash2,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import { db } from '../lib/db';
import { cn } from '../lib/utils';
import { Card, CardHead, SectionHead } from '../components/app/kit';
import { DISTRICTS } from '../data/registry';
import { BUDGET_NAME, LINE_CODES, LINE_NAME, ROLE_NAME } from '../lib/rules';
import { loadNav, moveNav, patchNavItem, SECTIONS } from '../lib/nav';
import {
  addPage,
  clearAdminLog,
  clearDataSection,
  DATA_SECTION_NAME,
  logAdmin,
  movePage,
  readAdminLog,
  removePage,
  updatePage,
} from '../lib/adminlog';
import { applyRates, getRegionK, loadRates, setRegionK } from '../lib/settings';
import { startEdit, stopEdit, useEditState } from '../lib/editmode';
import { downloadBlob, exportBackup, importBackup } from '../lib/backup';
import { exportXlsx } from '../lib/excel';
import {
  applyFile,
  archiveFile,
  buildExport,
  EXPORT_FORMAT,
  EXPORT_SCOPE,
  KIND_NAME,
  parseFile,
  type ExportFormat,
  type ExportScope,
  type FileKind,
  type ParsedFile,
} from '../lib/files';
import { canShareFiles, downloadBuiltFile, openMailto, shareBuiltFile } from '../lib/mail';
import TimesheetEditor from '../components/admin/TimesheetEditor';
import Chat from '../components/admin/Chat';
import AuditCard, { AutoAuditBanner } from '../components/admin/Audit';
import type { Budget, Commission, Role } from '../types';

// ── Атомы ────────────────────────────────────────────────────────────
function AdminBtn({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const tone =
    kind === 'primary'
      ? 'border-navy bg-navy text-white hover:bg-navy/90'
      : kind === 'danger'
        ? 'border-red-300 bg-white text-red hover:bg-red-50'
        : 'border-slate-300 bg-white text-navy hover:bg-slate-50';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex items-center justify-center gap-1.5 border px-3 py-2 text-[12px] font-medium transition-colors disabled:opacity-50',
        tone,
        className,
      )}
    >
      {children}
    </button>
  );
}

const KIND_TONE: Record<string, string> = {
  rosters: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  registry: 'border-sky-300 bg-sky-50 text-sky-700',
  estimate: 'border-violet-300 bg-violet-50 text-violet-700',
  timesheet: 'border-amber-300 bg-amber-50 text-amber-700',
  document: 'border-slate-300 bg-slate-200/60 text-slate-600',
};

function KindBadge({ kind }: { kind: string }) {
  const k = kind in KIND_TONE ? (kind as FileKind) : 'document';
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        KIND_TONE[k],
      )}
    >
      {KIND_NAME[k]}
    </span>
  );
}

const fmtSize = (n?: number) =>
  (n ?? 0) >= 1048576 ? `${((n ?? 0) / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round((n ?? 0) / 1024))} КБ`;

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const ROLE_ORDER: Role[] = ['chair', 'deputy', 'secretary', 'member'];

const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));

interface QueueItem {
  file: File;
  rec: ParsedFile;
  overrideUik: number | null;
  status: 'idle' | 'busy' | 'ok' | 'err';
  message?: string;
}

// ── Панель ───────────────────────────────────────────────────────────
export default function Admin({
  commissionId,
  budget,
  commissions,
}: {
  commissionId: number;
  budget: Budget;
  commissions: Commission[];
}) {
  const [statusMsg, setStatusMsg] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const tick = () => setRefreshTick((x) => x + 1);

  const uiks = commissions.filter((c) => c.level === 'UIK').sort((a, b) => (a.uikNo ?? 0) - (b.uikNo ?? 0));
  const current = commissions.find((c) => c.id === commissionId);

  const documents = useLiveQuery(() => db.documents.orderBy('addedAt').reverse().toArray(), []);
  const templates = useLiveQuery(() => db.templates.orderBy('addedAt').reverse().toArray(), []);
  const pages = useLiveQuery(() => db.pages.orderBy('order').toArray(), []);
  const nav = useLiveQuery(() => loadNav(), []);
  const adminLog = useLiveQuery(() => readAdminLog(), [refreshTick]);
  const estimateRows = useLiveQuery(
    () => db.estimate.where('[commissionId+budget]').equals([commissionId, budget]).toArray(),
    [commissionId, budget],
  );

  // ── Экспорт и отправка (задача 19: скачивание / Поделиться / mailto) ──
  const [scope, setScope] = useState<ExportScope>('full');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [email, setEmail] = useState('');
  const [exportBusy, setExportBusy] = useState(false);

  const exportSubject = () => {
    const d = new Date().toLocaleDateString('ru-RU');
    return `Комиссия.Финансы — ${EXPORT_SCOPE[scope]} (${d})`;
  };

  const withExport = async (send: (f: Awaited<ReturnType<typeof buildExport>>) => Promise<void> | void, logNote: string) => {
    setExportBusy(true);
    try {
      const built = await buildExport(scope, format);
      await send(built);
      await logAdmin(`Экспорт «${EXPORT_SCOPE[scope]}» (${EXPORT_FORMAT[format]}, записей: ${built.rowsCount}) — ${logNote}`);
      tick();
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        setStatusMsg(`Ошибка экспорта: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setExportBusy(false);
    }
  };

  const doDownload = () => withExport((f) => downloadBuiltFile(f), 'файл скачан');
  const doShare = () =>
    withExport((f) => shareBuiltFile(f, email, exportSubject()), `передан в почтовое приложение${email ? ` для ${email}` : ''}`);
  const doMailto = () =>
    withExport((f) => {
      downloadBuiltFile(f);
      openMailto(
        email,
        exportSubject(),
        `Направляю данные: ${EXPORT_SCOPE[scope]} (${EXPORT_FORMAT[format]}).\n\nФайл «${f.filename}» уже скачан — прикрепите его к этому письму.\n\nПервые строки:\n${f.textPreview}`,
      );
    }, 'письмо открыто, файл скачан для вложения');

  // ── Очередь файлов ─────────────────────────────────────────────────
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const patchQueue = (idx: number, patch: Partial<QueueItem>) => {
    setQueue((q) => q.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  };

  const enqueue = async (files: File[]) => {
    if (!files.length) return;
    setParsing(true);
    try {
      for (const file of files) {
        const rec = await parseFile(file);
        setQueue((q) => [
          ...q,
          {
            file,
            rec,
            overrideUik: rec.kind === 'timesheet' ? (rec.timesheetUik ?? null) : null,
            status: 'idle',
          },
        ]);
      }
    } finally {
      setParsing(false);
    }
  };

  const placeFile = async (idx: number) => {
    const item = queue[idx];
    if (!item) return;
    patchQueue(idx, { status: 'busy', message: undefined });
    try {
      const note = await applyFile(item.rec, { commissionId, budget, overrideUik: item.overrideUik });
      await archiveFile(item.file, item.rec.kind, note);
      patchQueue(idx, { status: 'ok', message: `${note} Исходный файл — в библиотеке.` });
      tick();
    } catch (e) {
      patchQueue(idx, { status: 'err', message: e instanceof Error ? e.message : 'Ошибка размещения' });
    }
  };

  const toLibrary = async (idx: number) => {
    const item = queue[idx];
    if (!item) return;
    patchQueue(idx, { status: 'busy', message: undefined });
    await archiveFile(item.file, item.rec.kind);
    patchQueue(idx, { status: 'ok', message: 'Файл сохранён в библиотеку документов.' });
    tick();
  };

  const canPlace = (item: QueueItem) =>
    item.status === 'idle' &&
    item.rec.kind !== 'document' &&
    !(item.rec.kind === 'rosters' && !!item.rec.unassigned?.length && !item.overrideUik) &&
    !(item.rec.kind === 'timesheet' && !item.overrideUik && !item.rec.timesheetUik);

  const placeAll = async () => {
    for (let i = 0; i < queue.length; i += 1) {
      if (canPlace(queue[i])) await placeFile(i);
    }
  };

  const pendingCount = queue.filter(canPlace).length;

  // ── Сметы ──────────────────────────────────────────────────────────
  const estimateInputRef = useRef<HTMLInputElement>(null);
  const [estimateBusy, setEstimateBusy] = useState(false);

  const estimateTemplate = () => {
    const byCode = new Map((estimateRows ?? []).map((e) => [e.lineCode, e]));
    exportXlsx(`Шаблон_сметы_${current?.code?.replace(/\s+/g, '_') ?? 'комиссия'}_${budget}.xlsx`, [
      {
        name: 'Смета',
        rows: [
          [`Смета расходов — ${current?.code ?? 'комиссия'} · ${BUDGET_NAME[budget]}`],
          [],
          ['Код', 'Статья расходов', 'Лимит, ₽', 'Решение комиссии'],
          ...LINE_CODES.map((code) => [code, LINE_NAME[code], byCode.get(code)?.limit ?? 0, byCode.get(code)?.decision ?? '']),
        ],
        widths: [10, 52, 14, 44],
      },
    ]);
  };

  const uploadEstimate = async (file: File) => {
    setEstimateBusy(true);
    setStatusMsg('');
    try {
      const rec = await parseFile(file);
      if (rec.kind !== 'estimate' || !rec.estimate?.length) {
        setStatusMsg(
          `Файл «${file.name}» не распознан как смета (нужны колонки «Статья/Код» и «Лимит/Сумма»). Разместите его через карточку «Файлы» — он будет определён автоматически.`,
        );
        return;
      }
      const note = await applyFile(rec, { commissionId, budget });
      await archiveFile(file, 'estimate', note);
      setStatusMsg(note);
      tick();
    } finally {
      setEstimateBusy(false);
    }
  };

  // ── Табели ─────────────────────────────────────────────────────────
  const timesheetInputRef = useRef<HTMLInputElement>(null);
  const [selectedUikId, setSelectedUikId] = useState<number | null>(null);
  const [timesheetBusy, setTimesheetBusy] = useState(false);
  const timesheetUikId = selectedUikId ?? (current?.level === 'UIK' ? current.id : (uiks[0]?.id ?? null));
  const timesheetUik = commissions.find((c) => c.id === timesheetUikId) ?? null;

  const uploadTimesheet = async (file: File) => {
    if (!timesheetUik?.uikNo) {
      setStatusMsg('Выберите УИК для размещения табеля.');
      return;
    }
    setTimesheetBusy(true);
    setStatusMsg('');
    try {
      const rec = await parseFile(file);
      if (rec.kind !== 'timesheet' || !rec.timesheet?.length) {
        setStatusMsg(
          `Файл «${file.name}» не распознан как табель. Подходят две формы: матрица (ФИО × даты, в ячейках — часы) и построчная (ФИО | Дата | Дневные | Ночные | Выходные). Файл можно разместить через карточку «Файлы» — тип определится автоматически.`,
        );
        return;
      }
      const note = await applyFile(rec, { commissionId, budget, overrideUik: timesheetUik.uikNo });
      await archiveFile(file, 'timesheet', note);
      setStatusMsg(note);
      tick();
    } finally {
      setTimesheetBusy(false);
    }
  };

  const timesheetTemplate = async () => {
    if (!timesheetUik) return;
    const members = await db.members.where('commissionId').equals(timesheetUik.id).toArray();
    members.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    const dates = ['17.09.2026', '18.09.2026', '19.09.2026', '20.09.2026', '21.09.2026'];
    const rows: unknown[][] = [
      [`Табель учёта фактически отработанного времени — ${timesheetUik.name}`],
      ['Даты в шапке — образец, замените на фактические. Часы — числом; пустая ячейка = 0.'],
      [],
      ['ФИО', 'Должность', ...dates],
    ];
    if (members.length) {
      for (const m of members) rows.push([m.fio, ROLE_NAME[m.role], ...dates.map(() => '')]);
    } else {
      rows.push(
        ['', 'Председатель', ...dates.map(() => '')],
        ['', 'Зам. председателя', ...dates.map(() => '')],
        ['', 'Секретарь', ...dates.map(() => '')],
      );
    }
    exportXlsx(`Шаблон_табеля_УИК_№_${timesheetUik.uikNo ?? ''}.xlsx`, [
      { name: `УИК ${timesheetUik.uikNo ?? ''}`, rows, widths: [30, 20, ...dates.map(() => 12)] },
    ]);
  };

  const exportTimesheet = async () => {
    if (!timesheetUik) return;
    const members = await db.members.where('commissionId').equals(timesheetUik.id).toArray();
    const memberById = new Map(members.map((m) => [m.id, m]));
    const entries = (await db.timesheet.where('memberId').anyOf(members.map((m) => m.id)).toArray()).sort((a, b) =>
      a.date < b.date ? -1 : 1,
    );
    if (!entries.length) {
      setStatusMsg(`Табель ${timesheetUik.code} пуст — выгружать нечего.`);
      return;
    }
    const rows: unknown[][] = [
      [`Табель учёта фактически отработанного времени — ${timesheetUik.name}`],
      [],
      ['ФИО', 'Должность', 'Дата', 'Дневные часы', 'Ночные часы', 'Часы в выходные'],
      ...entries.map((e) => {
        const m = memberById.get(e.memberId);
        return [m?.fio ?? `#${e.memberId}`, m ? ROLE_NAME[m.role] : '', e.date.split('-').reverse().join('.'), e.dayH, e.nightH, e.weekendH];
      }),
    ];
    exportXlsx(`Табель_УИК_№_${timesheetUik.uikNo ?? ''}.xlsx`, [
      { name: `УИК ${timesheetUik.uikNo ?? ''}`, rows, widths: [30, 20, 12, 14, 13, 15] },
    ]);
    setStatusMsg(`Табель ${timesheetUik.code} выгружен в Excel (записей: ${entries.length}). Файл пригоден для обратной загрузки.`);
  };

  const clearTimesheet = async () => {
    if (!timesheetUik) return;
    const members = await db.members.where('commissionId').equals(timesheetUik.id).toArray();
    const entries = await db.timesheet.where('memberId').anyOf(members.map((m) => m.id)).toArray();
    if (!entries.length) {
      setStatusMsg(`Табель ${timesheetUik.code} уже пуст.`);
      return;
    }
    if (!window.confirm(`Удалить все записи табеля ${timesheetUik.code} (${entries.length} шт.)? Действие необратимо.`)) return;
    await db.timesheet.bulkDelete(entries.map((e) => e.id));
    await logAdmin(`Табель ${timesheetUik.code}: очищен (записей удалено: ${entries.length})`);
    setStatusMsg(`Табель ${timesheetUik.code} очищен: удалено записей — ${entries.length}.`);
    tick();
  };

  // ── Документы ──────────────────────────────────────────────────────
  const docsInputRef = useRef<HTMLInputElement>(null);
  const addDocuments = async (files: File[]) => {
    for (const file of files) {
      const rec = await parseFile(file);
      await archiveFile(file, rec.kind);
    }
    tick();
  };

  // ── Шаблоны ────────────────────────────────────────────────────────
  const [tplKind, setTplKind] = useState<'roster' | 'estimate' | 'registry'>('roster');
  const [tplScope, setTplScope] = useState<'all' | 'district' | 'uik'>('all');
  const [tplDistrict, setTplDistrict] = useState<string>(DISTRICTS[0]);
  const [tplUikId, setTplUikId] = useState<number>(0);
  const [tplWithData, setTplWithData] = useState(true);
  const [tplBudget, setTplBudget] = useState<Budget>('krai');
  const [tplBusy, setTplBusy] = useState(false);
  const tplInputRef = useRef<HTMLInputElement>(null);

  const blankTemplate = (kind: 'roster' | 'estimate' | 'registry') => {
    if (kind === 'roster') {
      exportXlsx('Шаблон_состава_комиссии.xlsx', [
        {
          name: 'Состав',
          rows: [
            ['Состав участковой избирательной комиссии'],
            [],
            ['№ УИК', 'ФИО', 'Роль (председатель / заместитель / секретарь / член комиссии)'],
          ],
          widths: [10, 34, 52],
        },
      ]);
    } else if (kind === 'estimate') {
      exportXlsx('Шаблон_сметы_пустой.xlsx', [
        {
          name: 'Смета',
          rows: [
            ['Смета расходов комиссии'],
            [],
            ['Код', 'Статья расходов', 'Лимит, ₽', 'Решение комиссии'],
            ...LINE_CODES.map((code) => [code, LINE_NAME[code], 0, '']),
          ],
          widths: [10, 52, 14, 44],
        },
      ]);
    } else {
      exportXlsx('Шаблон_реестра_комиссий.xlsx', [
        {
          name: 'Реестр',
          rows: [['Реестр комиссий'], [], ['№ участка', 'Район', 'Помещение для голосования', 'Адрес', 'Телефон']],
          widths: [10, 14, 52, 34, 14],
        },
      ]);
    }
  };

  const tplCommissions = () =>
    tplScope === 'district' ? uiks.filter((c) => c.district === tplDistrict) : tplScope === 'uik' ? uiks.filter((c) => c.id === tplUikId) : uiks;

  const generateTemplates = async () => {
    const list = tplCommissions();
    if (!list.length) {
      setStatusMsg('По выбранным критериям комиссии не найдены.');
      return;
    }
    setTplBusy(true);
    try {
      const suffix = tplScope === 'all' ? 'все_УИК' : tplScope === 'district' ? tplDistrict : `УИК_${list[0]?.uikNo ?? ''}`;
      if (tplKind === 'roster') {
        const sheets = [];
        for (const c of list) {
          const rows: unknown[][] = [[`УИК № ${c.uikNo} — состав комиссии`], [], ['ФИО', 'Роль', 'Ставка, ₽/ч']];
          if (tplWithData) {
            const members = await db.members.where('commissionId').equals(c.id).toArray();
            members.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
            for (const m of members) rows.push([m.fio, ROLE_NAME[m.role], m.rate]);
          } else {
            rows.push(['', 'Председатель', 63], ['', 'Зам. председателя', 57], ['', 'Секретарь', 57]);
            for (let i = 0; i < 6; i += 1) rows.push(['', 'Член комиссии', 45]);
          }
          sheets.push({ name: `УИК ${c.uikNo}`, rows, widths: [34, 20, 12] });
        }
        exportXlsx(`Составы_${suffix}.xlsx`, sheets);
      } else if (tplKind === 'estimate') {
        const sheets = [];
        for (const c of list) {
          const lines = tplWithData
            ? await db.estimate.where('[commissionId+budget]').equals([c.id, tplBudget]).toArray()
            : [];
          const byCode = new Map(lines.map((e) => [e.lineCode, e]));
          sheets.push({
            name: `УИК ${c.uikNo}`,
            rows: [
              [`УИК № ${c.uikNo} — смета расходов · ${BUDGET_NAME[tplBudget]}`],
              [],
              ['Код', 'Статья расходов', 'Лимит, ₽', 'Решение комиссии'],
              ...LINE_CODES.map((code) => [code, LINE_NAME[code], byCode.get(code)?.limit ?? 0, byCode.get(code)?.decision ?? '']),
            ],
            widths: [10, 52, 14, 44],
          });
        }
        exportXlsx(`Сметы_${suffix}_${tplBudget}.xlsx`, sheets);
      } else {
        exportXlsx(`Реестр_${suffix}.xlsx`, [
          {
            name: 'Реестр',
            rows: [
              ['Реестр комиссий'],
              [],
              ['№ участка', 'Район', 'Помещение для голосования', 'Адрес', 'Телефон'],
              ...list.map((c) => [c.uikNo ?? '', c.district ?? '', c.venue ?? '', c.address ?? '', c.phone ?? '']),
            ],
            widths: [10, 14, 52, 34, 14],
          },
        ]);
      }
      setStatusMsg(`Шаблон сформирован: комиссий — ${list.length}. Файл скачан.`);
    } finally {
      setTplBusy(false);
    }
  };

  const uploadTemplates = async (files: File[]) => {
    for (const file of files) {
      const rec = await parseFile(file);
      const kind =
        rec.kind === 'estimate' ? 'estimate' : rec.kind === 'rosters' ? 'roster' : rec.kind === 'registry' ? 'registry' : 'generic';
      await db.templates.add({
        name: file.name,
        kind,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        addedAt: new Date().toISOString(),
        blob: file,
      } as never);
    }
    setStatusMsg('Шаблоны сохранены.');
  };

  // ── Вкладки и страницы ─────────────────────────────────────────────
  const [newPageTitle, setNewPageTitle] = useState('');
  const [editingPageId, setEditingPageId] = useState<number | null>(null);
  const [pageDraft, setPageDraft] = useState({ title: '', body: '' });

  const createPage = async () => {
    if (!newPageTitle.trim()) return;
    await addPage(newPageTitle);
    setNewPageTitle('');
    tick();
  };

  // ── Ставки и данные ────────────────────────────────────────────────
  const [rates, setRates] = useState<Record<Role, number> | null>(null);
  const [applyToExisting, setApplyToExisting] = useState(true);
  const [regionK, setRegionKState] = useState<number | null>(null);

  useEffect(() => {
    loadRates().then(setRates);
    getRegionK().then(setRegionKState);
  }, []);

  const saveRates = async () => {
    if (!rates) return;
    if (regionK != null && regionK > 0) await setRegionK(regionK);
    const updated = await applyRates(rates, applyToExisting);
    setStatusMsg(
      applyToExisting
        ? `Ставки сохранены и применены: обновлено записей членов комиссий — ${updated}.`
        : 'Ставки сохранены (применятся к новым записям).',
    );
    tick();
  };

  const clearSection = async (table: keyof typeof DATA_SECTION_NAME) => {
    if (!window.confirm(`Очистить раздел «${DATA_SECTION_NAME[table]}»? Действие необратимо.`)) return;
    await clearDataSection(table);
    setStatusMsg(`Раздел очищен: ${DATA_SECTION_NAME[table]}.`);
    tick();
  };

  const backupInputRef = useRef<HTMLInputElement>(null);
  const restoreBackup = async (file: File) => {
    if (!window.confirm('Восстановление заменит ВСЕ текущие данные содержимым резервной копии. Продолжить?')) return;
    try {
      const msg = await importBackup(file);
      window.alert(msg);
      window.location.reload();
    } catch (e) {
      setStatusMsg(`Восстановление не выполнено: ${e instanceof Error ? e.message : 'ошибка файла'}`);
    }
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <SectionHead
        label="Администрирование"
        title="Управление приложением"
        right={
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
            <span className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-navy" strokeWidth={1.75} />
              Полный доступ: файлы, сметы, табели, документы, шаблоны, вкладки, e-mail
            </span>
            <EditModeSwitch />
          </div>
        }
      />
      {statusMsg && (
        <div className="mb-4 flex items-start justify-between gap-3 border border-navy/25 bg-navy/[0.04] px-4 py-2.5 text-[13px] text-navy">
          <span>{statusMsg}</span>
          <button onClick={() => setStatusMsg('')} className="shrink-0 p-0.5 text-slate-400 hover:text-navy" title="Скрыть">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <AutoAuditBanner />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
        <Chat />

        <AuditCard />

        {/* ── Файлы ── */}
        <Card className="lg:col-span-2">
          <CardHead className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Upload className="h-3.5 w-3.5" /> Файлы · автораспознавание и авторазмещение
            </span>
            {pendingCount > 1 && (
              <AdminBtn kind="primary" onClick={placeAll} className="normal-case tracking-normal">
                Разместить все ({pendingCount})
              </AdminBtn>
            )}
          </CardHead>
          <div className="p-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept=".xlsx,.xls,.csv,.txt,.tsv,.json,.pdf,.doc,.docx,.png,.jpg,.jpeg"
              onChange={(e) => {
                enqueue(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                enqueue(Array.from(e.dataTransfer.files ?? []));
              }}
              className="grid cursor-pointer place-items-center gap-1.5 border-2 border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center transition-colors hover:border-navy/50 hover:bg-slate-50"
            >
              {parsing ? (
                <LoaderCircle className="h-6 w-6 animate-spin text-navy" strokeWidth={1.75} />
              ) : (
                <Upload className="h-6 w-6 text-slate-400" strokeWidth={1.5} />
              )}
              <div className="text-[13px] font-medium text-navy">Перетащите файлы сюда или нажмите для выбора</div>
              <div className="max-w-[560px] text-[11px] leading-relaxed text-slate-500">
                XLSX, CSV, TXT, JSON — система сама определит: <b>списки членов УИК</b> (например, с сайта Администрации города
                Норильска) разместятся в составы комиссий, <b>реестр участков</b> — в карточки комиссий, <b>смета</b> — в смету
                выбранной комиссии, <b>табель</b> — в учёт рабочего времени выбранного УИК. Остальные файлы сохраняются в
                библиотеку документов.
              </div>
            </div>
            {queue.length > 0 && (
              <div className="mt-3 divide-y divide-slate-100 border border-slate-200">
                {queue.map((item, idx) => (
                  <div key={`${item.file.name}-${idx}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                    <FileText className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-navy">{item.file.name}</span>
                        <KindBadge kind={item.rec.kind} />
                        <span className="text-[11px] text-slate-400">{fmtSize(item.file.size)}</span>
                      </div>
                      <div className="mt-0.5 text-[12px] text-slate-600">{item.rec.summary}</div>
                      {item.rec.warnings.map((w, wi) => (
                        <div key={wi} className="mt-0.5 text-[11px] text-amber-700">
                          {w}
                        </div>
                      ))}
                      {item.status === 'ok' && <div className="mt-1 text-[12px] font-medium text-emerald-700">{item.message}</div>}
                      {item.status === 'err' && <div className="mt-1 text-[12px] font-medium text-red">{item.message}</div>}
                    </div>
                    {item.rec.kind === 'rosters' && !!item.rec.unassigned?.length && item.status !== 'ok' && (
                      <select
                        value={item.overrideUik ?? ''}
                        onChange={(e) => patchQueue(idx, { overrideUik: e.target.value ? Number(e.target.value) : null })}
                        className="inp max-w-[180px] text-[12px]"
                        title="Участок для строк без номера УИК"
                      >
                        <option value="">Участок для строк без №…</option>
                        {uiks.map((c) => (
                          <option key={c.id} value={c.uikNo}>
                            УИК № {c.uikNo}
                          </option>
                        ))}
                      </select>
                    )}
                    {item.rec.kind === 'timesheet' && item.status !== 'ok' && (
                      <select
                        value={item.overrideUik ?? ''}
                        onChange={(e) => patchQueue(idx, { overrideUik: e.target.value ? Number(e.target.value) : null })}
                        className="inp max-w-[180px] text-[12px]"
                        title="УИК, чей табель загружается"
                      >
                        <option value="">УИК для табеля…</option>
                        {uiks.map((c) => (
                          <option key={c.id} value={c.uikNo}>
                            УИК № {c.uikNo}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.status !== 'ok' && item.rec.kind !== 'document' && (
                        <AdminBtn
                          kind="primary"
                          disabled={
                            item.status === 'busy' ||
                            (item.rec.kind === 'rosters' && !!item.rec.unassigned?.length && !item.overrideUik) ||
                            (item.rec.kind === 'timesheet' && !item.overrideUik && !item.rec.timesheetUik)
                          }
                          onClick={() => placeFile(idx)}
                        >
                          {item.status === 'busy' ? (
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          Разместить
                        </AdminBtn>
                      )}
                      {item.status !== 'ok' && (
                        <AdminBtn
                          disabled={item.status === 'busy'}
                          onClick={() => toLibrary(idx)}
                          title="Сохранить в библиотеку без размещения"
                        >
                          <FolderOpen className="h-3.5 w-3.5" /> В библиотеку
                        </AdminBtn>
                      )}
                      <button
                        onClick={() => setQueue((q) => q.filter((_, i) => i !== idx))}
                        className="p-1.5 text-slate-300 hover:text-red"
                        title="Убрать из очереди"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* ── Сметы ── */}
        <Card>
          <CardHead className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5" /> Сметы · загрузка и шаблон
          </CardHead>
          <div className="space-y-3 p-4">
            <div className="border border-slate-200 bg-slate-50/70 px-3 py-2 text-[12px] text-slate-600">
              Цель размещения: <b className="text-navy">{current?.code ?? '—'}</b> · {BUDGET_NAME[budget]}
              <span className="block text-[11px] text-slate-500">Комиссия и бюджет переключаются в шапке приложения.</span>
            </div>
            <input
              ref={estimateInputRef}
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv,.txt,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadEstimate(f);
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap gap-2">
              <AdminBtn kind="primary" disabled={estimateBusy} onClick={() => estimateInputRef.current?.click()}>
                {estimateBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Загрузить смету из файла
              </AdminBtn>
              <AdminBtn onClick={estimateTemplate}>
                <Download className="h-3.5 w-3.5" /> Шаблон сметы (с текущими лимитами)
              </AdminBtn>
            </div>
            <div className="text-[11px] leading-relaxed text-slate-500">
              Колонки файла: «Статья расходов» (или код PAY, GPD, INF…) и «Лимит, ₽»; необязательная — «Решение комиссии».
              Статьи сопоставляются автоматически, существующие строки обновляются, новые добавляются.
            </div>
          </div>
        </Card>

        {/* ── Документы ── */}
        <Card>
          <CardHead className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <FolderOpen className="h-3.5 w-3.5" /> Документы · библиотека
            </span>
            <AdminBtn onClick={() => docsInputRef.current?.click()} className="normal-case tracking-normal">
              <Plus className="h-3.5 w-3.5" /> Добавить
            </AdminBtn>
          </CardHead>
          <input
            ref={docsInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addDocuments(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <div className="max-h-[320px] overflow-y-auto">
            {!documents?.length && (
              <div className="px-4 py-6 text-center text-[12px] text-slate-500">
                Библиотека пуста. Загруженные файлы (решения, постановления, реестры) хранятся локально и доступны офлайн.
              </div>
            )}
            {documents?.map((d) => (
              <div
                key={d.id}
                data-rec={`documents:${d.id}`}
                className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0"
              >
                <FileText className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-navy">{d.name}</span>
                    <KindBadge kind={d.kind} />
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {fmtSize(d.size)} · {fmtDateTime(d.addedAt)}
                    {d.note ? ` · ${d.note}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => d.blob && downloadBlob(d.blob, d.name)}
                  className="p-1.5 text-slate-400 hover:text-navy"
                  title="Скачать"
                >
                  <Download className="h-4 w-4" strokeWidth={1.75} />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Удалить документ «${d.name}»?`)) db.documents.delete(d.id);
                  }}
                  className="p-1.5 text-slate-300 hover:text-red"
                  title="Удалить"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Табели ── */}
        <Card className="lg:col-span-2">
          <CardHead className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5" /> Табели учёта времени · загрузка и полный контроль
          </CardHead>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <label>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">УИК</span>
                <select
                  value={timesheetUikId ?? ''}
                  onChange={(e) => setSelectedUikId(Number(e.target.value))}
                  className="inp h-9 min-w-[190px]"
                >
                  {uiks.map((c) => (
                    <option key={c.id} value={c.id}>
                      УИК № {c.uikNo} · {c.district}
                    </option>
                  ))}
                </select>
              </label>
              <input
                ref={timesheetInputRef}
                type="file"
                className="hidden"
                accept=".xlsx,.xls,.csv,.txt,.tsv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadTimesheet(f);
                  e.target.value = '';
                }}
              />
              <AdminBtn kind="primary" disabled={timesheetBusy} onClick={() => timesheetInputRef.current?.click()}>
                {timesheetBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Загрузить табель
              </AdminBtn>
              <AdminBtn onClick={timesheetTemplate}>
                <Download className="h-3.5 w-3.5" /> Шаблон табеля
              </AdminBtn>
              <AdminBtn onClick={exportTimesheet}>
                <FileText className="h-3.5 w-3.5" /> Выгрузить XLSX
              </AdminBtn>
              <AdminBtn kind="danger" onClick={clearTimesheet}>
                <Trash2 className="h-3.5 w-3.5" /> Очистить табель
              </AdminBtn>
            </div>
            <div className="text-[11px] leading-relaxed text-slate-500">
              Принимаются любые формы: <b>матрица</b> (ФИО × столбцы-даты, в ячейках — часы; «17.09», «17.09.2026», в т.ч. с
              пометками «ночь»/«вых») и <b>построчная</b> (ФИО | Дата | Дневные | Ночные | Выходные). Люди из файла, которых
              нет в составе, добавляются автоматически; повторная загрузка обновляет часы, а не дублирует. Сетка ниже — прямое
              редактирование: часы, добавление и удаление дат.
            </div>
            <TimesheetEditor commissionId={timesheetUikId} code={timesheetUik?.code ?? 'УИК'} />
          </div>
        </Card>

        {/* ── Шаблоны ── */}
        <Card className="lg:col-span-2">
          <CardHead className="flex items-center gap-2">
            <LayoutTemplate className="h-3.5 w-3.5" /> Шаблоны · скачивание и автозаполнение по критериям
          </CardHead>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
            <div className="space-y-3">
              <div className="text-[12px] font-semibold text-navy">Пустые формы (для ручного заполнения)</div>
              <div className="flex flex-wrap gap-2">
                <AdminBtn onClick={() => blankTemplate('roster')}>
                  <Download className="h-3.5 w-3.5" /> Состав комиссии
                </AdminBtn>
                <AdminBtn onClick={() => blankTemplate('estimate')}>
                  <Download className="h-3.5 w-3.5" /> Смета
                </AdminBtn>
                <AdminBtn onClick={() => blankTemplate('registry')}>
                  <Download className="h-3.5 w-3.5" /> Реестр
                </AdminBtn>
              </div>
              <div className="pt-2 text-[12px] font-semibold text-navy">Загруженные шаблоны</div>
              <input
                ref={tplInputRef}
                type="file"
                multiple
                className="hidden"
                accept=".xlsx,.xls,.csv,.txt,.json,.doc,.docx,.pdf"
                onChange={(e) => {
                  uploadTemplates(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <AdminBtn onClick={() => tplInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" /> Загрузить свой шаблон
              </AdminBtn>
              <div className="divide-y divide-slate-100 border border-slate-200 empty:hidden">
                {templates?.map((t) => (
                  <div key={t.id} data-rec={`templates:${t.id}`} className="flex items-center gap-3 px-3 py-2">
                    <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-navy">{t.name}</div>
                      <div className="text-[10px] text-slate-500">
                        {t.kind} · {fmtSize(t.size)} · {fmtDateTime(t.addedAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => t.blob && downloadBlob(t.blob, t.name)}
                      className="p-1 text-slate-400 hover:text-navy"
                      title="Скачать"
                    >
                      <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Удалить шаблон «${t.name}»?`)) db.templates.delete(t.id);
                      }}
                      className="p-1 text-slate-300 hover:text-red"
                      title="Удалить"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2.5 border-t border-slate-200 pt-3 lg:border-0 lg:pt-0">
              <div className="text-[12px] font-semibold text-navy">Автозаполнение по критериям</div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={tplKind}
                  onChange={(e) => setTplKind(e.target.value as typeof tplKind)}
                  className="inp"
                  title="Тип шаблона"
                >
                  <option value="roster">Составы комиссий</option>
                  <option value="estimate">Сметы</option>
                  <option value="registry">Реестр комиссий</option>
                </select>
                <select
                  value={tplScope}
                  onChange={(e) => setTplScope(e.target.value as typeof tplScope)}
                  className="inp"
                  title="Охват"
                >
                  <option value="all">Все УИК (63)</option>
                  <option value="district">По району</option>
                  <option value="uik">Конкретный УИК</option>
                </select>
                {tplScope === 'district' && (
                  <select value={tplDistrict} onChange={(e) => setTplDistrict(e.target.value)} className="inp">
                    {DISTRICTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
                {tplScope === 'uik' && (
                  <select
                    value={tplUikId || uiks[0]?.id || ''}
                    onChange={(e) => setTplUikId(Number(e.target.value))}
                    className="inp"
                  >
                    {uiks.map((c) => (
                      <option key={c.id} value={c.id}>
                        УИК № {c.uikNo}
                      </option>
                    ))}
                  </select>
                )}
                {tplKind === 'estimate' && (
                  <select
                    value={tplBudget}
                    onChange={(e) => setTplBudget(e.target.value as Budget)}
                    className="inp"
                    title="Бюджет"
                  >
                    <option value="krai">Краевой 40202</option>
                    <option value="fed">Федеральный 40201</option>
                  </select>
                )}
              </div>
              <label className="flex items-center gap-2 text-[12px] text-slate-600">
                <input
                  type="checkbox"
                  checked={tplWithData}
                  onChange={(e) => setTplWithData(e.target.checked)}
                  className="accent-navy"
                />
                Заполнить текущими данными из базы (иначе — пустые строки)
              </label>
              <AdminBtn kind="primary" disabled={tplBusy} onClick={generateTemplates}>
                {tplBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                Сформировать и скачать XLSX
              </AdminBtn>
              <div className="text-[11px] leading-relaxed text-slate-500">
                Каждый УИК — отдельный лист книги Excel; файл пригоден для обратной загрузки через карточку «Файлы».
              </div>
            </div>
          </div>
        </Card>

        {/* ── Вкладки и страницы ── */}
        <Card className="lg:col-span-2">
          <CardHead className="flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5" /> Вкладки и страницы · полное управление
          </CardHead>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
            <div>
              <div className="mb-2 text-[12px] font-semibold text-navy">Встроенные разделы</div>
              <div className="divide-y divide-slate-100 border border-slate-200">
                {nav?.order.map((id, idx) => {
                  const def = SECTION_BY_ID[id];
                  const item = nav.items[id] ?? {};
                  if (!def) return null;
                  const hidden = item.hidden === true;
                  return (
                    <div key={`${id}-${item.label}-${item.short}-${hidden}`} className={cn('px-3 py-2', hidden && 'bg-slate-50 opacity-70')}>
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col">
                          <button
                            disabled={idx === 0}
                            onClick={() => moveNav(nav, id, -1)}
                            className="p-0.5 text-slate-300 hover:text-navy disabled:opacity-30"
                            title="Выше"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            disabled={idx === nav.order.length - 1}
                            onClick={() => moveNav(nav, id, 1)}
                            className="p-0.5 text-slate-300 hover:text-navy disabled:opacity-30"
                            title="Ниже"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                        </div>
                        <input
                          defaultValue={item.label ?? def.label}
                          onBlur={(e) => {
                            if (e.target.value !== (item.label ?? def.label)) patchNavItem(nav, id, { label: e.target.value });
                          }}
                          className="inp h-8 min-w-0 flex-1 py-1 text-[12px]"
                          title="Название вкладки"
                        />
                        <input
                          defaultValue={item.short ?? def.short}
                          onBlur={(e) => {
                            if (e.target.value !== (item.short ?? def.short)) patchNavItem(nav, id, { short: e.target.value });
                          }}
                          className="inp h-8 w-[92px] py-1 text-[12px]"
                          title="Короткое название (мобильная панель)"
                        />
                        <button
                          onClick={() => patchNavItem(nav, id, { hidden: !hidden })}
                          className={cn('p-1.5', hidden ? 'text-amber-600 hover:text-navy' : 'text-slate-400 hover:text-navy')}
                          title={hidden ? 'Показать вкладку' : 'Скрыть вкладку'}
                        >
                          {hidden ? <EyeOff className="h-4 w-4" strokeWidth={1.75} /> : <Eye className="h-4 w-4" strokeWidth={1.75} />}
                        </button>
                        <button
                          onClick={() => patchNavItem(nav, id, { label: undefined, short: undefined, hint: undefined, hidden: false })}
                          className="p-1.5 text-slate-300 hover:text-navy"
                          title="Сбросить настройки вкладки"
                        >
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      </div>
                      <div className="mt-1 pl-7 text-[10px] text-slate-400">{def.hint}</div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-2 text-[12px] font-semibold text-navy">Пользовательские страницы</div>
              <div className="flex gap-2">
                <input
                  value={newPageTitle}
                  onChange={(e) => setNewPageTitle(e.target.value)}
                  placeholder="Название новой страницы"
                  className="inp min-w-0 flex-1 text-[12px]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createPage();
                  }}
                />
                <AdminBtn kind="primary" onClick={createPage}>
                  <Plus className="h-3.5 w-3.5" /> Создать
                </AdminBtn>
              </div>
              <div className="mt-2 divide-y divide-slate-100 border border-slate-200 empty:hidden">
                {pages?.map((page, idx) => (
                  <div key={page.id} data-rec={`pages:${page.id}`} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col">
                        <button
                          disabled={idx === 0}
                          onClick={() => movePage(page.id, -1)}
                          className="p-0.5 text-slate-300 hover:text-navy disabled:opacity-30"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          disabled={idx === pages.length - 1}
                          onClick={() => movePage(page.id, 1)}
                          className="p-0.5 text-slate-300 hover:text-navy disabled:opacity-30"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                      <span className="flex-1 truncate text-[13px] font-medium text-navy">{page.title}</span>
                      <button
                        onClick={() => {
                          setEditingPageId(editingPageId === page.id ? null : page.id);
                          setPageDraft({ title: page.title, body: page.body });
                        }}
                        className="p-1.5 text-slate-400 hover:text-navy"
                        title="Редактировать"
                      >
                        <Pencil className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Удалить страницу «${page.title}»?`)) removePage(page.id).then(tick);
                        }}
                        className="p-1.5 text-slate-300 hover:text-red"
                        title="Удалить"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </div>
                    {editingPageId === page.id && (
                      <div className="mt-2 space-y-2 pl-7">
                        <input
                          value={pageDraft.title}
                          onChange={(e) => setPageDraft((d) => ({ ...d, title: e.target.value }))}
                          className="inp w-full text-[12px]"
                          placeholder="Название"
                        />
                        <textarea
                          value={pageDraft.body}
                          onChange={(e) => setPageDraft((d) => ({ ...d, body: e.target.value }))}
                          className="inp min-h-[120px] w-full text-[12px] leading-relaxed"
                          placeholder="Текст страницы (абзацы разделяются пустой строкой)"
                        />
                        <div className="flex gap-2">
                          <AdminBtn
                            kind="primary"
                            onClick={() => {
                              updatePage(page.id, { title: pageDraft.title.trim() || page.title, body: pageDraft.body });
                              setEditingPageId(null);
                            }}
                          >
                            <Save className="h-3.5 w-3.5" /> Сохранить
                          </AdminBtn>
                          <AdminBtn onClick={() => setEditingPageId(null)}>Отмена</AdminBtn>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
                Созданные страницы сразу появляются в боковом меню и в нижней панели смартфона. Скрытые вкладки не удаляются —
                их можно вернуть в любой момент.
              </div>
            </div>
          </div>
        </Card>

        {/* ── Ставки и данные ── */}
        <Card>
          <CardHead className="flex items-center gap-2">
            <Database className="h-3.5 w-3.5" /> Ставки и данные
          </CardHead>
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-navy">Ставки вознаграждения УИК, ₽/час</div>
              {rates && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(Object.keys(ROLE_NAME) as Role[]).map((role) => (
                    <label key={role} className="block">
                      <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">{ROLE_NAME[role]}</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={rates[role]}
                        onChange={(e) => setRates({ ...rates, [role]: Number(e.target.value) })}
                        className="inp num w-full"
                      />
                    </label>
                  ))}
                </div>
              )}
              {rates && regionK != null && (
                <div className="mt-2 border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <label className="flex flex-wrap items-center gap-2 text-[12px] text-slate-600">
                    <span className="font-semibold text-navy">Районный коэффициент Р:</span>
                    <input
                      type="number"
                      min={1}
                      step="0.1"
                      value={regionK}
                      onChange={(e) => setRegionKState(Number(e.target.value))}
                      className="inp num h-8 w-20"
                      data-regionk-input
                    />
                    <span className="text-slate-500">для Норильска — 1,8; применяется к ставке в формуле Д1</span>
                  </label>
                  <div className="mt-1 text-[11px] text-slate-500" data-regionk-preview>
                    Ставки с РК: председатель {(rates.chair * regionK).toFixed(2)}, зам./секретарь {(rates.deputy * regionK).toFixed(2)},
                    член комиссии {(rates.member * regionK).toFixed(2)} ₽/ч
                  </div>
                </div>
              )}
              <label className="mt-2 flex items-center gap-2 text-[12px] text-slate-600">
                <input
                  type="checkbox"
                  checked={applyToExisting}
                  onChange={(e) => setApplyToExisting(e.target.checked)}
                  className="accent-navy"
                />
                Применить ко всем уже внесённым членам комиссий
              </label>
              <AdminBtn kind="primary" className="mt-2" onClick={saveRates}>
                <Save className="h-3.5 w-3.5" /> Сохранить ставки
              </AdminBtn>
            </div>
            <div className="border-t border-slate-200 pt-3">
              <div className="mb-1.5 text-[12px] font-semibold text-navy">Очистка разделов</div>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(DATA_SECTION_NAME) as Array<keyof typeof DATA_SECTION_NAME>).map((key) => (
                  <AdminBtn key={key} kind="danger" onClick={() => clearSection(key)} title={DATA_SECTION_NAME[key]}>
                    <Trash2 className="h-3.5 w-3.5" /> {DATA_SECTION_NAME[key]}
                  </AdminBtn>
                ))}
              </div>
            </div>
            <div className="border-t border-slate-200 pt-3">
              <div className="mb-1.5 text-[12px] font-semibold text-navy">Резервное копирование</div>
              <input
                ref={backupInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) restoreBackup(f);
                  e.target.value = '';
                }}
              />
              <div className="flex flex-wrap gap-2">
                <AdminBtn onClick={() => exportBackup().then(tick)}>
                  <HardDriveDownload className="h-3.5 w-3.5" /> Скачать резервную копию
                </AdminBtn>
                <AdminBtn kind="danger" onClick={() => backupInputRef.current?.click()}>
                  <HardDriveUpload className="h-3.5 w-3.5" /> Восстановить из копии
                </AdminBtn>
              </div>
              <div className="mt-1.5 text-[11px] text-slate-500">
                Копия включает реестр, составы, сметы, операции, табели, подотчёт, документы, шаблоны, страницы и настройки.
              </div>
            </div>
          </div>
        </Card>

        {/* ── Экспорт и отправка (задача 19: только почтовая программа устройства) ── */}
        <Card className="lg:col-span-2">
          <CardHead className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5" /> Экспорт и отправка по электронной почте
          </CardHead>
          <div className="space-y-3 p-4">
            <div className="grid gap-2 sm:grid-cols-[1.2fr_1fr_1.2fr]">
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Что отправить</span>
                <select value={scope} onChange={(e) => setScope(e.target.value as ExportScope)} className="inp w-full">
                  {Object.keys(EXPORT_SCOPE).map((key) => (
                    <option key={key} value={key}>
                      {EXPORT_SCOPE[key as ExportScope]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Формат</span>
                <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} className="inp w-full">
                  {Object.keys(EXPORT_FORMAT).map((key) => (
                    <option key={key} value={key}>
                      {EXPORT_FORMAT[key as ExportFormat]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Адрес получателя</span>
                <input
                  type="email"
                  value={email}
                  placeholder="buhgalter@example.ru"
                  onChange={(e) => setEmail(e.target.value)}
                  className="inp w-full"
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <AdminBtn disabled={exportBusy} onClick={doDownload}>
                {exportBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Скачать файл
              </AdminBtn>
              {canShareFiles() && (
                <AdminBtn kind="primary" disabled={exportBusy} onClick={doShare}>
                  <Share2 className="h-3.5 w-3.5" /> Отправить файлом…
                </AdminBtn>
              )}
              <AdminBtn
                disabled={exportBusy}
                onClick={doMailto}
                title="Откроется письмо в почтовой программе, файл скачается для вложения"
              >
                <Mail className="h-3.5 w-3.5" /> Открыть письмо + файл
              </AdminBtn>
            </div>
            <div className="text-[11px] leading-relaxed text-slate-500">
              «Отправить файлом…» (на смартфоне) — откроется меню отправки с уже прикреплённым файлом: выберите почту, и письмо
              уйдёт с вложением. «Открыть письмо + файл» — создаст письмо в почтовой программе на этом устройстве и скачает
              файл: останется перетащить его во вложение.
            </div>
          </div>
        </Card>

        {/* ── Журнал ── */}
        <Card>
          <CardHead className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <ScrollText className="h-3.5 w-3.5" /> Журнал действий администратора
            </span>
            <AdminBtn
              onClick={() => {
                if (window.confirm('Очистить журнал?')) clearAdminLog().then(tick);
              }}
              className="normal-case tracking-normal"
            >
              Очистить
            </AdminBtn>
          </CardHead>
          <div className="max-h-[420px] overflow-y-auto">
            {!adminLog?.length && (
              <div className="px-4 py-6 text-center text-[12px] text-slate-500">Действий пока не зафиксировано.</div>
            )}
            {adminLog?.map((entry, idx) => (
              <div key={idx} className="flex items-start gap-3 border-b border-slate-100 px-4 py-2 last:border-0">
                <span className="num w-[118px] shrink-0 text-[11px] text-slate-500">{fmtDateTime(entry.at)}</span>
                <span className="text-[12px] leading-relaxed text-slate-700">{entry.action}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Переключатель режима правки (шапка панели Admin) ─────────────────
// Включает глобальный режим редактирования: записи всех разделов подсвечиваются
// при наведении, клик по записи открывает редактор со всеми полями (включая
// удаление). Выход — повторное переключение, Esc или ✕ на плавающей панели.
function EditModeSwitch() {
  const { active } = useEditState();
  return (
    <button
      role="switch"
      aria-checked={active}
      onClick={() => (active ? stopEdit() : startEdit())}
      title="Режим правки любой информации: записи подсвечиваются при наведении, клик открывает редактор со всеми полями, включая удаление"
      className={cn(
        'flex items-center gap-2 border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors',
        active
          ? 'border-red bg-red text-white'
          : 'border-slate-300 bg-white text-slate-600 hover:border-navy hover:text-navy',
      )}
    >
      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
      Режим правки
      <span
        className={cn(
          'relative h-4 w-8 shrink-0 border',
          active ? 'border-white/70 bg-white/15' : 'border-slate-300 bg-slate-100',
        )}
      >
        <span
          className={cn(
            'absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 transition-all',
            active ? 'left-[calc(100%-0.75rem)] bg-white' : 'left-0.5 bg-slate-400',
          )}
        />
      </span>
      {active ? 'вкл' : 'выкл'}
    </button>
  );
}
