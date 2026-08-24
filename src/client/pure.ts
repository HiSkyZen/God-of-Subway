import type { RouteSegment, ServiceMode } from "./contract";

export const CHOSEONG = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"] as const;
const JUNGSEONG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"] as const;
const JONGSEONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"] as const;
const JAMO_TO_COMPAT: Record<string,string> = {
  "ᄀ":"ㄱ","ᄁ":"ㄲ","ᄂ":"ㄴ","ᄃ":"ㄷ","ᄄ":"ㄸ","ᄅ":"ㄹ","ᄆ":"ㅁ","ᄇ":"ㅂ","ᄈ":"ㅃ","ᄉ":"ㅅ","ᄊ":"ㅆ","ᄋ":"ㅇ","ᄌ":"ㅈ","ᄍ":"ㅉ","ᄎ":"ㅊ","ᄏ":"ㅋ","ᄐ":"ㅌ","ᄑ":"ㅍ","ᄒ":"ㅎ",
  "ᅡ":"ㅏ","ᅢ":"ㅐ","ᅣ":"ㅑ","ᅤ":"ㅒ","ᅥ":"ㅓ","ᅦ":"ㅔ","ᅧ":"ㅕ","ᅨ":"ㅖ","ᅩ":"ㅗ","ᅪ":"ㅘ","ᅫ":"ㅙ","ᅬ":"ㅚ","ᅭ":"ㅛ","ᅮ":"ㅜ","ᅯ":"ㅝ","ᅰ":"ㅞ","ᅱ":"ㅟ","ᅲ":"ㅠ","ᅳ":"ㅡ","ᅴ":"ㅢ","ᅵ":"ㅣ",
  "ᆨ":"ㄱ","ᆩ":"ㄲ","ᆪ":"ㄳ","ᆫ":"ㄴ","ᆬ":"ㄵ","ᆭ":"ㄶ","ᆮ":"ㄷ","ᆯ":"ㄹ","ᆰ":"ㄺ","ᆱ":"ㄻ","ᆲ":"ㄼ","ᆳ":"ㄽ","ᆴ":"ㄾ","ᆵ":"ㄿ","ᆶ":"ㅀ","ᆷ":"ㅁ","ᆸ":"ㅂ","ᆹ":"ㅄ","ᆺ":"ㅅ","ᆻ":"ㅆ","ᆼ":"ㅇ","ᆽ":"ㅈ","ᆾ":"ㅊ","ᆿ":"ㅋ","ᇀ":"ㅌ","ᇁ":"ㅍ","ᇂ":"ㅎ",
};

export function stationInitials(text: string): string {
  return [...String(text || "").normalize("NFC")].map((ch) => { const code = ch.charCodeAt(0); return code >= 0xac00 && code <= 0xd7a3 ? CHOSEONG[Math.floor((code - 0xac00) / 588)] : ch; }).join("");
}

/** Convert completed and currently-composing Hangul into one comparable IME prefix stream. */
export function stationImeKey(text: string): string {
  let output = "";
  for (const ch of [...String(text || "").trim().normalize("NFC")]) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      output += CHOSEONG[Math.floor(offset / 588)];
      output += JUNGSEONG[Math.floor((offset % 588) / 28)];
      output += JONGSEONG[offset % 28];
    } else output += JAMO_TO_COMPAT[ch] || ch.toLocaleLowerCase("ko-KR");
  }
  return output;
}

export function stationMatches(name: string, query: string): boolean {
  const q = String(query || "").trim().normalize("NFC"); if (!q) return false;
  const n = String(name || "").trim().normalize("NFC");
  const lowerName = n.toLocaleLowerCase("ko-KR"); const lowerQuery = q.toLocaleLowerCase("ko-KR");
  if (lowerName.startsWith(lowerQuery)) return true;
  if (/^[ㄱ-ㅎ]+$/.test(q) && stationInitials(n).startsWith(q)) return true;
  return stationImeKey(n).startsWith(stationImeKey(q));
}

export function parseServiceModeSelection(value: string): ServiceMode { return value === "DAY" || value === "SAT" || value === "END" ? value : "AUTO"; }
export function parseLocalDateTime(value: string | null | undefined): Date | null { if (!value) return null; const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/); if (!match) return null; return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)); }
export function localDateTimeString(date: Date): string { const p = (value: number): string => String(value).padStart(2, "0"); return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`; }
export function minutesDiff(a: string | null | undefined, b: string | null | undefined): number | null { const da = parseLocalDateTime(a); const db = parseLocalDateTime(b); return da && db ? (da.getTime() - db.getTime()) / 60000 : null; }
export function addMinutesToDateTime(value: string | null | undefined, minutes: number | null | undefined): string | null { const date = parseLocalDateTime(value); if (!date || minutes == null || !Number.isFinite(minutes)) return null; date.setMinutes(date.getMinutes() + minutes); return localDateTimeString(date); }
export function formatDuration(seconds: number): string { const minutes = Math.round(Math.max(0, Number(seconds) || 0) / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`; }
export function escapeHtml(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? ""); }
export function compactSegments(segments: RouteSegment[]): RouteSegment[] { return (segments || []).map((segment, index) => ({ index, line: segment.line, from: segment.from, to: segment.to, train_no: segment.train_no || "", origin: segment.origin || "", destination: segment.destination || "", service: segment.service || "", confidence: segment.confidence || "", delay_seconds: Number(segment.delay_seconds) || 0, board_dt: segment.board_dt || "", alight_dt: segment.alight_dt || "" })); }
