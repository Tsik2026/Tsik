// Ленивая загрузка SheetJS и выгрузка в Excel
export interface SheetDef {
  name: string;
  rows: unknown[][];
  widths?: number[];
}

let xlsxPromise: Promise<typeof import('xlsx')> | null = null;

export function loadXlsx() {
  return (xlsxPromise ??= import('xlsx'));
}

export async function exportXlsx(filename: string, sheets: SheetDef[]): Promise<void> {
  try {
    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
      const ws = XLSX.utils.aoa_to_sheet(s.rows as never);
      if (s.widths) ws['!cols'] = s.widths.map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([out], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    window.alert('Модуль Excel ещё не загружен (проверьте сеть при первом использовании) — повторите действие.');
  }
}

export function printPage(): void {
  window.print();
}
