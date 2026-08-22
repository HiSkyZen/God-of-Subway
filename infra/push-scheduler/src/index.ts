interface Env {
  DISPATCH_URL: string;
  CRON_SECRET: string;
}

interface DispatchResponse {
  ok?: boolean;
  evaluated?: number;
  delivered?: number;
  removed?: number;
  failed?: number;
  has_more?: boolean;
  skipped?: boolean;
  reason?: string;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const response = await fetch(env.DISPATCH_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        Accept: "application/json",
        "User-Agent": "jigeumta-cloudflare-scheduler/1",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("Push dispatch failed", {
        status: response.status,
        body: text.slice(0, 1000),
        scheduledTime: controller.scheduledTime,
      });

      throw new Error(`Push dispatch returned HTTP ${response.status}`);
    }

    let result: DispatchResponse | null = null;

    try {
      result = JSON.parse(text) as DispatchResponse;
    } catch {
      console.error("Push dispatch returned invalid JSON", {
        body: text.slice(0, 1000),
      });

      throw new Error("Push dispatch returned invalid JSON");
    }

    console.log("Push dispatch completed", {
      evaluated: result.evaluated ?? 0,
      delivered: result.delivered ?? 0,
      removed: result.removed ?? 0,
      failed: result.failed ?? 0,
      hasMore: result.has_more ?? false,
      skipped: result.skipped ?? false,
      reason: result.reason ?? null,
    });

    if (result.ok === false) {
      throw new Error("Push dispatch completed with failures");
    }
  },
} satisfies ExportedHandler<Env>;