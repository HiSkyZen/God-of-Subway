import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiClient, ApiError } from "./api";
import type { LiveTripState, PushPublicKeyResponse } from "./contract";
import { buildPushAlertRequest, markAlertCancellationPending, pushAlertStatusIsActive, pushTripSnapshot, shouldReconcilePushOnVisibility } from "./push-alert";
import { detectPushCapabilities, pushSubscriptionSyncPayload, reconcilePushSubscription } from "./push";
import { watchForInstalledUpdate } from "./pwa";
import { isRecord, readStorage, STORAGE_KEYS, writeStorage } from "./storage";

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

export type PushPermissionState = "unsupported" | "default" | "granted" | "denied";

export interface StoredPushAlert {
  alert_id: string;
  subscription_endpoint: string;
  destination: string;
  threshold_seconds: number;
  expires_at?: string;
  notification_tag?: string;
  trip_snapshot?: string;
  pending_cancel?: boolean;
}

export interface PushPwaController {
  pushSheet: boolean;
  setPushSheet: Dispatch<SetStateAction<boolean>>;
  pushState: PushPermissionState;
  arrivalAlertCapable: boolean | null;
  pushAlert: StoredPushAlert | null;
  installEvent: BeforeInstallPromptEvent | null;
  showInstallSheet: boolean;
  setShowInstallSheet: Dispatch<SetStateAction<boolean>>;
  updateReady: boolean;
  install(): Promise<void>;
  requestPush(): Promise<void>;
  clearArrivalAlert(quiet?: boolean): Promise<void>;
  syncArrivalAlert(trip: LiveTripState, quiet?: boolean): Promise<StoredPushAlert | null>;
  registerArrivalAlert(trip: LiveTripState | null): Promise<void>;
}

function isStoredPushAlert(value: unknown): value is StoredPushAlert {
  return isRecord(value) && typeof value.alert_id === "string" && typeof value.subscription_endpoint === "string" && typeof value.destination === "string" && typeof value.threshold_seconds === "number"
    && (value.expires_at === undefined || typeof value.expires_at === "string") && (value.notification_tag === undefined || typeof value.notification_tag === "string") && (value.trip_snapshot === undefined || typeof value.trip_snapshot === "string")
    && (value.pending_cancel === undefined || typeof value.pending_cancel === "boolean");
}

export function usePushPwa(notify: (message: string) => void, serviceWorkerPath = "/sw.js"): PushPwaController {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [pushSheet, setPushSheet] = useState(false);
  const [pushState, setPushState] = useState<PushPermissionState>("default");
  const [arrivalAlertCapable, setArrivalAlertCapable] = useState<boolean | null>(null);
  const [pushAlert, setPushAlert] = useState<StoredPushAlert | null>(() => readStorage<StoredPushAlert | null>(localStorage, STORAGE_KEYS.pushAlert, null, (value): value is StoredPushAlert | null => value === null || isStoredPushAlert(value)));
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallSheet, setShowInstallSheet] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const pushStateRef = useRef(pushState);
  const capableRef = useRef(arrivalAlertCapable);
  const pushAlertRef = useRef(pushAlert);
  const installEventRef = useRef(installEvent);
  pushStateRef.current = pushState;
  capableRef.current = arrivalAlertCapable;
  pushAlertRef.current = pushAlert;
  installEventRef.current = installEvent;

  const updatePushState = useCallback((next: PushPermissionState): void => { pushStateRef.current = next; setPushState(next); }, []);
  const updatePushAlert = useCallback((next: StoredPushAlert | null): void => { pushAlertRef.current = next; setPushAlert(next); }, []);

  const clearArrivalAlert = useCallback(async (quiet = false): Promise<void> => {
    const stored = pushAlertRef.current || readStorage<StoredPushAlert | null>(localStorage, STORAGE_KEYS.pushAlert, null, (value): value is StoredPushAlert | null => value === null || isStoredPushAlert(value));
    const token = localStorage.getItem(STORAGE_KEYS.pushManagement);
    const endpoint = localStorage.getItem(STORAGE_KEYS.pushEndpoint) || stored?.subscription_endpoint;
    try {
      if (stored && (!token || !endpoint)) throw new Error("알림 관리 정보를 찾을 수 없습니다.");
      if (stored && token && endpoint) await apiClient.deletePushAlert({ alert_id: stored.alert_id, subscription_endpoint: endpoint, management_token: token });
      localStorage.removeItem(STORAGE_KEYS.pushAlert);
      updatePushAlert(null);
      if (!quiet) notifyRef.current("도착 알림을 해제했습니다.");
    } catch (caught: unknown) {
      if (stored) {
        const pending = markAlertCancellationPending(stored);
        writeStorage(localStorage, STORAGE_KEYS.pushAlert, pending);
        updatePushAlert(pending);
      }
      if (!quiet) notifyRef.current(caught instanceof Error ? `도착 알림 해제 실패: ${caught.message}` : "도착 알림 해제에 실패했습니다.");
      throw caught;
    }
  }, [updatePushAlert]);

  const syncArrivalAlert = useCallback(async (trip: LiveTripState, quiet = false): Promise<StoredPushAlert | null> => {
    if (trip.phase !== "ride" || !trip.boardedTrainNo) return null;
    if (capableRef.current === false) { if (!quiet) notifyRef.current("이 배포 환경에서는 백그라운드 도착 알림을 지원하지 않습니다."); return null; }
    const endpoint = localStorage.getItem(STORAGE_KEYS.pushEndpoint);
    const token = localStorage.getItem(STORAGE_KEYS.pushManagement);
    if (pushStateRef.current !== "granted" || !endpoint || !token) {
      if (!quiet) { setPushSheet(true); notifyRef.current("먼저 도착 알림 권한을 허용해 주세요."); }
      return null;
    }
    const destination = trip.segments.at(-1)?.to || "";
    try {
      const saved = await apiClient.savePushAlert(buildPushAlertRequest({ trip, subscriptionEndpoint: endpoint, managementToken: token, destination }));
      const next: StoredPushAlert = { alert_id: saved.alert_id, subscription_endpoint: endpoint, destination, threshold_seconds: saved.threshold_seconds, expires_at: saved.expires_at, notification_tag: saved.notification_tag, trip_snapshot: pushTripSnapshot(trip), pending_cancel: false };
      writeStorage(localStorage, STORAGE_KEYS.pushAlert, next);
      updatePushAlert(next);
      if (!quiet) notifyRef.current(`${destination} 도착 전 알림을 설정했습니다.`);
      return next;
    } catch (caught: unknown) {
      if (!quiet) notifyRef.current(caught instanceof Error ? `도착 알림 설정 실패: ${caught.message}` : "도착 알림 설정에 실패했습니다.");
      return null;
    }
  }, [updatePushAlert]);

  const registerArrivalAlert = useCallback(async (trip: LiveTripState | null): Promise<void> => {
    if (!trip) { notifyRef.current("먼저 이 열차를 탔어요를 눌러 추적을 시작하세요."); return; }
    await syncArrivalAlert(trip);
  }, [syncArrivalAlert]);

  const requestPush = useCallback(async (): Promise<void> => {
    const capabilities = detectPushCapabilities({ notification: "Notification" in window, serviceWorker: "serviceWorker" in navigator, pushManager: "PushManager" in window });
    if (!capabilities.supported) { updatePushState("unsupported"); notifyRef.current("이 브라우저에서는 도착 알림을 사용할 수 없습니다."); return; }
    try {
      const registration = await navigator.serviceWorker.ready;
      if (pushStateRef.current === "granted") {
        const existing = await registration.pushManager.getSubscription();
        if (pushAlertRef.current) {
          try { await clearArrivalAlert(); } catch { return; }
        }
        const endpoint = existing?.endpoint || localStorage.getItem(STORAGE_KEYS.pushEndpoint);
        const managementToken = localStorage.getItem(STORAGE_KEYS.pushManagement);
        if (endpoint && managementToken) await apiClient.deletePushSubscription({ endpoint, management_token: managementToken });
        if (existing) await existing.unsubscribe();
        localStorage.removeItem(STORAGE_KEYS.pushEndpoint);
        localStorage.removeItem(STORAGE_KEYS.pushManagement);
        updatePushState("default");
        notifyRef.current("도착 알림을 껐습니다.");
        return;
      }
      const permission = await Notification.requestPermission();
      updatePushState(permission);
      if (permission !== "granted") { notifyRef.current(permission === "denied" ? "브라우저 설정에서 알림을 허용해 주세요." : "알림 권한이 아직 허용되지 않았습니다."); return; }
      const keyResponse = await apiClient.get<PushPublicKeyResponse>("/api/push/public-key");
      capableRef.current = Boolean(keyResponse.arrival_alert_capable ?? keyResponse.capable);
      setArrivalAlertCapable(capableRef.current);
      if (!keyResponse.capable || !keyResponse.public_key) { updatePushState("default"); notifyRef.current("알림 서버가 아직 구성되지 않았습니다."); return; }
      const storedRegistration = { endpoint: localStorage.getItem(STORAGE_KEYS.pushEndpoint), managementToken: localStorage.getItem(STORAGE_KEYS.pushManagement) };
      const reconciled = await reconcilePushSubscription(registration, keyResponse.public_key, storedRegistration, async (subscription, stored) => {
        const saved = await apiClient.savePushSubscription(pushSubscriptionSyncPayload(subscription, stored));
        if (!saved.ok || !saved.management_token) throw new Error("알림 구독을 저장하지 못했습니다.");
        return saved;
      });
      localStorage.setItem(STORAGE_KEYS.pushEndpoint, reconciled.subscription.endpoint);
      if (!reconciled.managementToken) throw new Error("알림 구독 관리 토큰이 없습니다.");
      localStorage.setItem(STORAGE_KEYS.pushManagement, reconciled.managementToken);
      updatePushState("granted");
      setPushSheet(false);
      notifyRef.current(keyResponse.arrival_alert_capable === false ? "알림 구독을 저장했습니다. 이 환경에서는 백그라운드 도착 알림을 지원하지 않습니다." : "알림을 켰습니다.");
    } catch (caught: unknown) {
      const message = caught instanceof ApiError && caught.status === 422 ? "알림 서버가 아직 구성되지 않았습니다." : caught instanceof Error ? `알림 설정 실패: ${caught.message}` : "알림 설정에 실패했습니다.";
      updatePushState("default");
      notifyRef.current(message);
      setPushSheet(true);
    }
  }, [clearArrivalAlert, updatePushState]);

  const install = useCallback(async (): Promise<void> => {
    const event = installEventRef.current;
    if (!event) return;
    await event.prompt();
    installEventRef.current = null;
    setInstallEvent(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    const handleBeforeInstallPrompt = (event: BeforeInstallPromptEvent): void => { event.preventDefault(); installEventRef.current = event; setInstallEvent(event); };
    const handleControllerChange = (): void => setUpdateReady(false);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    if ("Notification" in window) updatePushState(Notification.permission); else updatePushState("unsupported");

    const reconcileExistingPush = async (): Promise<void> => {
      const response = await apiClient.get<PushPublicKeyResponse>("/api/push/public-key");
      if (!mounted) return;
      capableRef.current = Boolean(response.arrival_alert_capable ?? response.capable);
      setArrivalAlertCapable(capableRef.current);
      if (!("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator) || !response.capable || !response.public_key) return;
      try {
        const registration = await navigator.serviceWorker.ready;
        const storedRegistration = { endpoint: localStorage.getItem(STORAGE_KEYS.pushEndpoint), managementToken: localStorage.getItem(STORAGE_KEYS.pushManagement) };
        const reconciled = await reconcilePushSubscription(registration, response.public_key, storedRegistration, async (subscription, stored) => apiClient.savePushSubscription(pushSubscriptionSyncPayload(subscription, stored)));
        if (!mounted) return;
        localStorage.setItem(STORAGE_KEYS.pushEndpoint, reconciled.endpoint || reconciled.subscription.endpoint);
        if (reconciled.managementToken) localStorage.setItem(STORAGE_KEYS.pushManagement, reconciled.managementToken);
        updatePushState(reconciled.managementToken ? "granted" : "default");
      } catch { if (mounted) updatePushState("default"); }
    };
    void reconcileExistingPush().catch(() => { if (mounted) { capableRef.current = false; setArrivalAlertCapable(false); } });

    const standalone = window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) setShowInstallSheet(true);

    let stopUpdateWatch = (): void => undefined;
    let registered = false;
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register(serviceWorkerPath).then((registration) => {
        if (!mounted) return;
        registered = true;
        stopUpdateWatch = watchForInstalledUpdate(registration, () => Boolean(navigator.serviceWorker.controller), () => setUpdateReady(true));
        navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
      }).catch(() => undefined);
    }
    return () => {
      mounted = false;
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      stopUpdateWatch();
      if (registered) navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, [serviceWorkerPath, updatePushState]);

  useEffect(() => {
    if (!pushAlert) return undefined;
    let cancelled = false;
    if (pushAlert.pending_cancel) {
      const retryCancellation = (): void => { void clearArrivalAlert(true).catch(() => undefined); };
      const handleVisibility = (): void => { if (shouldReconcilePushOnVisibility(document.visibilityState)) retryCancellation(); };
      retryCancellation();
      window.addEventListener("focus", retryCancellation);
      document.addEventListener("visibilitychange", handleVisibility);
      return () => { cancelled = true; window.removeEventListener("focus", retryCancellation); document.removeEventListener("visibilitychange", handleVisibility); };
    }
    const token = localStorage.getItem(STORAGE_KEYS.pushManagement);
    const endpoint = localStorage.getItem(STORAGE_KEYS.pushEndpoint) || pushAlert.subscription_endpoint;
    if (!token || !endpoint) return undefined;
    const reconcileStatus = async (): Promise<void> => {
      try {
        const status = await apiClient.pushAlertStatus({ alert_id: pushAlert.alert_id, subscription_endpoint: endpoint, management_token: token });
        if (cancelled) return;
        const current = readStorage<StoredPushAlert | null>(localStorage, STORAGE_KEYS.pushAlert, null, (value): value is StoredPushAlert | null => value === null || isStoredPushAlert(value));
        if (!current || current.alert_id !== pushAlert.alert_id) return;
        if (!pushAlertStatusIsActive(status, new Date())) { localStorage.removeItem(STORAGE_KEYS.pushAlert); updatePushAlert(null); return; }
        const reconciled = { ...current, expires_at: status.expires_at || current.expires_at, notification_tag: status.notification_tag };
        writeStorage(localStorage, STORAGE_KEYS.pushAlert, reconciled);
        updatePushAlert(reconciled);
      } catch { /* retain local state until authenticated reconciliation succeeds */ }
    };
    const handleFocus = (): void => { void reconcileStatus(); };
    const handleVisibility = (): void => { if (shouldReconcilePushOnVisibility(document.visibilityState)) void reconcileStatus(); };
    void reconcileStatus();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => { cancelled = true; window.removeEventListener("focus", handleFocus); document.removeEventListener("visibilitychange", handleVisibility); };
  }, [pushAlert?.alert_id, pushAlert?.pending_cancel, pushState, clearArrivalAlert, updatePushAlert]);

  return { pushSheet, setPushSheet, pushState, arrivalAlertCapable, pushAlert, installEvent, showInstallSheet, setShowInstallSheet, updateReady, install, requestPush, clearArrivalAlert, syncArrivalAlert, registerArrivalAlert };
}
