import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { Card, SectionHead } from '../components/app/kit';

export default function CustomPage({ id }: { id: number }) {
  const page = useLiveQuery(() => db.pages.get(id), [id]);
  if (page === undefined) return <div className="text-slate-500">Загрузка…</div>;
  if (!page) return <div className="text-slate-500">Страница не найдена или была удалена.</div>;
  return (
    <div className="mx-auto max-w-[900px]">
      <SectionHead label="Пользовательская страница" title={page.title} />
      <Card className="px-5 py-4">
        {page.body.trim() ? (
          page.body.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="mb-3 whitespace-pre-wrap text-[14px] leading-relaxed text-slate-700 last:mb-0">
              {para}
            </p>
          ))
        ) : (
          <div className="text-[13px] text-slate-500">
            Страница пока пуста. Наполнение — через панель Admin, раздел «Вкладки и страницы».
          </div>
        )}
      </Card>
    </div>
  );
}
