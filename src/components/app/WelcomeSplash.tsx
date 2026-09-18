import { useEffect, useRef, useState } from 'react';
import { Vote } from 'lucide-react';
import { ELECT } from '../../lib/rules';
import { cls } from '../../lib/fmt';

const TOTAL_MS = 3400;
const FADE_MS = 450;

export default function WelcomeSplash({ appReady, onDone }: { appReady: boolean; onDone: () => void }) {
  const [fading, setFading] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFading(true);
    window.setTimeout(onDone, FADE_MS);
  };

  useEffect(() => {
    if (!appReady) return;
    const elapsed = Date.now() - mountedAt;
    const wait = Math.max(0, TOTAL_MS - FADE_MS - elapsed);
    const t = window.setTimeout(finish, wait);
    return () => window.clearTimeout(t);
  }, [appReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      data-edit-ui
      role="dialog"
      aria-label="Приветствие"
      onClick={finish}
      className={cls(
        'fixed inset-0 z-[90] flex cursor-pointer flex-col items-center justify-center overflow-hidden text-white transition-opacity',
        fading ? 'opacity-0' : 'opacity-100',
      )}
      style={{
        transitionDuration: `${FADE_MS}ms`,
        background:
          'radial-gradient(1100px 500px at 85% -10%, rgb(214 60 42 / 0.16), transparent 60%),radial-gradient(900px 600px at -10% 110%, rgb(255 255 255 / 0.05), transparent 55%),linear-gradient(160deg, #0c1930 0%, #0f1f3d 55%, #0c1930 100%)',
      }}
    >
      <div className="flex flex-col items-center px-6 text-center">
        <span
          className="welcome-rise grid h-16 w-16 place-items-center border border-white/25"
          style={{ animationDelay: '60ms' }}
        >
          <Vote className="h-8 w-8 text-white" strokeWidth={1.5} />
        </span>
        <span
          className="welcome-rise welcome-line-anim mt-6 h-[2px] bg-red"
          style={{ animation: 'welcome-line 0.6s cubic-bezier(0.22, 0.9, 0.3, 1) 0.5s forwards', width: 0 }}
        />
        <h1 className="welcome-rise mt-5 text-[26px] font-semibold tracking-wide sm:text-[30px]" style={{ animationDelay: '180ms' }}>
          Комиссия.Финансы
        </h1>
        <p className="welcome-rise mt-1.5 text-[12px] uppercase tracking-[0.22em] text-white/55" style={{ animationDelay: '280ms' }}>
          ТИК города Норильска · 63 УИК
        </p>
        <p className="welcome-rise mt-7 max-w-[420px] text-[13.5px] leading-relaxed text-white/80" style={{ animationDelay: '400ms' }}>
          {ELECT.title}
        </p>
        <p className="welcome-rise mt-1 text-[12px] text-white/50" style={{ animationDelay: '480ms' }}>
          голосование 18–20 сентября 2026 года
        </p>
        <p
          className="welcome-rise mt-9 text-[11px] text-white/45"
          style={{ animationDelay: '600ms', ...(appReady ? {} : { animation: 'welcome-pulse 1.6s ease-in-out infinite' }) }}
        >
          {appReady ? 'Рабочее место готово' : 'Подготовка рабочего места…'}
        </p>
      </div>
      <div className="absolute inset-x-0 bottom-0 pb-8">
        <div className="mx-auto w-[min(420px,72vw)]">
          <div className="h-[2px] w-full bg-white/12">
            {appReady && (
              <div
                className="welcome-progress-anim h-full bg-red"
                style={{ animation: `welcome-progress ${TOTAL_MS - FADE_MS}ms linear forwards` }}
              />
            )}
          </div>
          <div className="mt-3 text-center text-[10.5px] tracking-wide text-white/40">
            окно закроется автоматически · нажмите, чтобы продолжить
          </div>
        </div>
      </div>
    </div>
  );
}
