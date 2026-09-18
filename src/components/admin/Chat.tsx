// AI-ассистент «Помощь» для панели администратора.
// Работает полностью офлайн: встроенная база знаний по приложению и нормативке
// (пост. ЦИК 10/101-9), ответы по живым данным локальной базы.
// Опционально — онлайн-улучшение через бесплатные открытые модели:
// анонимно (Pollinations, без ключа) или со своим бесплатным ключом
// (Groq / Google Gemini / OpenRouter / любой OpenAI-совместимый сервер).
// При недоступности сервиса автоматически используется офлайн-ответ.
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw, Send, Sparkles, WifiOff } from 'lucide-react';
import { Card, CardHead } from '../app/kit';
import { cls } from '../../lib/fmt';
import { db } from '../../lib/db';
import { BUDGET_NAME, DEADLINES, ELECT, LINE_CODES, LINE_NAME, NIGHT_K, REGION_K, ROLE_NAME, WEEKEND_K } from '../../lib/rules';
import { loadRates, getRegionK } from '../../lib/settings';
import { daysLeft, rub } from '../../lib/fmt';
import {
  AI_PRESETS,
  LS_AI_ONLINE,
  loadAiConf,
  saveAiConf,
  type AiConf,
  type AiProvider,
} from '../../lib/aiconf';

interface Msg {
  role: 'user' | 'ai';
  text: string;
  online?: boolean;
}

const LS_HISTORY = 'komfin:aiHelp';
const LS_ONLINE = LS_AI_ONLINE;

const QUICK: string[] = [
  'Как загрузить табель?',
  'Ставки и формула расчёта',
  'Как добавить направление в смету?',
  'Ближайшие дедлайны',
  'Как отправить отчёт по почте?',
  'Сколько УИК в базе?',
  'Как настроить онлайн-ответы?',
];

// ── Офлайн база знаний ───────────────────────────────────────────────
const KB: Array<{ re: RegExp; answer: string }> = [
  {
    re: /привет|здравств|добрый/i,
    answer:
      'Здравствуйте! Я — помощник администратора «Комиссия.Финансы — Норильск». Отвечаю на вопросы о работе приложения: смета, табели, вознаграждения, операции, подотчёт, отчётность, сверка с банком, файлы и шаблоны. Работаю офлайн; при включённом онлайн-режиме отвечаю развёрнутее.',
  },
  {
    re: /ставк|сколько.*(плат|оплат)|вознагражд|формул|расч[её]т|начисл/i,
    answer: `Ставки УИК (пост. ЦИК 10/101-9, прил. № 9): председатель — 63 ₽/ч, зам. и секретарь — 57 ₽/ч, член комиссии — 45 ₽/ч. Формула Д1: ставка × районный коэффициент (для Норильска Р = ${REGION_K}) × часы; ночные часы ×${NIGHT_K}, часы в выходные ×${WEEKEND_K}. Итог ограничен коэффициентом C (по роли; для районов Крайнего Севера — до 3). Ставки меняются в карточке «Ставки и данные» — можно применить ко всем уже внесённым членам комиссий.`,
  },
  {
    re: /табел/i,
    answer:
      'Табель принимает две формы: матрица (ФИО × столбцы-даты, в ячейках — часы; даты вида «17.09», «17.09.2026», с пометками «ночь»/«вых») и построчная (ФИО | Дата | Дневные | Ночные | Выходные). Загрузка: карточка «Табели учёта времени» → выберите УИК → «Загрузить табель». Люди из файла, которых нет в составе, добавляются автоматически; повторная загрузка обновляет часы, а не дублирует. Сетка под кнопками — прямое редактирование: часы, добавление и удаление дат.',
  },
  {
    re: /смет/i,
    answer:
      'Смета ведётся по статьям прил. № 9: ' +
      LINE_CODES.map((c) => `${c} — ${LINE_NAME[c] ?? ''}`).join('; ') +
      '. Добавить направление можно вручную в разделе «Смета» (кнопка «Добавить направление»): выберите статью из выпадающего списка или создайте свою (пользовательские статьи хранятся отдельно и попадают в отчёты). Массово — загрузкой файла в карточке «Сметы» панели Admin: колонки «Статья/Код» и «Лимит, ₽», существующие строки обновляются, новые добавляются.',
  },
  {
    re: /операци|40201|40202|банк и касса|касса/i,
    answer: `Операции ведутся по двум бюджетам: ${BUDGET_NAME.krai} (УИК) и ${BUDGET_NAME.fed} (ТИК). Каналы: банк, касса, подотчёт. Каждая операция привязывается к статье сметы — так автоматически считаются остатки лимитов и отчёт прил. № 10. Банковские операции участвуют в сверке со счетами (раздел «Календарь контроля» → «Счета и сверка»).`,
  },
  {
    re: /подотч[её]т|аванс/i,
    answer:
      'Подотчётные суммы: выдача аванса фиксируется операцией расхода с каналом «подотчёт», затем член комиссии отчитывается авансовым отчетом с документами. В разделе «Подотчёт» видно: выдано, отчитались, число документов, статус. Не закрытые в срок авансы подсвечиваются.',
  },
  {
    re: /отч[её]т|приложени|прил\.?\s*9|прил\.?\s*10/i,
    answer:
      'Раздел «Отчётность» формирует отчёт по прил. № 9 (расчёт вознаграждений) и прил. № 10 (исполнение сметы): выгрузка в Excel и печатная форма с подписями. Данные берутся из сметы, операций и табелей — перед отчётом проверьте контрольные соотношения на дашборде.',
  },
  {
    re: /сверк|счет|выписк/i,
    answer:
      'Сверка с банком: «Календарь контроля» → «Счета и сверка». Заведите расчётный счёт (20 цифр), введите остаток по выписке — программа сравнит его с остатком по учёту (приход минус расход по каналу «банк»). Совпадение — статус «совпадает», иначе «расхождение». Кнопка «Заполнить из справочника» подтянет счета из карточек комиссий.',
  },
  {
    re: /дедлайн|срок|календар|когда.*(сдать|отчит)/i,
    answer: '', // заполняется динамически
  },
  {
    re: /выбор|голосован|дата.*выбор/i,
    answer: '', // динамически
  },
  {
    re: /правк|редактир|удалить запис|изменить запис/i,
    answer:
      'Режим правки любой информации включается переключателем «Режим правки» вверху панели Admin (в заголовке «Управление приложением»). Пока режим активен, записи во всех разделах подсвечиваются при наведении, а клик по любой записи открывает редактор со всеми полями, включая удаление. Выход — тот же переключатель, Esc или кнопка ✕ на плавающей панели.',
  },
  {
    re: /экспорт|выгруз|скачать|excel|xlsx/i,
    answer:
      'Экспорт — карточка «Экспорт и отправка» внизу панели: выберите охват (таблица или сводный отчёт), формат (xlsx/csv/json) и действие: «Скачать файл», «Отправить файлом…» (меню «Поделиться» на смартфоне) или «Открыть письмо + файл» (письмо в почтовой программе устройства, файл скачивается для вложения). Полная копия базы — «Резервное копирование» в карточке «Ставки и данные».',
  },
  {
    re: /почт|e-?mail|отправ/i,
    answer:
      'Отправка работает через штатную почтовую программу устройства: кнопка «Открыть письмо + файл» создаёт письмо с темой и текстом отчёта и скачивает файл — останется перетащить его во вложение. На смартфоне удобнее «Отправить файлом…»: откроется системное меню с уже прикреплённым файлом — выберите почту, и письмо уйдёт с вложением.',
  },
  {
    re: /резерв|бэкап|backup|восстанов/i,
    answer:
      'Резервная копия: карточка «Ставки и данные» → «Скачать резервную копию» (JSON со всеми таблицами, включая файлы документов). «Восстановить из копии» полностью заменяет текущие данные содержимым файла — перед восстановлением сохраните текущую копию.',
  },
  {
    re: /файл|загруз|распозна|размест/i,
    answer:
      'Карточка «Файлы» принимает xlsx/xls/csv/txt/json перетаскиванием или выбором. Тип определяется автоматически: составы комиссий, реестр, смета, табель — кнопка «Разместить» запишет данные в базу, исходный файл попадёт в библиотеку документов. Нераспознанные файлы просто сохраняются в библиотеку. Для строк без номера УИК выберите участок в выпадающем списке очереди.',
  },
  {
    re: /шаблон/i,
    answer:
      'Шаблоны: пустые формы (состав, смета, реестр) — кнопки в карточке «Шаблоны». Автозаполнение по критериям: тип, охват (все УИК / район / конкретный), для смет — бюджет; галочка «Заполнить текущими данными» подставит составы и лимиты из базы. Свои файлы-формы добавляются кнопкой «Загрузить свой шаблон».',
  },
  {
    re: /вкладк|страниц|меню|навигац/i,
    answer:
      'Карточка «Вкладки и страницы»: порядок разделов (стрелки), переименование (полное и короткое для мобильной панели), скрытие без удаления, сброс. Пользовательские страницы создаются по названию и сразу появляются в боковом меню и нижней панели смартфона.',
  },
  {
    re: /очист|удалить все|сброс/i,
    answer:
      'Очистка разделов — карточка «Ставки и данные»: отдельные кнопки по разделам (составы, сметы, операции, табели, подотчёт, счета, страницы). Действие необратимо — сделайте резервную копию. Каждая очистка фиксируется в журнале действий администратора.',
  },
  {
    re: /синхрон|обновлен|реестр.*обнов/i,
    answer:
      'Справочник комиссий обновляется из файла реестра: «Справочники» → «Обновление данных» — источники URL проверяются при старте и по pull-to-refresh; уже применённые версии не накатываются повторно. Ручная кнопка «Обновить сейчас» принудительно проверяет все источники.',
  },
  {
    re: /состав|член|председател/i,
    answer:
      'Составы комиссий: «Справочники» → карточка состава. Массовая загрузка — файлом (карточка «Файлы»): колонки «ФИО», «Роль», опционально «№ УИК». Роли: председатель, заместитель, секретарь, член комиссии. Председатель из файла автоматически проставляется в карточку комиссии.',
  },
  {
    re: /онлайн|модель|нейросет|искусственн|настрой.*ассистент|ключ.*(ai|апи|api)|(ai|апи|api).*ключ/i,
    answer:
      'Онлайн-ответы включаются галочкой «онлайн-ответы» в заголовке этой карточки, настройка — блок «Настройка онлайн-модели» под полем ввода. Варианты: 1) Pollinations — без ключа, но общий анонимный лимит часто исчерпан; свой бесплатный ключ (enter.pollinations.ai, seed-тариф) делает работу стабильной. 2) Google Gemini — самый щедрый бесплатный лимит, ключ на aistudio.google.com. 3) Groq — очень быстро, ключ на console.groq.com. 4) OpenRouter — модели с пометкой «:free». Ключ хранится только в localStorage этого устройства. Кнопка «Проверить подключение» сразу проверяет связку ключ+модель, «Ссылка для другого устройства» копирует адрес вида …/#aisetup=провайдер:ключ — откройте его на телефоне, и настройка применится автоматически (хэш сразу очищается). GitHub Models закрыт в июле 2026 — токены GitHub для онлайн-ответов не подходят. Если сервис недоступен, я честно отвечаю из встроенной базы знаний с пометкой.',
  },
];

const FALLBACK =
  'Могу рассказать про: ставки и формулу расчёта вознаграждений, загрузку табелей и составов, смету и добавление направлений, операции по 40201/40202, подотчёт, сверку с банком, отчётность (прил. № 9/10), экспорт и отправку по почте, резервные копии, вкладки и страницы, режим правки. Уточните вопрос или выберите тему ниже.';

async function dynamicAnswer(q: string): Promise<string | null> {
  const norm = q.toLowerCase();
  if (/сколько[^?]{0,25}(уик|комисси|человек|членов|всего)|статистик/.test(norm)) {
    const [commissions, members, uiks] = await Promise.all([
      db.commissions.toArray(),
      db.members.toArray(),
      db.commissions.where('level').equals('UIK').count(),
    ]);
    const withMembers = new Set(members.map((m) => m.commissionId)).size;
    return (
      `В базе: комиссий — ${commissions.length} (ТИК — 1, УИК — ${uiks}), членов комиссий — ${members.length} чел. ` +
      `Состав заполнен у ${withMembers} комиссий. Подробности — в разделе «Справочники».`
    );
  }
  if (/дедлайн|срок|календар/.test(norm)) {
    const next = DEADLINES.map((d) => ({ ...d, left: daysLeft(d.date) })).filter((d) => d.left >= 0).sort((a, b) => a.left - b.left)[0];
    if (!next) return 'Все контрольные сроки из календаря уже прошли. Полный список — в разделе «Календарь контроля».';
    return `Ближайший дедлайн: «${next.title}» — ${next.date.split('-').reverse().join('.')}, осталось дней: ${next.left}. Полный календарь и чек-лист — в разделе «Календарь контроля».`;
  }
  if (/выбор|голосован/.test(norm)) {
    const first = ELECT.votingDays[0];
    const last = ELECT.votingLastDay;
    const start = daysLeft(first);
    const line =
      start > 0
        ? `До начала голосования — ${start} дн.`
        : daysLeft(last) >= 0
          ? `Голосование идёт: день ${Math.min(ELECT.votingDays.length, -start + 1)} из ${ELECT.votingDays.length}.`
          : 'Голосование завершено.';
    return `Выборы (${ELECT.title}): голосование ${first.split('-').reverse().join('.')} — ${last.split('-').reverse().join('.')} (${ELECT.votingDays.length} дня). ${line}`;
  }
  if (/ставк|районн.*коэфф/.test(norm)) {
    const [rates, k] = await Promise.all([loadRates(), getRegionK()]);
    return `Текущие ставки (с учётом ваших переопределений): ${(Object.keys(ROLE_NAME) as Array<keyof typeof ROLE_NAME>)
      .map((r) => `${ROLE_NAME[r].toLowerCase()} — ${rates[r]} ₽/ч`)
      .join(', ')}. Районный коэффициент Р = ${k} (для Норильска 1,8). Ставки с РК: председатель ${(rates.chair * k).toFixed(2)}, зам./секретарь ${(rates.deputy * k).toFixed(2)}, член комиссии ${(rates.member * k).toFixed(2)} ₽/ч.`;
  }
  if (/лимит|остаток.*(стат|смет)|итог.*смет/.test(norm)) {
    const [estimate, ops] = await Promise.all([db.estimate.toArray(), db.operations.toArray()]);
    const limit = estimate.reduce((s, e) => s + e.limit, 0);
    const spent = ops.filter((o) => o.kind === 'out').reduce((s, o) => s + o.amount, 0);
    return `По всем сметам базы: лимитов назначено — ${rub(limit)}, израсходовано — ${rub(spent)}, остаток — ${rub(limit - spent)}. По конкретной комиссии смотрите раздел «Смета».`;
  }
  return null;
}

async function offlineAnswer(q: string): Promise<string> {
  const dyn = await dynamicAnswer(q);
  if (dyn) return dyn;
  for (const item of KB) {
    if (item.re.test(q)) {
      if (item.answer) return item.answer;
      const dyn2 = await dynamicAnswer(item.re.source.includes('дедлайн') ? 'дедлайн' : 'выборы');
      return dyn2 ?? FALLBACK;
    }
  }
  return FALLBACK;
}

// ── Онлайн: бесплатная открытая модель (без ключа) ───────────────────
const SYSTEM =
  'Ты — помощник администратора офлайн-приложения «Комиссия.Финансы — Норильск» (учёт финансов избирательных комиссий: ТИК и 63 УИК). ' +
  'Отвечай кратко и по делу, по-русски. Темы: смета расходов (прил. № 9 пост. ЦИК 10/101-9), табели учёта времени, вознаграждения ' +
  '(ставки 63/57/57/45 ₽/ч, районный коэффициент 1,8, ночные ×2, выходные ×2), операции по счетам 40201/40202, подотчёт, ' +
  'отчётность прил. № 10, сверка с банком, загрузка файлов xlsx/csv/json, резервные копии. ' +
  'Все данные хранятся локально на устройстве (IndexedDB), облачной базы нет.';

// Сервис иногда возвращает сбой кодом 200 текстом ошибки — распознаём такие ответы
const ONLINE_FAIL_RE = /raise the key budget|enter\.pollinations\.ai|api key used|rate limit|insufficient_?quota|service unavailable|model is (currently )?(unavailable|loading)|model not found|invalid api key|incorrect api key|unauthorized|authentication/i;

// ── Конфигурация онлайн-модели: анонимно (Pollinations) или свой бесплатный ключ ──
// Пресеты и хранение — в lib/aiconf.ts (GitHub Models закрыт 30.07.2026, пресет удалён)

async function onlineAnswer(q: string, history: Msg[], attempt = 0): Promise<string> {
  const conf = loadAiConf();
  const preset = AI_PRESETS[conf.provider] ?? AI_PRESETS.pollinations;
  const endpoint = (conf.endpoint || preset.endpoint).trim();
  const model = (conf.model || preset.model).trim();
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-6).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: q },
  ];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conf.key.trim()) headers.Authorization = `Bearer ${conf.key.trim()}`;
  let res: Response;
  if (conf.provider === 'pollinations') {
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ messages, model }) });
  } else {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, max_tokens: 700, temperature: 0.3 }),
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = (await res.text()).trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as { error?: unknown; choices?: Array<{ message?: { content?: string } }> };
      if (j.error) throw new Error('api error');
      const content = j.choices?.[0]?.message?.content?.trim();
      if (content) text = content;
      else if (conf.provider !== 'pollinations') throw new Error('пустой ответ');
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  if (!text || ONLINE_FAIL_RE.test(text)) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1200 : 3200));
      return onlineAnswer(q, history, attempt + 1);
    }
    throw new Error('онлайн-модель недоступна');
  }
  return text;
}

// ── Компонент ────────────────────────────────────────────────────────
export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_HISTORY) ?? '[]') as Msg[];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => localStorage.getItem(LS_ONLINE) === '1');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(LS_HISTORY, JSON.stringify(messages.slice(-40)));
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const canSend = useMemo(() => input.trim().length > 0 && !busy, [input, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      if (online && navigator.onLine) {
        try {
          const text = await onlineAnswer(q, messages);
          setMessages((m) => [...m, { role: 'ai', text, online: true }]);
          return;
        } catch {
          // сеть или сервис недоступны — отвечаем офлайн с пометкой
          const text = await offlineAnswer(q);
          setMessages((m) => [
            ...m,
            { role: 'ai', text: 'Онлайн-модель временно недоступна — ответ из встроенной базы знаний:\n\n' + text },
          ]);
          return;
        }
      }
      const text = await offlineAnswer(q);
      setMessages((m) => [...m, { role: 'ai', text }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHead className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" /> Помощь · AI-ассистент администратора
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[10px] font-normal normal-case tracking-normal text-slate-500" title="Бесплатные открытые модели: Pollinations (без ключа или со своим), Google Gemini, Groq, OpenRouter — настраивается ниже. Выкл. — ответы только из встроенной базы знаний, полностью офлайн.">
          <input
            type="checkbox"
            checked={online}
            onChange={(e) => {
              setOnline(e.target.checked);
              localStorage.setItem(LS_ONLINE, e.target.checked ? '1' : '0');
            }}
            className="accent-navy"
          />
          онлайн-ответы
        </label>
      </CardHead>
      <div className="p-4">
        <div ref={listRef} className="max-h-[300px] space-y-2.5 overflow-y-auto pr-1">
          {!messages.length && (
            <div className="border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
              Отвечаю на вопросы по работе приложения: смета, табели, вознаграждения, операции, подотчёт, отчётность, сверка,
              файлы, шаблоны. База знаний встроена — работаю офлайн; переключатель «онлайн-ответы» подключает бесплатную
              открытую модель для свободных вопросов.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cls('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cls(
                  'max-w-[85%] px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap',
                  m.role === 'user' ? 'bg-navy text-white' : 'border border-slate-200 bg-slate-50/70 text-slate-700',
                )}
              >
                {m.online && (
                  <div className="mb-0.5 flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-slate-400">
                    <Sparkles className="h-2.5 w-2.5" /> онлайн-модель
                  </div>
                )}
                {m.text}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> думаю…
            </div>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q}
              onClick={() => ask(q)}
              className="border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:border-navy/40 hover:text-navy"
            >
              {q}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ask(input);
            }}
            placeholder="Вопрос по работе приложения…"
            className="inp min-w-0 flex-1 text-[12px]"
          />
          <button
            onClick={() => ask(input)}
            disabled={!canSend}
            className="flex items-center gap-1.5 border border-navy bg-navy px-3.5 py-2 text-[12px] font-medium text-white hover:bg-navy/90 disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Спросить
          </button>
          <button
            onClick={() => setMessages([])}
            title="Очистить диалог"
            className="p-2 text-slate-300 hover:text-navy"
          >
            <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
        <AiSettings online={online} />
        <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-slate-400">
          <WifiOff className="h-3 w-3" />
          Офлайн-режим — по встроенной базе знаний; онлайн-ответы — бесплатные открытые модели (Pollinations — без
          ключа или со своим, стабильнее всего — Google Gemini и Groq, ключи бесплатные). Ключ хранится только на этом
          устройстве.
        </div>
      </div>
    </Card>
  );
}

// ── Настройка онлайн-модели (провайдер, ключ, модель) ────────────────
function AiSettings({ online }: { online: boolean }) {
  const [conf, setConf] = useState<AiConf>(() => loadAiConf());
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  if (!online) return null;
  const preset = AI_PRESETS[conf.provider];
  const save = () => {
    saveAiConf(conf);
    setSaved(true);
    setTestMsg(null);
    window.setTimeout(() => setSaved(false), 2000);
  };
  const setupLink = () => {
    const base = `${window.location.origin}${window.location.pathname}`;
    return conf.key.trim()
      ? `${base}#aisetup=${conf.provider}:${encodeURIComponent(conf.key.trim())}`
      : `${base}#aisetup=${conf.provider}`;
  };
  const copyLink = async () => {
    const link = setupLink();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // буфер недоступен (не-HTTPS) — показываем ссылку для ручного копирования
      window.prompt('Скопируйте ссылку настройки:', link);
      return;
    }
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 2500);
  };
  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const endpoint = (conf.endpoint || preset.endpoint).trim();
      const model = (conf.model || preset.model).trim();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (conf.key.trim()) headers.Authorization = `Bearer ${conf.key.trim()}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Ответь одним словом: готов.' }], max_tokens: 30 }),
      });
      const raw = (await res.text()).trim();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let ok = false;
      if (raw.startsWith('{')) {
        try {
          const j = JSON.parse(raw) as { error?: unknown; choices?: Array<{ message?: { content?: string } }> };
          if (j.error) throw new Error('api error');
          ok = !!j.choices?.[0]?.message?.content?.trim();
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          ok = false;
        }
      } else ok = raw.length > 0;
      if (!ok || ONLINE_FAIL_RE.test(raw)) throw new Error('лимит/ключ');
      saveAiConf(conf); // проверено — сразу сохраняем
      setTestMsg('Подключение работает — настройки сохранены ✓');
    } catch (e) {
      setTestMsg(
        `Не удалось подключиться (${e instanceof Error ? e.message : 'ошибка'}). Проверьте ключ и модель — либо выберите другого провайдера.`,
      );
    } finally {
      setTesting(false);
    }
  };
  return (
    <details className="mt-2.5 border border-slate-200 bg-slate-50/50 px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-medium text-slate-600 hover:text-navy">
        Настройка онлайн-модели: {preset.label}
        {conf.key.trim() ? ' · ключ задан' : ''}
      </summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-slate-600">
          <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Провайдер</span>
          <select
            value={conf.provider}
            onChange={(e) => {
              const p = e.target.value as AiProvider;
              setConf({ provider: p, key: '', model: AI_PRESETS[p].model, endpoint: AI_PRESETS[p].endpoint });
            }}
            className="inp w-full text-[12px]"
          >
            {(Object.keys(AI_PRESETS) as AiProvider[]).map((p) => (
              <option key={p} value={p}>
                {AI_PRESETS[p].label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-slate-600">
          <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            API-ключ{preset.needsKey ? '' : ' (необязательно)'}
          </span>
          <input
            type="password"
            value={conf.key}
            onChange={(e) => setConf({ ...conf, key: e.target.value.trim() })}
            placeholder={preset.needsKey ? 'вставьте бесплатный ключ' : 'можно оставить пустым'}
            className="inp w-full text-[12px]"
            autoComplete="off"
          />
        </label>
        <label className="text-[11px] text-slate-600">
          <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Модель</span>
          <input
            value={conf.model}
            onChange={(e) => setConf({ ...conf, model: e.target.value })}
            className="inp w-full text-[12px]"
          />
        </label>
        <label className="text-[11px] text-slate-600">
          <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Endpoint</span>
          <input
            value={conf.endpoint}
            onChange={(e) => setConf({ ...conf, endpoint: e.target.value })}
            readOnly={conf.provider !== 'custom'}
            className="inp w-full text-[12px] read-only:bg-slate-100"
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          className="border border-navy bg-navy px-3 py-1.5 text-[11px] font-medium text-white hover:bg-navy/90"
        >
          {saved ? 'Сохранено ✓' : 'Сохранить настройки'}
        </button>
        <button
          onClick={() => void test()}
          disabled={testing}
          className="border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {testing ? 'Проверяю…' : 'Проверить подключение'}
        </button>
        <button
          onClick={() => void copyLink()}
          title="Ссылка мгновенно настроит онлайн-ответы на другом устройстве (например, на телефоне): откройте её там — провайдер, ключ и онлайн-режим применятся сами, ключ останется только в браузере устройства"
          className="border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
        >
          {linkCopied ? 'Ссылка скопирована ✓' : 'Ссылка для другого устройства'}
        </button>
        <span className="text-[10.5px] leading-snug text-slate-500">{preset.hint}</span>
      </div>
      {testMsg && (
        <div
          className={`mt-2 border px-2.5 py-1.5 text-[11px] ${
            testMsg.endsWith('✓') ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-700'
          }`}
        >
          {testMsg}
        </div>
      )}
    </details>
  );
}
