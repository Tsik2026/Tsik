// Отправка данных через штатные средства устройства: скачивание,
// системное меню «Поделиться» и почтовая программа (mailto).
import type { BuiltFile } from './files';

/** Скачивание сформированного файла */
export function downloadBuiltFile(f: BuiltFile): void {
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Поддерживает ли устройство отправку файлов через меню «Поделиться» */
export function canShareFiles(): boolean {
  try {
    const probe = new File([new Blob(['x'])], 'x.txt', { type: 'text/plain' });
    return (
      typeof navigator !== 'undefined' &&
      'share' in navigator &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [probe] })
    );
  } catch {
    return false;
  }
}

/** Отправка файла через системное меню «Поделиться» (смартфон) */
export async function shareBuiltFile(f: BuiltFile, email: string, title: string): Promise<void> {
  const file = new File([f.blob], f.filename, { type: f.blob.type });
  await navigator.share({
    files: [file],
    title,
    text: email ? `${title}\nКому: ${email}` : title,
  });
}

/** Письмо в штатной почтовой программе устройства (mailto) */
export function openMailto(email: string, subject: string, body: string): void {
  const query = `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
  window.location.href = `mailto:${encodeURIComponent(email)}${query}`;
}
