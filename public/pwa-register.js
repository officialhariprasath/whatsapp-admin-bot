if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      let refreshing = false;
      let waitingWorker = null;

      const emit = (name) => document.dispatchEvent(new CustomEvent(name));

      const registration = await navigator.serviceWorker.register("/sw.js");

      const markWaiting = (worker) => {
        if (!worker) return;
        waitingWorker = worker;
        emit("pwa:update-available");
      };

      if (registration.waiting) markWaiting(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            markWaiting(worker);
          }
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        emit("pwa:update-applied");
        window.location.reload();
      });

      window.__applyPwaUpdate = () => {
        if (waitingWorker) {
          waitingWorker.postMessage({ type: "SKIP_WAITING" });
          return true;
        }
        return false;
      };

      // Poll for new SW periodically so users get updates quickly.
      setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 1000);
    } catch (err) {
      console.error("Service worker registration failed:", err);
    }
  });
}
