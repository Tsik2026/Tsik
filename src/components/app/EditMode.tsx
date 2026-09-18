import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, LoaderCircle, Pencil, Save, Trash2, X } from 'lucide-react';
import { db } from '../../lib/db';
import { logAdmin } from '../../lib/adminlog';
import { downloadBlob } from '../../lib/backup';
import { clearRec, editRec, stopEdit, useEditState } from '../../lib/editmode';
import { BUDGET_SHORT, LEVEL_NAME, LINE_CODES, LINE_NAME, ROLE_NAME } from '../../lib/rules';
import { cls } from '../../lib/fmt';

// ── Схемы записей ────────────────────────────────────────────────────
type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'blob';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: Record<string, string>;
}

interface TableSchema {
  title: string;
  describe?: (rec: Record<string, unknown>) => string;
  fields: FieldDef[];
}

const LINE_OPTIONS = Object.fromEntries(LINE_CODES.map((c) => [c, `${c} · ${LINE_NAME[c] ?? c}`]));

const SCHEMAS: Record<string, TableSchema> = {
  commissions: {
    title: 'Комиссия',
    describe: (r) => String(r.code ?? ''),
    fields: [
      { key: 'code', label: 'Код', type: 'text' },
      { key: 'name', label: 'Наименование', type: 'textarea' },
      { key: 'level', label: 'Уровень', type: 'select', options: LEVEL_NAME },
      { key: 'parentId', label: 'ID вышестоящей комиссии', type: 'number' },
      { key: 'budget', label: 'Основной бюджет', type: 'select', options: BUDGET_SHORT },
      { key: 'uikNo', label: '№ участка', type: 'number' },
      { key: 'district', label: 'Район', type: 'text' },
      { key: 'venue', label: 'Помещение для голосования', type: 'text' },
      { key: 'address', label: 'Адрес', type: 'text' },
      { key: 'phone', label: 'Телефон', type: 'text' },
      { key: 'account', label: 'Счёт', type: 'text' },
      { key: 'bank', label: 'Банк / РКЦ', type: 'text' },
      { key: 'chair', label: 'Председатель', type: 'text' },
      { key: 'accountant', label: 'Бухгалтер', type: 'text' },
    ],
  },
  members: {
    title: 'Член комиссии',
    describe: (r) => String(r.fio ?? ''),
    fields: [
      { key: 'commissionId', label: 'ID комиссии', type: 'number' },
      { key: 'fio', label: 'ФИО', type: 'text' },
      { key: 'role', label: 'Роль', type: 'select', options: { ...ROLE_NAME } },
      { key: 'status', label: 'Статус', type: 'select', options: { нештатный: 'нештатный', освобождённый: 'освобождённый' } },
      { key: 'rate', label: 'Ставка, ₽/час', type: 'number' },
      { key: 'source', label: 'Источник записи', type: 'select', options: { official: 'официальный', demo: 'демонстрационный' } },
    ],
  },
  estimate: {
    title: 'Строка сметы',
    describe: (r) => String(r.lineCode ?? ''),
    fields: [
      { key: 'commissionId', label: 'ID комиссии', type: 'number' },
      { key: 'budget', label: 'Бюджет', type: 'select', options: BUDGET_SHORT },
      { key: 'lineCode', label: 'Статья расходов', type: 'select', options: LINE_OPTIONS },
      { key: 'name', label: 'Своё название статьи (для пользовательских)', type: 'text' },
      { key: 'limit', label: 'Лимит, ₽', type: 'number' },
      { key: 'decision', label: 'Решение комиссии (реквизиты)', type: 'textarea' },
    ],
  },
  operations: {
    title: 'Операция (банк/касса)',
    describe: (r) => `№ ${String(r.docNo ?? '')} от ${String(r.docDate ?? '')}`,
    fields: [
      { key: 'commissionId', label: 'ID комиссии', type: 'number' },
      { key: 'budget', label: 'Бюджет', type: 'select', options: BUDGET_SHORT },
      { key: 'date', label: 'Дата проводки', type: 'date' },
      { key: 'kind', label: 'Приход/расход', type: 'select', options: { in: 'поступление', out: 'расход' } },
      { key: 'lineCode', label: 'Статья сметы', type: 'select', options: LINE_OPTIONS },
      { key: 'amount', label: 'Сумма, ₽', type: 'number' },
      { key: 'docNo', label: '№ документа', type: 'text' },
      { key: 'docDate', label: 'Дата документа', type: 'text' },
      { key: 'counterparty', label: 'Контрагент', type: 'text' },
      { key: 'purpose', label: 'Назначение платежа', type: 'textarea' },
      { key: 'channel', label: 'Канал', type: 'select', options: { bank: 'Банк', cash: 'Касса', advance: 'Подотчёт' } },
    ],
  },
  timesheet: {
    title: 'Запись табеля',
    describe: (r) => `дата ${String(r.date ?? '')}`,
    fields: [
      { key: 'memberId', label: 'ID члена комиссии', type: 'number' },
      { key: 'date', label: 'Дата', type: 'date' },
      { key: 'dayH', label: 'Дневные часы', type: 'number' },
      { key: 'nightH', label: 'Ночные часы (×2)', type: 'number' },
      { key: 'weekendH', label: 'Часы в выходные (×2)', type: 'number' },
    ],
  },
  advances: {
    title: 'Подотчётная сумма',
    describe: (r) => String(r.person ?? ''),
    fields: [
      { key: 'commissionId', label: 'ID комиссии', type: 'number' },
      { key: 'person', label: 'Подотчётное лицо', type: 'text' },
      { key: 'date', label: 'Дата выдачи', type: 'date' },
      { key: 'purpose', label: 'Назначение', type: 'textarea' },
      { key: 'amount', label: 'Выдано, ₽', type: 'number' },
      { key: 'reported', label: 'Отчитано, ₽', type: 'number' },
      { key: 'docsCount', label: 'Документов, шт.', type: 'number' },
      {
        key: 'status',
        label: 'Статус',
        type: 'select',
        options: { выдан: 'выдан', частично: 'частично', сдан: 'сдан', проверен: 'проверен' },
      },
    ],
  },
  pages: {
    title: 'Пользовательская страница',
    describe: (r) => String(r.title ?? ''),
    fields: [
      { key: 'title', label: 'Название', type: 'text' },
      { key: 'body', label: 'Текст страницы', type: 'textarea' },
      { key: 'order', label: 'Порядок в меню', type: 'number' },
      { key: 'createdAt', label: 'Создана (ISO)', type: 'text' },
    ],
  },
  documents: {
    title: 'Документ библиотеки',
    describe: (r) => String(r.name ?? ''),
    fields: [
      { key: 'name', label: 'Имя файла', type: 'text' },
      {
        key: 'kind',
        label: 'Тип',
        type: 'select',
        options: {
          rosters: 'Составы комиссий',
          registry: 'Реестр комиссий',
          estimate: 'Смета',
          timesheet: 'Табель',
          document: 'Документ',
        },
      },
      { key: 'mime', label: 'MIME-тип', type: 'text' },
      { key: 'note', label: 'Служебная пометка', type: 'textarea' },
      { key: 'addedAt', label: 'Добавлен (ISO)', type: 'text' },
      { key: 'blob', label: 'Файл', type: 'blob' },
    ],
  },
  templates: {
    title: 'Шаблон',
    describe: (r) => String(r.name ?? ''),
    fields: [
      { key: 'name', label: 'Имя файла', type: 'text' },
      {
        key: 'kind',
        label: 'Тип',
        type: 'select',
        options: { estimate: 'Смета', roster: 'Состав', registry: 'Реестр', generic: 'Универсальный' },
      },
      { key: 'mime', label: 'MIME-тип', type: 'text' },
      { key: 'addedAt', label: 'Добавлен (ISO)', type: 'text' },
      { key: 'blob', label: 'Файл', type: 'blob' },
    ],
  },
  accounts: {
    title: 'Расчётный счёт',
    describe: (r) => String(r.number ?? ''),
    fields: [
      { key: 'commissionId', label: 'ID комиссии', type: 'number' },
      { key: 'budget', label: 'Бюджет', type: 'select', options: BUDGET_SHORT },
      { key: 'number', label: 'Номер счёта', type: 'text' },
      { key: 'bank', label: 'Банк', type: 'text' },
      { key: 'bik', label: 'БИК', type: 'text' },
      { key: 'opened', label: 'Дата открытия', type: 'date' },
      { key: 'closed', label: 'Дата закрытия (пусто — действующий)', type: 'date' },
      { key: 'note', label: 'Примечание', type: 'textarea' },
      { key: 'statementBalance', label: 'Остаток по выписке, ₽', type: 'number' },
      { key: 'statementDate', label: 'Дата выписки', type: 'date' },
    ],
  },
};

interface RecRef {
  table: string;
  id: number;
}

function parseRec(raw: string | null): RecRef | null {
  if (!raw) return null;
  const m = /^([a-z]+):(\d+)$/.exec(raw.trim());
  if (!m || !(m[1] in SCHEMAS)) return null;
  return { table: m[1], id: Number(m[2]) };
}

// ── CRUD ─────────────────────────────────────────────────────────────
const tableOf = (name: string) => db.table(name);

async function loadRec(ref: RecRef): Promise<Record<string, unknown> | undefined> {
  return tableOf(ref.table).get(ref.id);
}

async function saveRec(ref: RecRef, rec: Record<string, unknown>) {
  const schema = SCHEMAS[ref.table];
  const patch: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (f.type === 'blob') continue;
    const value = rec[f.key];
    if (f.type === 'number') {
      const s = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
      if (s === '') {
        patch[f.key] = undefined;
        continue;
      }
      const n = Number(s);
      patch[f.key] = Number.isFinite(n) ? n : undefined;
      continue;
    }
    const s = String(value ?? '').trim();
    patch[f.key] = s === '' ? undefined : s;
  }
  await tableOf(ref.table).update(ref.id, patch);
  const desc = schema.describe?.(rec) ?? `#${ref.id}`;
  await logAdmin(`Режим правки: изменена запись «${schema.title}» (${desc})`);
}

async function deleteRec(ref: RecRef) {
  const schema = SCHEMAS[ref.table];
  const rec = await loadRec(ref);
  await tableOf(ref.table).delete(ref.id);
  const desc = rec ? (schema.describe?.(rec) ?? `#${ref.id}`) : `#${ref.id}`;
  await logAdmin(`Режим правки: удалена запись «${schema.title}» (${desc})`);
}

async function replaceBlob(ref: RecRef, file: File) {
  await tableOf(ref.table).update(ref.id, {
    blob: file,
    mime: file.type || 'application/octet-stream',
    ...(ref.table === 'documents' || ref.table === 'templates' ? { size: file.size } : {}),
  });
  await logAdmin(`Режим правки: заменён файл записи «${SCHEMAS[ref.table].title}» (${file.name})`);
}

// ── Жесты: клик по записи в режиме правки / Esc ─────────────────────
// Активация режима — только переключателем «Режим правки» вверху панели Admin.
function useEditGestures() {
  useEffect(() => {
    const recFromEvent = (e: Event): RecRef | null => {
      const el = (e.target as HTMLElement)?.closest?.('[data-rec]');
      return parseRec(el?.getAttribute('data-rec') ?? null);
    };
    const isEditUi = (e: Event) => !!(e.target as HTMLElement)?.closest?.('[data-edit-ui]');

    const onClick = (e: MouseEvent) => {
      if (isEditUi(e)) return;
      const ref = recFromEvent(e);
      if (ref && document.body.classList.contains('edit-mode')) {
        e.preventDefault();
        e.stopPropagation();
        editRec(`${ref.table}:${ref.id}`);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopEdit();
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
}

const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

// ── Редактор записи ──────────────────────────────────────────────────
function RecordEditor({ recRef }: { recRef: RecRef }) {
  const schema = SCHEMAS[recRef.table];
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setRec(null);
    setMissing(false);
    loadRec(recRef).then((r) => {
      if (!alive) return;
      if (r) setRec({ ...r });
      else setMissing(true);
    });
    return () => {
      alive = false;
    };
  }, [recRef.table, recRef.id]);

  const setField = (key: string, value: unknown) => setRec((r) => (r ? { ...r, [key]: value } : r));

  const save = async () => {
    if (!rec) return;
    setBusy(true);
    try {
      await saveRec(recRef, rec);
      clearRec();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Удалить запись «${schema.title}» безвозвратно?`)) return;
    setBusy(true);
    try {
      await deleteRec(recRef);
      clearRec();
    } finally {
      setBusy(false);
    }
  };

  const replaceFile = async (file: File) => {
    setBusy(true);
    try {
      await replaceBlob(recRef, file);
      const fresh = await loadRec(recRef);
      if (fresh) setRec({ ...fresh });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-navy/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" data-edit-ui>
      <div className="flex max-h-[92vh] w-full max-w-[680px] flex-col border border-slate-200 bg-white shadow-2xl sm:max-h-[86vh]">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <Pencil className="h-4 w-4 shrink-0 text-red" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Режим правки · {schema.title} · запись #{recRef.id}
            </div>
            <div className="truncate text-[14px] font-semibold text-navy">
              {rec ? (schema.describe?.(rec) ?? '—') : '…'}
            </div>
          </div>
          <button onClick={clearRec} className="p-1.5 text-slate-400 hover:text-navy" title="Закрыть (Esc)">
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {missing && (
            <div className="py-8 text-center text-[13px] text-slate-500">Запись не найдена — возможно, она уже удалена.</div>
          )}
          {!missing && !rec && (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Загрузка записи…
            </div>
          )}
          {rec && (
            <div className="grid gap-3 sm:grid-cols-2">
              {schema.fields.map((f) => {
                if (f.type === 'blob') {
                  const blob = rec[f.key] as Blob | undefined;
                  return (
                    <div key={f.key} className="sm:col-span-2">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        {f.label}
                      </span>
                      <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                        <span className="text-[12px] text-slate-600">
                          {blob ? `${formatBytes(blob.size)} · ${blob.type || 'файл'}` : 'файл отсутствует'}
                        </span>
                        {blob && (
                          <button
                            onClick={() => downloadBlob(blob, String(rec.name ?? 'file'))}
                            className="flex items-center gap-1 border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-navy hover:bg-slate-50"
                          >
                            <Download className="h-3 w-3" /> Скачать
                          </button>
                        )}
                        <button
                          onClick={() => fileRef.current?.click()}
                          className="flex items-center gap-1 border border-navy bg-white px-2.5 py-1 text-[11px] font-medium text-navy hover:bg-slate-50"
                        >
                          <FileUp className="h-3 w-3" /> Заменить файлом
                        </button>
                        <input
                          ref={fileRef}
                          type="file"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) replaceFile(file);
                            e.target.value = '';
                          }}
                        />
                      </div>
                    </div>
                  );
                }
                const raw = rec[f.key];
                const value = raw == null ? '' : String(raw);
                const label = (
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                    {f.label}
                  </span>
                );
                if (f.type === 'textarea') {
                  return (
                    <label key={f.key} className="block sm:col-span-2">
                      {label}
                      <textarea
                        value={value}
                        rows={3}
                        onChange={(e) => setField(f.key, e.target.value)}
                        className="inp w-full text-[13px] leading-relaxed"
                      />
                    </label>
                  );
                }
                if (f.type === 'select') {
                  const options = f.options ?? {};
                  const known = value === '' || value in options;
                  return (
                    <label key={f.key} className="block">
                      {label}
                      <select value={value} onChange={(e) => setField(f.key, e.target.value)} className="inp w-full">
                        {!known && <option value={value}>{value}</option>}
                        {value === '' && <option value="">— не задано —</option>}
                        {Object.entries(options).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }
                if (f.type === 'number') {
                  return (
                    <label key={f.key} className="block">
                      {label}
                      <input
                        value={value}
                        inputMode="decimal"
                        onChange={(e) => setField(f.key, e.target.value)}
                        className="inp num w-full"
                        placeholder="—"
                      />
                    </label>
                  );
                }
                if (f.type === 'date') {
                  return (
                    <label key={f.key} className="block">
                      {label}
                      <input
                        type="date"
                        value={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ''}
                        onChange={(e) => setField(f.key, e.target.value)}
                        className="inp w-full"
                      />
                    </label>
                  );
                }
                return (
                  <label key={f.key} className="block">
                    {label}
                    <input value={value} onChange={(e) => setField(f.key, e.target.value)} className="inp w-full text-[13px]" />
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
          <button
            onClick={save}
            disabled={!rec || busy}
            className="flex items-center gap-1.5 bg-navy px-4 py-2 text-[12px] font-semibold text-white hover:bg-navy-800 disabled:opacity-40"
          >
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" strokeWidth={1.75} />}
            Сохранить
          </button>
          <button
            onClick={remove}
            disabled={!rec || busy}
            className="flex items-center gap-1.5 border border-red/40 px-3 py-2 text-[12px] font-medium text-red hover:bg-red hover:text-white disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} /> Удалить запись
          </button>
          <button onClick={clearRec} className="ms-auto px-3 py-2 text-[12px] font-medium text-slate-500 hover:text-navy">
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Глобальный компонент режима правки ───────────────────────────────
export default function EditMode() {
  const { active, rec } = useEditState();
  useEditGestures();
  useEffect(() => {
    document.body.classList.toggle('edit-mode', active);
    return () => {
      document.body.classList.remove('edit-mode');
    };
  }, [active]);

  const recRef = parseRec(rec);

  return (
    <>
      {active && !recRef && (
        <div
          data-edit-ui
          className={cls(
            'fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 border border-red/50 bg-navy px-4 py-2.5 text-white shadow-xl lg:bottom-6',
          )}
          role="status"
        >
          <Pencil className="h-4 w-4 shrink-0 text-red" strokeWidth={2} />
          <span className="text-[12px] font-medium leading-tight">
            Режим правки: нажмите на любую запись — откроется редактор.
            <span className="block text-[10px] text-white/60">Esc, ✕ или переключатель в Admin — выход из режима</span>
          </span>
          <button onClick={stopEdit} className="p-1 text-white/60 hover:text-white" title="Выйти из режима правки">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      )}
      {recRef && <RecordEditor recRef={recRef} />}
    </>
  );
}
