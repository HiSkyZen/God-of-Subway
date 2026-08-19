import { describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "../../src/client/api";

describe("client API error boundary", () => {
  test("returns typed JSON envelopes", async () => {
    const client = new ApiClient({ fetchImpl: async () => new Response(JSON.stringify({ ok: true, stations: { "2호선": ["강남"] } }), { status: 200 }) });
    const response = await client.stations();
    expect(response.stations["2호선"]).toEqual(["강남"]);
  });

  test("surfaces server errors with status and payload", async () => {
    const client = new ApiClient({ fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "요청 실패" }), { status: 400 }) });
    const promise = client.get("/api/health");
    await expect(promise).rejects.toMatchObject({ name: "ApiError", status: 400, message: "요청 실패" });
  });

  test("keeps generic GET transport-only for successful capability responses", async () => {
    const payload = {
      ok: true,
      capable: false,
      configuration_message: "Valkey/Redis 푸시 저장소가 구성되지 않았습니다.",
      public_key: null,
    };
    const client = new ApiClient({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
    await expect(client.get("/api/push/public-key")).resolves.toEqual(payload);
  });

  test("surfaces exact push configuration diagnostics instead of a generic server message", async () => {
    const payload = {
      ok: true,
      capable: false,
      subscription_capable: false,
      arrival_alert_capable: false,
      scheduler_mode: null,
      configuration_issues: ["storage_unavailable", "scheduler_unavailable"],
      configuration_message: "Valkey/Redis 푸시 저장소가 구성되지 않았습니다.",
      public_key: null,
    };
    const client = new ApiClient({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
    await expect(client.pushPublicKey()).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      message: "Valkey/Redis 푸시 저장소가 구성되지 않았습니다.",
      payload,
    });
  });

  test("aborts requests after the configured timeout", async () => {
    const client = new ApiClient({ defaultTimeoutMs: 15, fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }) });
    await expect(client.get("/api/health")).rejects.toBeInstanceOf(ApiError);
    await expect(client.get("/api/health")).rejects.toThrow("20초를 초과");
  });

  test("posts push alert ownership status without putting the management token in the URL", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = new ApiClient({ fetchImpl: async (url, init) => {
      capturedUrl = String(url); capturedInit = init;
      return new Response(JSON.stringify({ ok: true, capable: true, alert_id: "alert-1", active: true, status: "active", expires_at: null, notification_tag: "arrival-alert-1" }));
    } });
    await client.pushAlertStatus({ alert_id: "alert-1", subscription_endpoint: "https://push.example/e", management_token: "secret-token" });
    expect(capturedUrl).toBe("/api/push/alerts/status");
    expect(capturedUrl).not.toContain("secret-token");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ management_token: "secret-token" });
  });
});
