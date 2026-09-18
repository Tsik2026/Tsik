// ── Конфигурация онлайн-модели «Помощи» (BYOK: ключи хранятся только
// в localStorage браузера пользователя, никуда не передаются) ─────────
// ВНИМАНИЕ: GitHub Models полностью закрыт 30.07.2026 — пресет удалён,
// сохранённый у пользователя провайдер 'github' мигрирует в 'pollinations'.
export type AiProvider = 'pollinations' | 'groq' | 'gemini' | 'openrouter' | 'custom';

export interface AiPreset {
  label: string;
  endpoint: string;
  model: string;
  needsKey: boolean;
  hint: string;
}

export const AI_PRESETS: Record<AiProvider, AiPreset> = {
  pollinations: {
    label: 'Pollinations — без ключа или со своим',
    endpoint: 'https://text.pollinations.ai/',
    model: 'openai-fast',
    needsKey: false,
    hint: 'Без ключа — общий анонимный лимит, часто исчерпан (тогда ответ из базы знаний). Для стабильной работы: enter.pollinations.ai → бесплатный ключ (seed-тариф) — вставьте в поле «API-ключ».',
  },
  groq: {
    label: 'Groq — бесплатный ключ',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    hint: 'Открытые модели Llama/Qwen, очень быстро. Бесплатный ключ: console.groq.com → API Keys (без банковской карты).',
  },
  gemini: {
    label: 'Google Gemini — бесплатный ключ',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash',
    needsKey: true,
    hint: 'Щедрый бесплатный лимит. Ключ: aistudio.google.com → «Get API key» (аккаунт Google, без карты).',
  },
  openrouter: {
    label: 'OpenRouter — бесплатный ключ',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-8b-instruct:free',
    needsKey: true,
    hint: 'Модели с пометкой «:free» бесплатны. Ключ: openrouter.ai → Keys.',
  },
  custom: {
    label: 'Свой сервер (OpenAI-совместимый)',
    endpoint: '',
    model: '',
    needsKey: false,
    hint: 'Любой OpenAI-совместимый endpoint: Ollama, LM Studio, vLLM, корпоративный шлюз.',
  },
};

export const LS_AI_PROVIDER = 'komfin:aiProvider';
export const LS_AI_KEY = 'komfin:aiKey';
export const LS_AI_MODEL = 'komfin:aiModel';
export const LS_AI_ENDPOINT = 'komfin:aiEndpoint';
export const LS_AI_ONLINE = 'komfin:aiOnline';

export interface AiConf {
  provider: AiProvider;
  key: string;
  model: string;
  endpoint: string;
}

export function loadAiConf(): AiConf {
  let provider = (localStorage.getItem(LS_AI_PROVIDER) ?? 'pollinations') as AiProvider;
  if (!(provider in AI_PRESETS)) {
    // сохранённый устаревший провайдер (напр. закрытый GitHub Models) → сброс на анонимный
    provider = 'pollinations';
    localStorage.setItem(LS_AI_PROVIDER, provider);
  }
  const preset = AI_PRESETS[provider];
  return {
    provider,
    key: localStorage.getItem(LS_AI_KEY) ?? '',
    model: localStorage.getItem(LS_AI_MODEL) ?? preset.model,
    endpoint: localStorage.getItem(LS_AI_ENDPOINT) ?? preset.endpoint,
  };
}

export function saveAiConf(conf: AiConf) {
  localStorage.setItem(LS_AI_PROVIDER, conf.provider);
  localStorage.setItem(LS_AI_KEY, conf.key);
  localStorage.setItem(LS_AI_MODEL, conf.model);
  localStorage.setItem(LS_AI_ENDPOINT, conf.endpoint);
}

/**
 * Мгновенная настройка по ссылке вида:
 *   https://tsik2026.github.io/Tsik/#aisetup=groq:КЛЮЧ
 *   https://tsik2026.github.io/Tsik/#aisetup=pollinations   (без ключа)
 * Ключ попадает только в localStorage этого браузера; хэш сразу очищается,
 * чтобы ключ не остался в адресной строке и истории. Онлайн-ответы включаются.
 */
export function applyAiSetupFromHash(): boolean {
  if (typeof window === 'undefined') return false;
  const m = window.location.hash.match(/aisetup=([a-z]+)(?::([^&]+))?/i);
  if (!m) return false;
  const provider = m[1].toLowerCase() as AiProvider;
  if (!(provider in AI_PRESETS)) return false;
  const preset = AI_PRESETS[provider];
  const key = m[2] ? decodeURIComponent(m[2]) : '';
  saveAiConf({ provider, key, model: preset.model, endpoint: preset.endpoint });
  localStorage.setItem(LS_AI_ONLINE, '1');
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* ignore */
  }
  return true;
}
