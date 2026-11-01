/**
 * Message translation through Google Cloud Translation (Basic, v2). Turned on by setting
 * GOOGLE_TRANSLATE_API_KEY. Without the key, messages are shown in the language they were written in.
 */
export const LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "ru", name: "Русский" },
  { code: "uk", name: "Українська" },
  { code: "ar", name: "العربية" },
  { code: "hi", name: "हिन्दी" },
  { code: "tl", name: "Tagalog" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "zh-CN", name: "中文（简体）" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "ht", name: "Kreyòl ayisyen" },
];

const CODES = new Set(LANGUAGES.map((l) => l.code));

export function isSupportedLanguage(code: string): boolean {
  return CODES.has(code);
}

export function translationEnabled(): boolean {
  return Boolean(process.env.GOOGLE_TRANSLATE_API_KEY);
}

/** Returns the translated text, or throws if Google is unreachable. Never sends the API key in the URL. */
export async function translateText(text: string, target: string, source: string): Promise<string> {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error("Translation is not configured");
  const res = await fetch("https://translation.googleapis.com/language/translate/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": key },
    body: JSON.stringify({ q: text, source, target, format: "text" }),
  });
  if (!res.ok) throw new Error(`Translation failed (${res.status})`);
  const data = (await res.json()) as { data: { translations: Array<{ translatedText: string }> } };
  return data.data.translations[0].translatedText;
}
