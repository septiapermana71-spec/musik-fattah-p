(() => {
  'use strict';

  const installButton = document.getElementById('installButton');
  let deferredPrompt = null;
  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function toast(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
    else window.alert(message);
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js', { scope: './', updateViaCache: 'none' })
        .then((registration) => registration.update().catch(() => {}))
        .catch((error) => console.warn('Service worker belum dapat diaktifkan:', error));
    }, { once: true });
  }

  if (!installButton) return;
  installButton.hidden = isStandalone();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installButton.hidden = isStandalone();
    installButton.textContent = 'Install APK';
    installButton.setAttribute('aria-label', 'Install APK Music Fattah AI');
  });

  installButton.addEventListener('click', async () => {
    if (isStandalone()) {
      installButton.hidden = true;
      toast('Music Fattah AI sudah terpasang di perangkat ini.');
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (choice?.outcome === 'accepted') {
        installButton.hidden = true;
        toast('Permintaan pemasangan aplikasi diterima.');
      } else {
        toast('Pemasangan dibatalkan. Kamu bisa memasangnya nanti dari tombol ini.');
      }
      return;
    }
    if (isAppleMobile) {
      toast('Di Safari: ketuk tombol Bagikan, lalu pilih “Tambahkan ke Layar Utama”.');
    } else {
      toast('Buka menu browser ⋮ lalu pilih “Instal aplikasi” atau “Tambahkan ke layar utama”.');
    }
  });

  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
    deferredPrompt = null;
    toast('Music Fattah AI berhasil dipasang.');
  });
})();
