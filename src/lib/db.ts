import Dexie, { type Table } from 'dexie';
import type {
  AccountRec,
  Advance,
  Commission,
  DocRec,
  EstimateLine,
  Member,
  Operation,
  PageRec,
  SettingRec,
  TimesheetEntry,
} from '../types';

export class KomfinDB extends Dexie {
  commissions!: Table<Commission, number>;
  members!: Table<Member, number>;
  estimate!: Table<EstimateLine, number>;
  operations!: Table<Operation, number>;
  timesheet!: Table<TimesheetEntry, number>;
  advances!: Table<Advance, number>;
  settings!: Table<SettingRec, string>;
  documents!: Table<DocRec, number>;
  templates!: Table<DocRec, number>;
  pages!: Table<PageRec, number>;
  accounts!: Table<AccountRec, number>;

  constructor() {
    super('komfin');
    this.version(1).stores({
      commissions: '++id, level, parentId, budget, uikNo, district',
      members: '++id, commissionId, role',
      estimate: '++id, commissionId, budget, lineCode, [commissionId+budget]',
      operations: '++id, commissionId, budget, date, lineCode, [commissionId+budget]',
      timesheet: '++id, memberId, date',
      advances: '++id, commissionId, status',
      settings: 'key',
    });
    this.version(2).stores({
      documents: '++id, name, kind, addedAt',
      templates: '++id, name, kind, addedAt',
      pages: '++id, order',
    });
    this.version(3).stores({
      accounts: '++id, commissionId, budget, number',
    });
  }
}

export const db = new KomfinDB();

if (typeof window !== 'undefined') {
  (window as unknown as { __db: KomfinDB }).__db = db;
}
