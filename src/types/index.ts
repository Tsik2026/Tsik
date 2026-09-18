// Доменные типы «Комиссия.Финансы — Норильск»
export type Level = 'IKK' | 'TIK' | 'UIK';
export type Budget = 'fed' | 'krai';
export type Role = 'chair' | 'deputy' | 'secretary' | 'member';
export type OpKind = 'in' | 'out';
export type Channel = 'bank' | 'cash' | 'advance';

export interface Commission {
  id: number;
  code: string;
  name: string;
  level: Level;
  parentId?: number;
  budget: Budget;
  account?: string;
  bank?: string;
  chair?: string;
  accountant?: string;
  address?: string;
  phone?: string;
  uikNo?: number;
  district?: string;
  venue?: string;
  /** район, приравненный к Крайнему Северу (предел коэффициента C = 3) */
  far?: boolean;
}

export interface Member {
  id: number;
  commissionId: number;
  fio: string;
  role: Role;
  status: string;
  /** ставка, ₽/ч (63/57/57/45 по пост. ЦИК 10/101-9) */
  rate: number;
  source?: string;
}

export interface EstimateLine {
  id: number;
  commissionId: number;
  budget: Budget;
  lineCode: string;
  limit: number;
  /** решение комиссии (версия сметы) */
  decision: string;
  /** название пользовательской статьи (для кодов вне стандартной матрицы) */
  name?: string;
}

export interface Operation {
  id: number;
  commissionId: number;
  budget: Budget;
  date: string; // YYYY-MM-DD
  kind: OpKind;
  lineCode: string;
  amount: number;
  docNo: string;
  docDate: string;
  counterparty: string;
  purpose: string;
  channel: Channel;
}

export interface TimesheetEntry {
  id: number;
  memberId: number;
  date: string; // YYYY-MM-DD
  dayH: number;
  nightH: number;
  weekendH: number;
}

export interface Advance {
  id: number;
  commissionId: number;
  person: string;
  date: string;
  purpose: string;
  amount: number;
  reported: number;
  docsCount: number;
  status: string;
}

export interface SettingRec {
  key: string;
  value: string;
}

export interface DocRec {
  id: number;
  name: string;
  kind: string;
  addedAt: string;
  data?: string; // dataURL содержимого (локальная библиотека)
  size?: number;
  mime?: string;
  /** исходный файл (Blob), хранится в IndexedDB */
  blob?: Blob;
  /** примечание (например, итог авторазмещения) */
  note?: string;
}

export interface PageRec {
  id: number;
  title: string;
  body: string;
  order: number;
  createdAt: string;
}

export interface AccountRec {
  id: number;
  commissionId: number;
  budget: Budget;
  number: string;
  bank?: string;
  bik?: string;
  opened?: string;
  note?: string;
  /** остаток по выписке банка (вводится вручную для сверки) */
  statementBalance?: number;
  /** дата выписки */
  statementDate?: string;
  /** дата закрытия счёта */
  closed?: string;
}

export type VedC = Record<Role, number>;

export interface Prefs {
  theme: 'light' | 'dim' | 'warm';
  zoom: 90 | 100 | 110;
  welcome: boolean;
}

export interface WxNow {
  temp: number;
  feels: number;
  code: number;
  wind: number;
  dir: number;
}
