export interface LanguageOption {
  code: string;
  name: string;
  /** Short label for transcript chips (e.g. "GU"). */
  short: string;
}

/** "They speak" / "Others hear me in" value meaning "detect it" (backend: source_lang "auto"). */
export const AUTO = "auto";

// Keep in sync with APP_LANGUAGES in backend/services/providers/registry.py.
export const LANGUAGES: LanguageOption[] = [
  { code: "en", name: "English", short: "EN" },
  { code: "es", name: "Spanish", short: "ES" },
  { code: "fr", name: "French", short: "FR" },
  { code: "de", name: "German", short: "DE" },
  { code: "it", name: "Italian", short: "IT" },
  { code: "pt", name: "Portuguese", short: "PT" },
  { code: "zh", name: "Chinese (Mandarin)", short: "ZH" },
  { code: "ja", name: "Japanese", short: "JA" },
  { code: "ko", name: "Korean", short: "KO" },
  { code: "ar", name: "Arabic", short: "AR" },
  { code: "hi", name: "Hindi", short: "HI" },
  { code: "gu", name: "Gujarati", short: "GU" },
  { code: "bn", name: "Bengali", short: "BN" },
  { code: "mr", name: "Marathi", short: "MR" },
  { code: "ta", name: "Tamil", short: "TA" },
  { code: "te", name: "Telugu", short: "TE" },
  { code: "kn", name: "Kannada", short: "KN" },
  { code: "ml", name: "Malayalam", short: "ML" },
  { code: "pa", name: "Punjabi", short: "PA" },
  { code: "ur", name: "Urdu", short: "UR" },
  { code: "ru", name: "Russian", short: "RU" },
  { code: "nl", name: "Dutch", short: "NL" },
  { code: "sv", name: "Swedish", short: "SV" },
  { code: "pl", name: "Polish", short: "PL" },
  { code: "tr", name: "Turkish", short: "TR" },
];

export function getLanguageByCode(code: string | null | undefined): LanguageOption | undefined {
  const base = (code || "").split("-")[0].toLowerCase();
  return LANGUAGES.find((l) => l.code === base);
}

/** Display name for a language code ("auto" → "Auto-detect"). */
export function langName(code: string | null | undefined): string {
  if (!code) return "";
  if (code === AUTO) return "Auto-detect";
  return getLanguageByCode(code)?.name ?? code.toUpperCase();
}

export function langShort(code: string | null | undefined): string {
  return getLanguageByCode(code)?.short ?? (code || "").slice(0, 2).toUpperCase();
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.split("-")[0].toLowerCase() === b.split("-")[0].toLowerCase();
}
