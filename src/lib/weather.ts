import type { WxNow } from '../types';

const URL_API =
  'https://api.open-meteo.com/v1/forecast?latitude=69.3558&longitude=88.1893&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&timezone=Asia%2FKrasnoyarsk&wind_speed_unit=ms';
const CACHE_KEY = 'komfin:weather';
const TTL = 1800 * 1000; // 30 минут

/** Код погоды → подпись (иконки маппятся в компоненте) */
export const WX_TEXT: Record<number, string> = {
  0: 'Ясно',
  1: 'Преимущественно ясно',
  2: 'Переменная облачность',
  3: 'Пасмурно',
  45: 'Туман',
  48: 'Изморозь',
  51: 'Морось',
  53: 'Морось',
  55: 'Морось',
  56: 'Ледяная морось',
  57: 'Ледяная морось',
  61: 'Дождь',
  63: 'Дождь',
  65: 'Сильный дождь',
  66: 'Ледяной дождь',
  67: 'Ледяной дождь',
  71: 'Снег',
  73: 'Снег',
  75: 'Сильный снег',
  77: 'Снежная крупа',
  80: 'Ливень',
  81: 'Ливень',
  82: 'Сильный ливень',
  85: 'Снегопад',
  86: 'Снегопад',
  95: 'Гроза',
  96: 'Гроза с градом',
  99: 'Гроза с градом',
};

/** Текущая погода в Норильске: кэш 30 мин, при сбое сети — последний кэш */
export async function fetchWeather(): Promise<WxNow | null> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.at < TTL && cached.wx) return cached.wx as WxNow;
    }
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch(URL_API);
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    const wx: WxNow = {
      temp: Number(json.current.temperature_2m),
      feels: Number(json.current.apparent_temperature),
      code: Number(json.current.weather_code),
      wind: Number(json.current.wind_speed_10m),
      dir: Number(json.current.wind_direction_10m),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), wx }));
    return wx;
  } catch {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.wx) return cached.wx as WxNow;
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}
