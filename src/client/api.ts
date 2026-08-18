import type { ApiEnvelope, AutoRouteRequest, AutoRouteResponse, HealthResponse, PushAlertRequest, PushAlertResponse, PushAlertStatusRequest, PushAlertStatusResponse, PushSubscriptionSaveResponse, RouteRequest, RouteResponse, StationsResponse, TripUpdateRequest, TripUpdateResponse } from "./contract";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: ApiEnvelope | null;

  constructor(message: string, status = 0, payload: ApiEnvelope | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export interface ApiClientOptions {
  fetchImpl?: FetchImplementation;
  defaultTimeoutMs?: number;
}

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly defaultTimeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    const defaultFetch: FetchImplementation = typeof window !== "undefined" ? window.fetch.bind(window) : fetch.bind(globalThis);
    this.fetchImpl = options.fetchImpl || defaultFetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 20_000;
  }

  async get<T extends ApiEnvelope>(url: string, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return this.request<T>(url, { cache: "no-store" }, timeoutMs);
  }

  async post<T extends ApiEnvelope>(url: string, body: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return this.request<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }, timeoutMs);
  }

  async delete<T extends ApiEnvelope>(url: string, body: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return this.request<T>(url, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }, timeoutMs);
  }

  private async request<T extends ApiEnvelope>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let payload: ApiEnvelope;
      try { payload = JSON.parse(text) as ApiEnvelope; }
      catch { throw new ApiError(`서버 응답 오류 (${response.status})`, response.status); }
      if (!response.ok || payload.ok !== true) throw new ApiError(payload.error || "요청 실패", response.status, payload);
      return payload as T;
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") throw new ApiError("조회가 20초를 초과했습니다. 잠시 후 다시 시도해 주세요.");
      if (error instanceof ApiError) throw error;
      throw error instanceof Error ? error : new ApiError(String(error));
    } finally { clearTimeout(timer); }
  }

  health(): Promise<HealthResponse> { return this.get<HealthResponse>("/api/health"); }
  stations(): Promise<StationsResponse> { return this.get<StationsResponse>("/api/stations"); }
  route(body: RouteRequest): Promise<RouteResponse> { return this.post<RouteResponse>("/api/route", body); }
  autoRoute(body: AutoRouteRequest): Promise<AutoRouteResponse> { return this.post<AutoRouteResponse>("/api/auto_route", body); }
  tripUpdate(body: TripUpdateRequest): Promise<TripUpdateResponse> { return this.post<TripUpdateResponse>("/api/trip_update", body); }
  savePushSubscription(body: unknown): Promise<PushSubscriptionSaveResponse> { return this.post<PushSubscriptionSaveResponse>("/api/push/subscriptions", body); }
  deletePushSubscription(body: unknown): Promise<ApiEnvelope> { return this.delete<ApiEnvelope>("/api/push/subscriptions", body); }
  savePushAlert(body: PushAlertRequest): Promise<PushAlertResponse> { return this.post<PushAlertResponse>("/api/push/alerts", body); }
  pushAlertStatus(body: PushAlertStatusRequest): Promise<PushAlertStatusResponse> { return this.post<PushAlertStatusResponse>("/api/push/alerts/status", body); }
  deletePushAlert(body: Pick<PushAlertRequest, "subscription_endpoint" | "management_token"> & { alert_id: string }): Promise<ApiEnvelope> { return this.delete<ApiEnvelope>("/api/push/alerts", body); }
}

export const apiClient = new ApiClient();
