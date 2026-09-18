// Вкладка «Ведомость Сбербанк» — штатный адаптер.
// Функционал живёт в public/assets/sber-vedomost.js (единый источник правды,
// идентичен опубликованному). Здесь — только монтирование и контроль версии.
import { useEffect, useRef } from 'react';

const EXPECTED = 'sberpay37';

export default function SberPay() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    import('/assets/sber-vedomost.js').then((m) => {
      if (alive) m.mount(el);
    }).catch(() => {
      if (alive) el.textContent = 'Вкладка не загрузилась. Обновите приложение (потяните вниз).';
    });
    return () => { alive = false; window.__sbvdmUnmount && window.__sbvdmUnmount(); };
  }, []);

  return <div ref={ref} className="p-3" data-ver={EXPECTED} />;
}
