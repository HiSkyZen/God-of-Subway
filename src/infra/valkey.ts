import { RedisClient, type RedisOptions } from "bun";

export interface ValkeyCommandTransport {
  command<T = unknown>(args: readonly string[]): Promise<T>;
}

const allowedProtocols = new Set(["redis:", "rediss:", "valkey:", "valkeys:"]);
let nativeClient: RedisClient | null = null;
let nativeClientUrl = "";
let overrideTransport: ValkeyCommandTransport | null | undefined;

export const nativeValkeyClientOptions = {
  autoReconnect: true,
  enableAutoPipelining: true,
  // Commands issued during a serverless cold start must wait for TCP/TLS + HELLO/AUTH.
  // Disabling the offline queue makes Bun reject those first commands while status=Connecting.
  enableOfflineQueue: true,
  connectionTimeout: 2_500,
  maxRetries: 2,
} satisfies RedisOptions;

export function configuredValkeyUrl(): string | null {
  const raw = (Bun.env.VALKEY_URL || Bun.env.REDIS_URL || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!allowedProtocols.has(parsed.protocol) || !parsed.hostname || parsed.hash) return null;
    return raw;
  } catch {
    return null;
  }
}

export function valkeyConfigured(): boolean {
  return overrideTransport !== undefined ? overrideTransport !== null : configuredValkeyUrl() !== null;
}

function nativeTransport(): ValkeyCommandTransport | null {
  if (overrideTransport !== undefined) return overrideTransport;
  const url = configuredValkeyUrl();
  if (!url) return null;
  if (!nativeClient || nativeClientUrl !== url) {
    nativeClient = new RedisClient(url, nativeValkeyClientOptions);
    nativeClientUrl = url;
  }
  return {
    command: async <T>(args: readonly string[]): Promise<T> => {
      if (args.length === 0) throw new Error("Valkey command is required");
      return nativeClient!.send(args[0], [...args.slice(1)]) as Promise<T>;
    },
  };
}

export function valkeyTransport(): ValkeyCommandTransport | null {
  return nativeTransport();
}

export async function valkeyCommand<T = unknown>(args: readonly string[]): Promise<T> {
  const transport = nativeTransport();
  if (!transport) throw new Error("VALKEY_URL or REDIS_URL is not configured");
  return transport.command<T>(args);
}

export function setValkeyTransportForTests(transport: ValkeyCommandTransport | null | undefined): void {
  overrideTransport = transport;
}

export function resetValkeyRuntimeForTests(): void {
  overrideTransport = undefined;
  nativeClient = null;
  nativeClientUrl = "";
}
