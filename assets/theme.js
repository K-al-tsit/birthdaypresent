/* Local-clock theme selection. This runs before CSS to avoid flashing the wrong theme. */
(function () {
  function chooseTheme(mode, hour, start, end) {
    if (mode === "day" || mode === "dusk") return mode;
    return hour >= start && hour < end ? "day" : "dusk";
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { chooseTheme };
    return;
  }
  const settings = window.SITE_CONTENT.settings;
  let stored = "auto";
  try { stored = localStorage.getItem("hc-sky-theme") || "auto"; } catch (_) {}
  const query = new URLSearchParams(location.search).get("theme");
  let mode = ["auto", "day", "dusk"].includes(query) ? query : ["auto", "day", "dusk"].includes(stored) ? stored : "auto";
  function apply() {
    const resolved = chooseTheme(mode, new Date().getHours(), settings.dayStartHour, settings.duskStartHour);
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]').content = resolved === "day" ? "#f4fbff" : "#27244f";
    const select = document.getElementById("themeSelect");
    if (select) select.value = mode;
  }
  window.SiteTheme = {
    getMode: () => mode,
    setMode(value) {
      mode = ["auto", "day", "dusk"].includes(value) ? value : "auto";
      try { localStorage.setItem("hc-sky-theme", mode); } catch (_) {}
      const url = new URL(location.href);
      if (url.searchParams.has("theme")) {
        url.searchParams.delete("theme");
        history.replaceState(null, "", url);
      }
      apply();
    }
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) apply(); });
  setInterval(apply, 60000);
}());
