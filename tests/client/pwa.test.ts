import { describe, expect, test } from "bun:test";
import { watchForInstalledUpdate } from "../../src/client/pwa";

describe("PWA update readiness", () => {
  test("waits for an installed worker and an existing controller", () => {
    const workerTarget = new EventTarget();
    const registrationTarget = new EventTarget();
    let state: ServiceWorkerState = "installing";
    let controlled = false;
    let readyCount = 0;
    Object.defineProperty(workerTarget, "state", { configurable: true, get: () => state });
    const worker = workerTarget as ServiceWorker;
    const registration = Object.assign(registrationTarget, { installing: worker, waiting: null }) as unknown as ServiceWorkerRegistration;
    const cleanup = watchForInstalledUpdate(registration, () => controlled, () => { readyCount += 1; });

    registrationTarget.dispatchEvent(new Event("updatefound"));
    expect(readyCount).toBe(0);
    state = "installed";
    workerTarget.dispatchEvent(new Event("statechange"));
    expect(readyCount).toBe(0);
    controlled = true;
    workerTarget.dispatchEvent(new Event("statechange"));
    expect(readyCount).toBe(1);
    cleanup();
    workerTarget.dispatchEvent(new Event("statechange"));
    expect(readyCount).toBe(1);
  });
});
