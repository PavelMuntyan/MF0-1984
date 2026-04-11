/* Sync early boot: theme from localStorage / system; viewport --app-vh. Runs before app bundle (no module). */
(function () {
  try {
    var k = "ai-biz-os-theme";
    var v = localStorage.getItem(k);
    var dark =
      v === "dark" ? true : v === "light" ? false : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {
    document.documentElement.classList.remove("dark");
  }
})();
(function () {
  function syncAppViewportHeight() {
    var h =
      window.visualViewport && window.visualViewport.height
        ? window.visualViewport.height
        : window.innerHeight;
    document.documentElement.style.setProperty("--app-vh", h + "px");
  }
  syncAppViewportHeight();
  window.addEventListener("resize", syncAppViewportHeight);
  window.addEventListener("orientationchange", function () {
    requestAnimationFrame(function () {
      requestAnimationFrame(syncAppViewportHeight);
    });
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAppViewportHeight);
  }
})();
