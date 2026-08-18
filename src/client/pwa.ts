type UpdateRegistration = Pick<ServiceWorkerRegistration, "installing" | "waiting" | "addEventListener" | "removeEventListener">;

export function watchForInstalledUpdate(
  registration: UpdateRegistration,
  hasController: () => boolean,
  onReady: () => void,
): () => void {
  let installing: ServiceWorker | null = null;
  let readySignaled = false;
  const handleStateChange = (): void => {
    if (installing?.state === "installed" && hasController() && !readySignaled) { readySignaled = true; onReady(); }
  };
  const watchInstalling = (): void => {
    installing?.removeEventListener("statechange", handleStateChange);
    installing = registration.installing;
    readySignaled = false;
    installing?.addEventListener("statechange", handleStateChange);
    handleStateChange();
  };
  const handleUpdateFound = (): void => { watchInstalling(); };

  registration.addEventListener("updatefound", handleUpdateFound);
  if (registration.waiting && hasController()) onReady();
  else if (registration.installing) watchInstalling();

  return () => {
    registration.removeEventListener("updatefound", handleUpdateFound);
    installing?.removeEventListener("statechange", handleStateChange);
  };
}
