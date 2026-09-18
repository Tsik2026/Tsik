import { db } from './db';
import { logAdmin } from './adminlog';

// ── Резервные копии: выгрузка и восстановление всей базы ─────────────
const TABLES = ['commissions', 'members', 'estimate', 'operations', 'timesheet', 'advances', 'settings', 'pages', 'accounts'] as const;

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const [head, body] = dataUrl.split(',');
  const type = /data:(.*?);base64/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportBackup() {
  const dump: { app: string; format: number; at: string; tables: Record<string, unknown[]> } = {
    app: 'komfin',
    format: 2,
    at: new Date().toISOString(),
    tables: {},
  };
  const tables = dump.tables;
  for (const t of TABLES) {
    tables[t] = await (db as unknown as Record<string, { toArray(): Promise<unknown[]> }>)[t].toArray();
  }
  tables.documents = await Promise.all(
    (await db.documents.toArray()).map(async (d) => ({ ...d, blob: await blobToDataUrl(d.blob as Blob) })),
  );
  tables.templates = await Promise.all(
    (await db.templates.toArray()).map(async (d) => ({ ...d, blob: await blobToDataUrl(d.blob as Blob) })),
  );
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(dump)], { type: 'application/json' }), `komfin_backup_${date}.json`);
  await logAdmin('Сформирована резервная копия базы данных');
}

export async function importBackup(file: File): Promise<string> {
  const text = await file.text();
  let parsed: { app?: string; tables?: Record<string, unknown[]> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('файл не является резервной копией (JSON)');
  }
  if (parsed.app !== 'komfin' || !parsed.tables) {
    throw new Error('файл не распознан как резервная копия приложения');
  }
  const tables = parsed.tables;
  await db.transaction(
    'rw',
    [db.commissions, db.members, db.estimate, db.operations, db.timesheet, db.advances, db.settings, db.documents, db.templates, db.pages, db.accounts],
    async () => {
      for (const t of TABLES) {
        const table = (db as unknown as Record<string, { clear(): Promise<void>; bulkAdd(v: unknown[]): Promise<unknown> }>)[t];
        await table.clear();
        if (Array.isArray(tables[t])) await table.bulkAdd(tables[t]);
      }
      await db.documents.clear();
      for (const d of (tables.documents ?? []) as { blob: string }[]) {
        await db.documents.add({ ...d, blob: await dataUrlToBlob(String(d.blob)) } as never);
      }
      await db.templates.clear();
      for (const d of (tables.templates ?? []) as { blob: string }[]) {
        await db.templates.add({ ...d, blob: await dataUrlToBlob(String(d.blob)) } as never);
      }
    },
  );
  await logAdmin(`Восстановлена резервная копия из файла «${file.name}»`);
  return 'Данные восстановлены из резервной копии. Приложение будет перезагружено.';
}
