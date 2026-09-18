import { useSyncExternalStore } from 'react';

// Глобальный режим редактирования записей (data-rec на строках таблиц)
export interface EditState {
  active: boolean;
  rec: string | null;
}

let state: EditState = { active: false, rec: null };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): EditState {
  return state;
}

export function useEditState(): EditState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Включить режим редактирования (без выбранной записи) */
export function startEdit(): void {
  state = { active: true, rec: null };
  emit();
}

/** Включить режим и выбрать запись вида "table:id" */
export function editRec(rec: string): void {
  state = { active: true, rec };
  emit();
}

export function clearRec(): void {
  state = { ...state, rec: null };
  emit();
}

export function stopEdit(): void {
  state = { active: false, rec: null };
  emit();
}
