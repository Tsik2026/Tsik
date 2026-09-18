import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  BookOpen,
  CalendarClock,
  ChevronDown,
  CircleQuestionMark,
  FileSpreadsheet,
  LayoutDashboard,
  Mail,
  MousePointerClick,
  Scale,
  Smartphone,
  Users,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cls } from '../../lib/fmt';

// ── Типографика справки ──────────────────────────────────────────────
function Para({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-slate-600">{children}</p>;
}

function Item({ lead, children }: { lead?: string; children: ReactNode }) {
  return (
    <li className="flex gap-2 text-[12.5px] leading-relaxed text-slate-600">
      <span className="mt-[7px] h-[5px] w-[5px] shrink-0 bg-red/70" />
      <span>
        {lead && <b className="font-semibold text-navy">{lead} — </b>}
        {children}
      </span>
    </li>
  );
}

function MiniTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto border border-slate-200">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-slate-50">
            {head.map((h) => (
              <th
                key={h}
                className="border-b border-slate-200 px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {r.map((c, j) => (
                <td key={j} className={cls('px-2.5 py-1.5 align-top text-slate-600', j > 0 && 'whitespace-nowrap')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Разделы руководства ──────────────────────────────────────────────
const SECTIONS: { id: string; title: string; icon: LucideIcon; body: ReactNode }[] = [
  {
    id: 'start',
    title: 'Быстрый старт',
    icon: MousePointerClick,
    body: (
      <div className="grid gap-2.5">
        <Para>
          Сайт — рабочее место финансового учёта ТИК города Норильска и 63 участковых комиссий на кампанию
          «Госдума-2026 · ЗС Красноярского края-2026». Все разделы доступны сразу, регистрация не требуется.
        </Para>
        <ul className="grid gap-1.5">
          <Item lead="Шаг 1">
            в шапке выберите комиссию (ТИК Норильска или нужная УИК) — все разделы покажут данные именно по ней.
          </Item>
          <Item lead="Шаг 2">
            переключите бюджет: «Краевой 40202» или «Федеральный 40201» — учёт ведётся раздельно.
          </Item>
          <Item lead="Шаг 3">работайте в разделах меню слева (на смартфоне — нижняя панель вкладок).</Item>
          <Item lead="Приветственный экран">
            при запуске показывается краткое приветствие с плавным авто-закрытием за 2–4 секунды; пропуск — кликом или
            клавишей Esc; отключается в «Настройки → Оформление».
          </Item>
          <Item lead="Бегущая строка">
            под шапкой — погода в Норильске (обновление каждые 30 минут), отсчёт дней до голосования, ближайший
            контрольный срок и текущая дата; при наведении прокрутка приостанавливается.
          </Item>
          <Item lead="Где данные">
            всё сохраняется автоматически в локальную базу этого браузера (IndexedDB) — интернет не обязателен.
          </Item>
          <Item lead="Офлайн">
            сайт работает без сети; при пропадании связи в шапке появится пометка «офлайн», изменения сохранятся
            локально.
          </Item>
          <Item lead="Установка">
            сайт можно установить как приложение: в меню браузера — «Установить приложение» / «На экран "Домой"».
          </Item>
        </ul>
      </div>
    ),
  },
  {
    id: 'dashboard',
    title: 'Дашборд — контроль и статус',
    icon: LayoutDashboard,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Сводка">
          остатки средств, исполнение сметы, начисленные вознаграждения и ключевые показатели по выбранной комиссии и
          бюджету.
        </Item>
        <Item lead="Контрольные соотношения">
          автоматические проверки: расходы в пределах лимитов, начисления не выше статьи PAY, полнота первички, статус
          сверки с банком.
        </Item>
        <Item>Индикатор вверху экрана показывает фоновую синхронизацию подключённых источников.</Item>
      </ul>
    ),
  },
  {
    id: 'directory',
    title: 'Справочники — комиссии и состав',
    icon: BookOpen,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Комиссии">
          карточки ТИК и всех УИК: номер, район, помещение для голосования, адрес, телефон, банковские реквизиты.
        </Item>
        <Item lead="Состав">
          члены комиссий с ролями (председатель, заместитель, секретарь, член) и ставками вознаграждения.
        </Item>
        <Item lead="Переход">клик по комиссии выбирает её текущей — дальше все разделы работают по ней.</Item>
        <Item lead="Правка">любая запись редактируется через режим правки (см. раздел «Режим правки Admin» ниже).</Item>
      </ul>
    ),
  },
  {
    id: 'estimate',
    title: 'Смета — лимиты и решения',
    icon: Wallet,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Направления расходов">
          вознаграждения (PAY), ГПД, информирование, полиграфия, транспорт, связь и ГАС «Выборы», оборудование,
          обучение, прочие. Кроме стандартной матрицы можно добавить свою статью — кнопка «Добавить направление в
          смету».
        </Item>
        <Item lead="Лимиты">
          по каждому направлению фиксируется доведённый лимит с реквизитами решения; исполнение видно в процентах и
          рублях.
        </Item>
        <Item lead="Раздельный учёт">
          лимиты ведутся отдельно по краевому и федеральному бюджетам — переключатель в шапке.
        </Item>
      </ul>
    ),
  },
  {
    id: 'operations',
    title: 'Банк и касса — операции',
    icon: ArrowLeftRight,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Проводки">
          поступления и расходы по счетам 40201/40202: дата, сумма, направление сметы, контрагент, номер и дата
          документа-основания.
        </Item>
        <Item lead="Фильтры">по виду (приход/расход), направлению, периоду — для сверки и поиска.</Item>
        <Item lead="Первичка">
          контроль «у каждой операции есть документ» — операции без номера документа подсвечиваются на дашборде.
        </Item>
      </ul>
    ),
  },
  {
    id: 'advances',
    title: 'Подотчёт — авансовые отчёты УИК',
    icon: FileSpreadsheet,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Авансы">выдача подотчётных сумм членам комиссий с сроками отчётности.</Item>
        <Item lead="Авансовые отчёты">
          погашение авансов документами; остаток подотчёта виден по каждому лицу и комиссии.
        </Item>
        <Item>Отчёты УИК в ТИК формируются на основании этих данных (Инструкция ЦИК 7/59-7).</Item>
      </ul>
    ),
  },
  {
    id: 'payroll',
    title: 'Табели и вознаграждения',
    icon: Users,
    body: (
      <div className="grid gap-2.5">
        <ul className="grid gap-1.5">
          <Item lead="Табель">
            по каждому члену УИК вносятся часы: будни (6:00–22:00), ночные (22:00–6:00), выходные и праздничные.
          </Item>
          <Item lead="Расчёт">
            дневные часы × ставка × районный коэффициент (для Норильска — 1,8); ночные и выходные — в двойном размере
            (пост. ЦИК 10/101-9 от 24.06.2026).
          </Item>
          <Item lead="Коэффициент за активную работу C">
            Д = Д1 + Д1×C — задаётся по ролям при формировании ведомости по решению комиссии: председатель ≤ 2,0;
            заместитель, секретарь и член комиссии ≤ 1,5; для труднодоступных местностей ≤ 3,0.
          </Item>
          <Item lead="Ведомость">
            расчётная ведомость формируется по выбранной УИК и выгружается (прил. № 6 к Порядку выплат).
          </Item>
        </ul>
        <MiniTable
          head={['Роль в УИК', 'Ставка, ₽/час']}
          rows={[
            ['Председатель', '63,00'],
            ['Заместитель председателя', '57,00'],
            ['Секретарь', '57,00'],
            ['Иной член комиссии', '45,00'],
          ]}
        />
        <Para>
          Ставки — приложение № 2 к пост. ЦИК 10/101-9 (указаны без районного коэффициента; с РК 1,8: 113,40 / 102,60
          / 102,60 / 81,00 ₽/ч). Ночные часы и работа в выходные оплачиваются в двойном размере.
        </Para>
      </div>
    ),
  },
  {
    id: 'reports',
    title: 'Отчётность — формы, Excel, печать',
    icon: FileSpreadsheet,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Отчёт о поступлении и расходовании">
          поступления, расходы по направлениям и остатки к возврату — по выбранной комиссии и бюджету.
        </Item>
        <Item lead="Выгрузка">
          Excel (XLSX) и CSV для сдачи на машиночитаемом носителе; печать бумажного экземпляра.
        </Item>
        <Item>Свод по всем УИК собирается на уровне ТИК выбором соответствующей комиссии в шапке.</Item>
      </ul>
    ),
  },
  {
    id: 'control',
    title: 'Календарь контроля — дедлайны, сверка, счета',
    icon: CalendarClock,
    body: (
      <div className="grid gap-2.5">
        <MiniTable
          head={['Срок', 'Действие']}
          rows={[
            ['30.09.2026', 'УИК → ТИК: отчёт и первичные документы'],
            ['10.10.2026', 'ТИК → ИК КК: отчёт, Главная книга, регистры, закрытие счёта'],
            ['20.10.2026', 'Выплата вознаграждения членам УИК'],
            ['31.12.2026', 'Итоговая отчётность, завершение финансовой кампании'],
          ]}
        />
        <ul className="grid gap-1.5">
          <Item lead="Чек-лист закрытия">шесть обязательных шагов завершения кампании с отметками выполнения.</Item>
          <Item lead="Реестр счетов">
            ручной ввод расчётных счетов (20-значный номер, банк, БИК, дата открытия) + автозаполнение реестра из
            справочника комиссий одной кнопкой.
          </Item>
          <Item lead="Сверка с банком">
            по каждому счёту: остаток по учёту считается автоматически из операций, остаток по выписке вводится
            вручную; статусы «совпадает/расхождение»; подтверждение сверки доступно, когда все счета совпали.
          </Item>
        </ul>
      </div>
    ),
  },
  {
    id: 'mail',
    title: 'Экспорт и отправка по электронной почте',
    icon: Mail,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Где">панель Admin → «Экспорт и отправка по электронной почте».</Item>
        <Item lead="Что">
          любой набор данных: комиссии, состав, смета, операции, табели, подотчёт, реестр счетов и средств, документы,
          полная выгрузка, резервная копия.
        </Item>
        <Item lead="Как">
          формат XLSX или CSV; далее — «Скачать», «Отправить файлом» (системное меню «Поделиться») либо «Открыть
          письмо» — письмо создаётся в почтовой программе устройства, файл прикладывается одним движением.
        </Item>
        <Item>Имя файла формируется автоматически: раздел + дата.</Item>
      </ul>
    ),
  },
  {
    id: 'edit',
    title: 'Режим правки Admin — редактирование любых записей',
    icon: Wrench,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Включение">
          переключатель «Режим правки» вверху панели Admin (справа в заголовке «Управление приложением»).
        </Item>
        <Item lead="Редактирование">
          когда режим активен, записи во всех разделах подсвечиваются при наведении, а клик по любой записи (строка
          таблицы, карточка) открывает её редактор: все поля, сохранение, удаление записи.
        </Item>
        <Item lead="Выход">
          тот же переключатель в Admin, клавиша Esc или кнопка ✕ на плавающей панели; текущее состояние видно по
          пометке «режим правки».
        </Item>
        <Item lead="Осторожно">
          удаление записей необратимо; перед массовой правкой сделайте резервную копию (Admin → резервные копии).
        </Item>
      </ul>
    ),
  },
  {
    id: 'mobile',
    title: 'Жесты и работа со смартфона',
    icon: Smartphone,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Нижняя панель">основные разделы и Admin — всегда под рукой; список прокручивается горизонтально.</Item>
        <Item lead="Потянуть вниз">обновление данных из подключённых источников.</Item>
        <Item lead="Долгое нажатие">включение режима правки (аналог правого клика).</Item>
        <Item lead="Установка">
          «Установить приложение» в меню браузера — сайт открывается отдельным окном и работает офлайн.
        </Item>
      </ul>
    ),
  },
  {
    id: 'admin',
    title: 'Панель Admin — настройка и обслуживание',
    icon: Wrench,
    body: (
      <ul className="grid gap-1.5">
        <Item lead="Вкладки">
          переименование, скрытие и порядок разделов; создание собственных страниц с произвольным содержанием.
        </Item>
        <Item lead="Табели">ведение табелей рабочего времени по всем комиссиям централизованно.</Item>
        <Item lead="Резервные копии">
          полная выгрузка базы в файл и восстановление из файла (перед этим сверьте дату копии).
        </Item>
        <Item lead="Очистка">постраничная очистка таблиц с подтверждением — для начала нового периода.</Item>
        <Item lead="Журнал">последние действия администрирования (кто и когда менял настройки, счета, вкладки).</Item>
        <Item lead="Почта">отправка выгрузок — см. раздел «Экспорт и отправка по электронной почте» выше.</Item>
      </ul>
    ),
  },
  {
    id: 'rules',
    title: 'Нормативная база расчётов',
    icon: Scale,
    body: (
      <div className="grid gap-2.5">
        <ul className="grid gap-1.5">
          <Item lead="ФЗ-67">ст. 57, 58 — финансовое обеспечение выборов, счета комиссий, отчётность.</Item>
          <Item lead="Инструкция ЦИК 7/59-7">
            (ред. 16.07.2025) — открытие и ведение счетов, учёт и отчётность по средствам федерального бюджета.
          </Item>
          <Item lead="Пост. ЦИК 10/101-9">
            от 24.06.2026 — ставки вознаграждений и Порядок выплат на выборах Госдумы-2026 (график работы, сведения о
            времени, расчётная ведомость, ведомственный коэффициент).
          </Item>
          <Item lead="УЗ КК 11-4807">раздельный учёт средств федерального и краевого бюджетов.</Item>
          <Item lead="Решение ИК КК 98/1080-8">счета ТИК; пост. Администрации Норильска 442 (ред. 111).</Item>
        </ul>
        <Para>
          Формы на сайте носят подготовительный характер: подпись и подача отчётности осуществляются комиссией по
          регламенту. Перед сдачей сверяйте реквизиты актов с действующими редакциями.
        </Para>
      </div>
    ),
  },
];

// ── Модальное окно справки ───────────────────────────────────────────
function HelpModal({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['start']));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const expandAll = () => setOpen(new Set(SECTIONS.map((s) => s.id)));
  const collapseAll = () => setOpen(new Set());

  return (
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-navy/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      data-edit-ui
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[94vh] w-full max-w-[780px] flex-col border border-slate-200 bg-white shadow-2xl sm:max-h-[88vh]">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <CircleQuestionMark className="h-4 w-4 shrink-0 text-red" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Справка</div>
            <div className="truncate text-[14px] font-semibold text-navy">
              Как работать на сайте — полное руководство
            </div>
          </div>
          <button
            onClick={open.size === SECTIONS.length ? collapseAll : expandAll}
            className="hidden shrink-0 border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-navy hover:bg-slate-50 sm:block"
          >
            {open.size === SECTIONS.length ? 'Свернуть все' : 'Развернуть все'}
          </button>
          <button onClick={onClose} className="shrink-0 p-1.5 text-slate-400 hover:text-navy" title="Закрыть (Esc)">
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <p className="mb-3 text-[12px] leading-relaxed text-slate-500">
            Руководство по всем разделам сайта. Нажмите на раздел, чтобы раскрыть его содержание.
          </p>
          <div className="grid gap-2">
            {SECTIONS.map((sec, i) => {
              const Icon = sec.icon;
              const isOpen = open.has(sec.id);
              return (
                <div key={sec.id} className="border border-slate-200">
                  <button
                    data-help-section={sec.id}
                    onClick={() => toggle(sec.id)}
                    className={cls(
                      'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                      isOpen ? 'bg-navy text-white' : 'bg-white text-navy hover:bg-slate-50',
                    )}
                  >
                    <span
                      className={cls(
                        'grid h-6 w-6 shrink-0 place-items-center border text-[10px] font-semibold',
                        isOpen ? 'border-white/30 text-white/80' : 'border-slate-300 text-slate-400',
                      )}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <Icon className={cls('h-4 w-4 shrink-0', isOpen ? 'text-white' : 'text-red')} strokeWidth={1.75} />
                    <span className="flex-1 text-[13px] font-semibold leading-tight">{sec.title}</span>
                    <ChevronDown
                      className={cls('h-4 w-4 shrink-0 transition-transform', isOpen ? 'rotate-180 text-white/70' : 'text-slate-400')}
                      strokeWidth={1.75}
                    />
                  </button>
                  {isOpen && <div className="border-t border-slate-200 bg-slate-50/50 px-4 py-3.5">{sec.body}</div>}
                </div>
              );
            })}
          </div>
        </div>
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] leading-relaxed text-slate-500">
          Данные хранятся локально в этом браузере; регулярно выгружайте резервную копию (Admin → резервные копии).
          Закрыть справку: Esc, ✕ или клик по затемнённой области.
        </div>
      </div>
    </div>
  );
}

/** Кнопка «Как работать на сайте» в шапке (задача 16 — в одну строку с Admin и «Настройки») */
export default function HelpButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onHelp = () => setOpen(true);
    window.addEventListener('komfin:help', onHelp);
    return () => window.removeEventListener('komfin:help', onHelp);
  }, []);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Как работать на сайте — полное руководство"
        className="flex h-10 items-center justify-center gap-1.5 border border-slate-300 bg-white px-3 text-[12px] font-semibold text-navy transition-colors hover:bg-slate-50 max-lg:flex-1 lg:h-9"
      >
        <CircleQuestionMark className="h-4 w-4 text-red" strokeWidth={1.75} />
        Как работать на сайте
      </button>
      {open && createPortal(<HelpModal onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
