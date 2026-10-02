/* Edit visible words and track details in content.js; this file only handles interactions. */
const content = window.SITE_CONTENT;
const tracks = content.tracks;
const $ = (id) => document.getElementById(id);
const text = (key, values = {}) => {
  const value = key.split(".").reduce((item, part) => item?.[part], content.copy);
  return String(value ?? "").replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
};
document.title = content.copy.page.title;
document.querySelector('meta[name="description"]').content = content.copy.page.description;
document.querySelectorAll("[data-copy]").forEach((el) => { el.textContent = text(el.dataset.copy); });
document.querySelectorAll("[data-label]").forEach((el) => { el.setAttribute("aria-label", text(el.dataset.label)); });

const audio = $("audio");
const grid = $("trackGrid");
const progress = $("progress");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let activeIndex = -1;
let toastTimer;
let selectionVersion = 0;
let scrubbing = false;
let motionEnabled = false;
const coverCache = new Map();
const coverObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries, observer) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    observer.unobserve(entry.target);
    const index = Number(entry.target.dataset.trackIndex);
    if (Number.isInteger(index)) loadCardCover(index);
  });
}, { rootMargin: "320px 0px" }) : null;

function synchsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}
function uint32be(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}
function findTerminator(bytes, start, end, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < end; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    return end;
  }
  for (let i = start; i < end; i += 1) if (bytes[i] === 0) return i;
  return end;
}
function deUnsync(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i += 1;
  }
  return new Uint8Array(out);
}
function parseEmbeddedCover(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return null;
  const version = bytes[3];
  if (version !== 3 && version !== 4) return null;
  const tagFlags = bytes[5];
  const tagEnd = Math.min(bytes.length, 10 + synchsafe(bytes, 6));
  let offset = 10;
  if (tagFlags & 0x40) {
    if (version === 3 && offset + 4 <= tagEnd) offset += 4 + uint32be(bytes, offset);
    else if (version === 4 && offset + 4 <= tagEnd) offset += synchsafe(bytes, offset);
  }
  while (offset + 10 <= tagEnd) {
    const id = ascii(bytes, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version === 4 ? synchsafe(bytes, offset + 4) : uint32be(bytes, offset + 4);
    const frameUnsync = version === 4 && Boolean(bytes[offset + 9] & 0x02);
    const frameStart = offset + 10;
    const frameEnd = Math.min(tagEnd, frameStart + frameSize);
    if (frameSize <= 0 || frameEnd <= frameStart) break;
    if (id === "APIC") {
      let frame = bytes.subarray(frameStart, frameEnd);
      if ((tagFlags & 0x80) || frameUnsync) frame = deUnsync(frame);
      const encoding = frame[0];
      let mimeEnd = 1;
      while (mimeEnd < frame.length && frame[mimeEnd] !== 0) mimeEnd += 1;
      const mime = new TextDecoder("latin1").decode(frame.subarray(1, mimeEnd)) || "image/jpeg";
      const descriptionStart = Math.min(frame.length, mimeEnd + 2);
      const descriptionEnd = findTerminator(frame, descriptionStart, frame.length, encoding);
      const imageStart = Math.min(frame.length, descriptionEnd + ((encoding === 1 || encoding === 2) ? 2 : 1));
      if (imageStart < frame.length) return new Blob([frame.slice(imageStart)], { type: mime });
      return null;
    }
    offset = frameEnd;
  }
  return null;
}
async function fetchId3Cover(src) {
  const probeEnd = 2 * 1024 * 1024 - 1;
  const first = await fetch(src, { headers: { Range: "bytes=0-" + probeEnd }, cache: "force-cache" });
  if (!first.ok && first.status !== 206) throw new Error("cover fetch failed: " + first.status);
  let buffer = await first.arrayBuffer();
  let bytes = new Uint8Array(buffer);
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return null;
  const tagBytes = 10 + synchsafe(bytes, 6);
  if (tagBytes > buffer.byteLength && first.status === 206) {
    const response = await fetch(src, { headers: { Range: "bytes=0-" + (tagBytes - 1) }, cache: "force-cache" });
    if (!response.ok && response.status !== 206) throw new Error("cover tag fetch failed: " + response.status);
    buffer = await response.arrayBuffer();
  }
  return parseEmbeddedCover(buffer);
}
function getCoverUrl(track) {
  if (!track?.src) return Promise.resolve(null);
  if (!coverCache.has(track.src)) {
    coverCache.set(track.src, fetchId3Cover(track.src).then((blob) => blob ? URL.createObjectURL(blob) : null).catch((error) => {
      console.warn("Embedded cover unavailable", error);
      return null;
    }));
  }
  return coverCache.get(track.src);
}
function updateMediaMetadata(track, coverUrl = null) {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
  navigator.mediaSession.metadata = track?.src ? new MediaMetadata({
    title: track.title,
    artist: track.subtitle,
    album: content.copy.page.title,
    artwork: coverUrl ? [{ src: coverUrl }] : []
  }) : null;
  if (!track?.src) navigator.mediaSession.playbackState = "none";
}
async function loadPlayerCover(track, version) {
  const image = $("playerCoverImage");
  const cover = $("playerCover");
  image.hidden = true;
  image.removeAttribute("src");
  cover.classList.remove("has-art");
  const coverUrl = await getCoverUrl(track);
  if (!coverUrl || version !== selectionVersion || tracks[activeIndex] !== track) return;
  image.src = coverUrl;
  image.hidden = false;
  cover.classList.add("has-art");
  updateMediaMetadata(track, coverUrl);
}
async function loadCardCover(index) {
  const track = tracks[index];
  if (!track?.src) return;
  const card = grid.children[index];
  const image = card?.querySelector(".track-cover img");
  const frame = card?.querySelector(".track-cover");
  if (!image || !frame || frame.classList.contains("ready")) return;
  const coverUrl = await getCoverUrl(track);
  if (!coverUrl) return;
  image.src = coverUrl;
  image.hidden = false;
  frame.classList.add("ready");
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}
function showToast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}
function setPlaying(playing) {
  $("playIcon").textContent = playing ? "❚❚" : "▶";
  $("playPause").setAttribute("aria-label", text(playing ? "player.pause" : "player.play"));
  document.body.classList.toggle("is-playing", playing);
  if ("mediaSession" in navigator && tracks[activeIndex]?.src) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}
function updateProgress() {
  if (scrubbing) return;
  const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
  progress.disabled = !hasDuration;
  progress.value = hasDuration ? audio.currentTime / audio.duration * 100 : 0;
  $("currentTime").textContent = formatTime(audio.currentTime);
  $("duration").textContent = formatTime(audio.duration);
  progress.setAttribute("aria-valuetext", text("player.time", { current: formatTime(audio.currentTime), duration: formatTime(audio.duration) }));
}
function playCurrent() {
  if (!tracks[activeIndex]?.src) { showToast(text("messages.emptyAudio")); return; }
  const version = selectionVersion;
  audio.play().catch((error) => {
    if (version !== selectionVersion || error.name === "AbortError") return;
    setPlaying(false);
    showToast(text(error.name === "NotAllowedError" ? "messages.blocked" : "messages.failed"));
  });
}
function selectTrack(index, { autoplay = false, notify = true } = {}) {
  if (!tracks.length) return;
  selectionVersion += 1;
  audio.pause();
  activeIndex = (index + tracks.length) % tracks.length;
  const track = tracks[activeIndex];
  audio.removeAttribute("src");
  scrubbing = false;
  progress.value = 0;
  progress.disabled = true;
  $("currentTime").textContent = $("duration").textContent = "0:00";
  $("playerIndex").textContent = track.no;
  $("playerTitle").textContent = track.title;
  $("playerNote").textContent = track.note;
  $("playerShell").classList.add("visible");
  $("playerShell").setAttribute("aria-hidden", "false");
  $("playerShell").inert = false;
  document.body.classList.add("has-player");
  Array.from(grid.children).forEach((card, i) => {
    card.classList.toggle("active", i === activeIndex);
    card.setAttribute("aria-pressed", String(i === activeIndex));
  });
  if (track.src) audio.src = track.src;
  audio.load();
  setPlaying(false);
  updateMediaMetadata(track);
  loadPlayerCover(track, selectionVersion);
  loadCardCover(activeIndex);
  if (track.src && autoplay) playCurrent();
  else if (!track.src && notify) showToast(text("messages.emptySelection", { no: track.no }));
}
tracks.forEach((track, index) => {
  const card = document.createElement("button");
  card.className = "track-card";
  card.type = "button";
  card.setAttribute("aria-label", text("playlist.select", { no: track.no }));
  card.setAttribute("aria-pressed", "false");
  card.dataset.trackIndex = String(index);
  const cover = document.createElement("span");
  cover.className = "track-cover";
  cover.setAttribute("aria-hidden", "true");
  const coverImage = document.createElement("img");
  coverImage.alt = "";
  coverImage.hidden = true;
  cover.append(coverImage);
  card.append(cover);
  [["track-no", content.copy.playlist.prefix + " " + track.no], ["track-title", track.title], ["track-subtitle", track.subtitle], ["track-arrow", "↗"]].forEach(([className, value]) => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    if (className === "track-arrow") span.setAttribute("aria-hidden", "true");
    card.append(span);
  });
  card.addEventListener("click", () => {
    if (activeIndex === index) { if (audio.paused) playCurrent(); else audio.pause(); }
    else selectTrack(index, { autoplay: true });
  });
  grid.append(card);
  if (track.src) {
    if (coverObserver) coverObserver.observe(card);
    else loadCardCover(index);
  }
});
function moveTrack(offset) {
  if (activeIndex < 0) return;
  selectTrack(activeIndex + offset, { autoplay: !audio.paused });
}
$("playPause").addEventListener("click", () => audio.paused ? playCurrent() : audio.pause());
$("previousTrack").addEventListener("click", () => moveTrack(-1));
$("nextTrack").addEventListener("click", () => moveTrack(1));
$("shuffleBtn").addEventListener("click", () => {
  if (!tracks.length) return;
  const next = activeIndex < 0 ? Math.floor(Math.random() * tracks.length) : (activeIndex + 1 + Math.floor(Math.random() * Math.max(1, tracks.length - 1))) % tracks.length;
  selectTrack(next, { autoplay: true });
  $("playlist").scrollIntoView({ behavior: reducedMotion.matches ? "instant" : "smooth", block: "start" });
});
audio.addEventListener("play", () => setPlaying(true));
audio.addEventListener("pause", () => setPlaying(false));
audio.addEventListener("loadedmetadata", updateProgress);
audio.addEventListener("durationchange", updateProgress);
audio.addEventListener("timeupdate", updateProgress);
audio.addEventListener("waiting", () => { $("playerNote").textContent = text("player.loading"); });
audio.addEventListener("playing", () => { $("playerNote").textContent = tracks[activeIndex].note; });
audio.addEventListener("ended", () => {
  const next = tracks.findIndex((track, i) => i > activeIndex && track.src);
  if (next >= 0) selectTrack(next, { autoplay: true });
  else setPlaying(false);
});
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return;
  setPlaying(false);
  progress.disabled = true;
  $("playerNote").textContent = text("messages.failed");
  showToast(text("messages.failed"));
});
progress.addEventListener("pointerdown", () => { if (!progress.disabled) scrubbing = true; });
progress.addEventListener("input", () => {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  scrubbing = true;
  const target = Number(progress.value) / 100 * audio.duration;
  $("currentTime").textContent = formatTime(target);
  progress.setAttribute("aria-valuetext", text("player.time", { current: formatTime(target), duration: formatTime(audio.duration) }));
});
progress.addEventListener("change", () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(progress.value) / 100 * audio.duration;
  scrubbing = false;
  updateProgress();
});
progress.addEventListener("pointerup", () => { scrubbing = false; });
progress.addEventListener("pointercancel", () => { scrubbing = false; updateProgress(); });
progress.addEventListener("blur", () => { scrubbing = false; updateProgress(); });
if ("mediaSession" in navigator) {
  const handlers = { play: playCurrent, pause: () => audio.pause(), previoustrack: () => moveTrack(-1), nexttrack: () => moveTrack(1), seekto: (event) => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(event.seekTime, audio.duration)); } };
  Object.entries(handlers).forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {} });
}
function setMotion(enabled) {
  motionEnabled = enabled && !reducedMotion.matches;
  document.body.classList.toggle("sound-on", motionEnabled);
  $("soundToggle").classList.toggle("active", motionEnabled);
  $("soundToggle").setAttribute("aria-pressed", String(motionEnabled));
  $("motionText").textContent = text(motionEnabled ? "theme.motionOn" : "theme.motionOff");
}
$("soundToggle").addEventListener("click", () => {
  if (reducedMotion.matches) showToast(text("messages.reducedMotion"));
  setMotion(!motionEnabled);
});
reducedMotion.addEventListener("change", () => setMotion(motionEnabled));
$("themeSelect").value = window.SiteTheme.getMode();
$("themeSelect").addEventListener("change", (event) => window.SiteTheme.setMode(event.target.value));

const mobileSettingsToggle = $("mobileSettingsToggle");
const headerControls = $("headerControls");
const themeGlyph = $("themeGlyph");
const mobileLayout = window.matchMedia("(max-width: 560px)");
function syncThemeGlyph() {
  themeGlyph.textContent = document.documentElement.dataset.theme === "dusk" ? "◐" : "☼";
}
function setMobileSettingsOpen(open) {
  const next = Boolean(open && mobileLayout.matches);
  headerControls.classList.toggle("is-open", next);
  mobileSettingsToggle.setAttribute("aria-expanded", String(next));
}
mobileSettingsToggle.addEventListener("click", () => {
  setMobileSettingsOpen(!headerControls.classList.contains("is-open"));
});
document.addEventListener("pointerdown", (event) => {
  if (!headerControls.classList.contains("is-open")) return;
  if (headerControls.contains(event.target) || mobileSettingsToggle.contains(event.target)) return;
  setMobileSettingsOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !headerControls.classList.contains("is-open")) return;
  setMobileSettingsOpen(false);
  mobileSettingsToggle.focus();
});
mobileLayout.addEventListener("change", (event) => {
  if (!event.matches) setMobileSettingsOpen(false);
});
new MutationObserver(syncThemeGlyph).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
syncThemeGlyph();

$("memoryTrigger").addEventListener("click", () => $("memoryModal").showModal());
document.querySelector("[data-close-memory]").addEventListener("click", () => $("memoryModal").close());
$("memoryModal").addEventListener("click", (event) => {
  if (event.target !== $("memoryModal")) return;
  const box = event.target.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
});
