/* Remove a stale worker once so an old cached App Router document cannot block hydration. */
(() => {
  const recoveryKey = "globebridge-sw-recovered-v1";
  if (!("serviceWorker" in navigator) || sessionStorage.getItem(recoveryKey)) return;

  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      if (registrations.length === 0) return false;
      return Promise.all(registrations.map((registration) => registration.unregister())).then(() =>
        caches
          .keys()
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith("globebridge-")) .map((key) => caches.delete(key))))
          .then(() => true),
      );
    })
    .then((didRecover) => {
      sessionStorage.setItem(recoveryKey, "1");
      if (didRecover) window.location.reload();
    })
    .catch(() => sessionStorage.setItem(recoveryKey, "1"));
})();
