export const GA_MEASUREMENT_ID = "G-HHYSX8GQ95";
export const GA_PRODUCTION_HOST = "god-of-subway.vercel.app";

const SCRIPT_MARKER = "data-jigeumta-ga";
const ONCE_PREFIX = "jigeumta_ga_once:";
const fallbackOnce = new Set<string>();

type AnalyticsParameters = Record<string, unknown>;
export type GtagFunction = (...args: unknown[]) => void;

export interface AnalyticsWindow {
  dataLayer?: unknown[][];
  gtag?: GtagFunction;
  location: { hostname: string };
  sessionStorage?: Pick<Storage, "getItem" | "setItem">;
  __jigeumtaAnalyticsInitialized?: boolean;
}

export interface AnalyticsDocument {
  createElement(tagName: "script"): HTMLScriptElement;
  head: Pick<HTMLHeadElement, "appendChild">;
  querySelector(selectors: string): Element | null;
}

declare global {
  interface Window {
    dataLayer?: unknown[][];
    gtag?: GtagFunction;
    __jigeumtaAnalyticsInitialized?: boolean;
  }
}

export function initializeAnalytics(
  targetWindow: AnalyticsWindow = window,
  targetDocument: AnalyticsDocument = document,
  now: Date = new Date(),
): void {
  if (targetWindow.__jigeumtaAnalyticsInitialized) return;

  const queue = targetWindow.dataLayer ?? [];
  targetWindow.dataLayer = queue;
  targetWindow.gtag = (...args: unknown[]): void => { queue.push(args); };
  targetWindow.__jigeumtaAnalyticsInitialized = true;

  targetWindow.gtag("js", now);
  if (targetWindow.location.hostname !== GA_PRODUCTION_HOST) {
    targetWindow.gtag("set", { traffic_type: "internal", debug_mode: true });
  }
  targetWindow.gtag("config", GA_MEASUREMENT_ID);

  if (targetDocument.querySelector(`script[${SCRIPT_MARKER}]`)) return;
  const script = targetDocument.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  script.setAttribute(SCRIPT_MARKER, "");
  targetDocument.head.appendChild(script);
}

export function track(name: string, params: AnalyticsParameters = {}, targetWindow: AnalyticsWindow = window): void {
  try { targetWindow.gtag?.("event", name, params); } catch { /* analytics is optional */ }
}

export function trackOnce(name: string, key: string, params: AnalyticsParameters = {}, targetWindow: AnalyticsWindow = window): void {
  const token = `${ONCE_PREFIX}${name}:${key}`;
  try {
    if (targetWindow.sessionStorage?.getItem(token)) return;
    targetWindow.sessionStorage?.setItem(token, "1");
  } catch {
    if (fallbackOnce.has(token)) return;
    fallbackOnce.add(token);
  }
  track(name, params, targetWindow);
}
