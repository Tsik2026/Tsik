// Форматирование чисел, дат, строк
export function cls(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ');
}

/** 3 540 000 ₽ (без копеек) */
export function rub(n: number, keepKop = false): string {
  return (
    n.toLocaleString('ru-RU', {
      minimumFractionDigits: keepKop ? 2 : 0,
      maximumFractionDigits: keepKop ? 2 : 0,
    }) + (keepKop ? '' : ' ₽')
  );
}

/** 61 576,00 ₽ (с копейками) */
export function rub2(n: number): string {
  return (
    n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽'
  );
}

/** YYYY-MM-DD → DD.MM.YYYY */
export function fmtDate(s: string): string {
  return new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Плюрализация: plural(3, ['день','дня','дней']) → 'дня' */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? forms[2] : b > 1 && b < 5 ? forms[1] : b === 1 ? forms[0] : forms[2];
}

/** Дней осталось до даты (включительно) */
export function daysLeft(dateIso: string, now = new Date()): number {
  const end = new Date(dateIso + 'T23:59:59');
  return Math.ceil((end.getTime() - now.getTime()) / 864e5);
}

/** +11° / −3° / 0° */
export function fmtTemp(t: number): string {
  const u = Math.round(t);
  return `${u > 0 ? '+' : u < 0 ? '−' : ''}${Math.abs(u)}°`;
}

/** Направление ветра по градусам → румб */
export function windRumb(deg: number): string {
  return ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(deg / 45) % 8];
}
