import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CalendarClock,
  Clock3,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Flag,
  RefreshCw,
  Snowflake,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { fetchWeather, WX_TEXT } from '../../lib/weather';
import { DEADLINES, ELECT } from '../../lib/rules';
import { cls, fmtTemp, plural, windRumb } from '../../lib/fmt';
import type { WxNow } from '../../types';

const WX_ICON: Record<number, LucideIcon> = {
  0: Sun,
  1: CloudSun,
  2: CloudSun,
  3: Cloud,
  45: CloudFog,
  48: CloudFog,
  51: CloudDrizzle,
  53: CloudDrizzle,
  55: CloudDrizzle,
  56: CloudDrizzle,
  57: CloudDrizzle,
  61: CloudRain,
  63: CloudRain,
  65: CloudRain,
  66: CloudRain,
  67: CloudRain,
  71: CloudSnow,
  73: CloudSnow,
  75: CloudSnow,
  77: Snowflake,
  80: CloudRain,
  81: CloudRain,
  82: CloudRain,
  85: CloudSnow,
  86: CloudSnow,
  95: CloudLightning,
  96: CloudLightning,
  99: CloudLightning,
};

/** Отсчёт до/по голосованию 18–20.09.2026 */
function votingCountdown(now = new Date()): string {
  const start = new Date(`${ELECT.votingDays[0]}T00:00:00`);
  const last = new Date(`${ELECT.votingLastDay}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (today < start) {
    const days = Math.round((start.getTime() - today.getTime()) / 864e5);
    return `до начала голосования ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  }
  return today <= last
    ? `идёт голосование: день ${Math.round((today.getTime() - start.getTime()) / 864e5) + 1} из ${ELECT.votingDays.length}`
    : 'голосование завершено 20.09.2026';
}

/** Ближайший контрольный срок */
function nearestDeadline(now = new Date()): string | null {
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const next = DEADLINES.find((d) => d.date >= today);
  return next ? `ближайший срок ${next.date.split('-').reverse().join('.')} — ${next.title}` : null;
}

interface TickerItem {
  icon: ReactNode;
  text: string;
}

export default function InfoTicker() {
  const [wx, setWx] = useState<WxNow | null | undefined>(undefined);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchWeather().then((w) => {
      if (alive) setWx(w);
    });
    const timer = window.setInterval(() => setTick((t) => t + 1), 6e4);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const items = useMemo<TickerItem[]>(() => {
    const list: TickerItem[] = [];
    if (wx === undefined) {
      list.push({
        icon: <Cloud className="h-3.5 w-3.5 text-white/60" strokeWidth={1.75} />,
        text: 'Норильск: загрузка погоды…',
      });
    } else if (wx === null) {
      list.push({
        icon: <Cloud className="h-3.5 w-3.5 text-white/60" strokeWidth={1.75} />,
        text: 'Норильск: погода временно недоступна',
      });
    } else {
      const Icon = WX_ICON[wx.code] ?? Cloud;
      const text = WX_TEXT[wx.code] ?? 'Облачно';
      list.push({
        icon: <Icon className="h-3.5 w-3.5 text-gold" strokeWidth={1.75} />,
        text: `Норильск: ${fmtTemp(wx.temp)} (ощущается ${fmtTemp(wx.feels)}), ${text.toLowerCase()}, ветер ${Math.round(wx.wind)} м/с ${windRumb(wx.dir)}`,
      });
    }
    list.push({
      icon: <Flag className="h-3.5 w-3.5 text-red" strokeWidth={1.75} />,
      text: `Выборы 18–20.09.2026: ${votingCountdown()}`,
    });
    const deadline = nearestDeadline();
    if (deadline) {
      list.push({
        icon: <CalendarClock className="h-3.5 w-3.5 text-white/60" strokeWidth={1.75} />,
        text: deadline,
      });
    }
    list.push({
      icon: <Clock3 className="h-3.5 w-3.5 text-white/60" strokeWidth={1.75} />,
      text: `Сегодня: ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })}`,
    });
    return list;
  }, [wx]);

  return (
    <div
      aria-label="Информационная строка"
      data-edit-ui
      className="group relative overflow-hidden border-b border-navy-900 bg-navy text-white"
      title="Погода — Open-Meteo · обновление каждые 30 минут"
    >
      <div className="ticker-track flex w-max items-center py-[5px]">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex items-center" aria-hidden={copy === 1}>
            {items.map((item, i) => (
              <span key={i} className="flex items-center gap-1.5 whitespace-nowrap px-5 text-[11.5px] leading-none">
                {item.icon}
                <span className="text-white/85">{item.text}</span>
                <span className="ml-4 h-[3px] w-[3px] bg-red/80" />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Индикатор фоновой синхронизации и жеста «потянуть вниз» */
export function SyncIndicator() {
  const [running, setRunning] = useState(false);
  const [pullDy, setPullDy] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.state === 'run') {
        setRunning(detail.trigger !== 'start');
        return;
      }
      setRunning(false);
      if (detail?.state === 'done' && detail.report?.trigger === 'start' && detail.report?.changed) {
        setFlash('Данные обновлены из подключённых источников');
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setFlash(null), 4500);
      }
    };
    const onPtr = (e: Event) => setPullDy((e as CustomEvent).detail?.dy ?? 0);
    window.addEventListener('komfin:sync', onSync);
    window.addEventListener('komfin:ptr', onPtr);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('komfin:sync', onSync);
      window.removeEventListener('komfin:ptr', onPtr);
    };
  }, []);

  if (!running && !flash && pullDy <= 12) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div
        className={cls(
          'mt-2 flex items-center gap-2 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg',
          flash ? 'bg-emerald-600' : 'bg-navy',
        )}
      >
        {flash ?? (
          <>
            <RefreshCw className={cls('h-3.5 w-3.5', running && 'animate-spin')} strokeWidth={1.75} />
            {running ? 'Синхронизация источников…' : pullDy > 72 ? 'Отпустите для обновления' : 'Потяните вниз для обновления'}
          </>
        )}
      </div>
    </div>
  );
}
