/* Edit visible words and track details in content.js; this file only handles interactions. */
const content = window.SITE_CONTENT;
const audioBase = String(content.settings?.audioBase || "").replace(/\/+$/, "");
const tracks = content.tracks.map((track) => {
  if (!track.media || !audioBase) return { ...track };
  const stem = String(track.file || (track.subtitle + " - " + track.title)).normalize("NFD");
  const encodedStem = encodeURIComponent(stem);
  return {
    ...track,
    src: audioBase + "/" + encodedStem + ".mp3",
    lyrics: audioBase + "/" + encodedStem + ".lrc"
  };
});
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
const lyricsLeadSeconds = Number(content.settings?.lyricsLeadSeconds || 0);
const grid = $("trackGrid");
const progress = $("progress");
const expandedProgress = $("expandedProgress");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let activeIndex = -1;
let toastTimer;
let selectionVersion = 0;
let scrubbing = false;
let expandedScrubbing = false;
let motionEnabled = false;
let playerTransitionToken = 0;
let audioFadeToken = 0;
let shuffleEnabled = false;
let mobileDetailMode = null;
let desktopSideMode = "message";
let currentLyrics = [];
let activeLyricIndex = -1;
const coverCache = new Map();
const lyricsCache = new Map();
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
      const imageTypeAt = (start) => {
        if (start + 2 < frame.length && frame[start] === 0xff && frame[start + 1] === 0xd8 && frame[start + 2] === 0xff) return "image/jpeg";
        if (start + 7 < frame.length && frame[start] === 0x89 && frame[start + 1] === 0x50 && frame[start + 2] === 0x4e && frame[start + 3] === 0x47 && frame[start + 4] === 0x0d && frame[start + 5] === 0x0a && frame[start + 6] === 0x1a && frame[start + 7] === 0x0a) return "image/png";
        if (start + 5 < frame.length && ascii(frame, start, 6) === "GIF87a") return "image/gif";
        if (start + 5 < frame.length && ascii(frame, start, 6) === "GIF89a") return "image/gif";
        if (start + 11 < frame.length && ascii(frame, start, 4) === "RIFF" && ascii(frame, start + 8, 4) === "WEBP") return "image/webp";
        return null;
      };

      // Some taggers omit the empty APIC description terminator and put JPEG/PNG
      // bytes immediately after the picture-type byte. Accept that common malformed
      // layout before applying the strict ID3 description parsing path.
      const immediateType = imageTypeAt(descriptionStart);
      if (immediateType) return new Blob([frame.slice(descriptionStart)], { type: immediateType });

      const descriptionEnd = findTerminator(frame, descriptionStart, frame.length, encoding);
      const strictImageStart = Math.min(frame.length, descriptionEnd + ((encoding === 1 || encoding === 2) ? 2 : 1));
      const strictType = imageTypeAt(strictImageStart);
      if (strictType) return new Blob([frame.slice(strictImageStart)], { type: strictType });

      // Last-resort compatibility for non-standard APIC descriptions: locate a
      // known image signature near the beginning of the picture payload.
      const scanEnd = Math.min(frame.length, descriptionStart + 2048);
      for (let imageStart = descriptionStart; imageStart < scanEnd; imageStart += 1) {
        const detectedType = imageTypeAt(imageStart);
        if (detectedType) return new Blob([frame.slice(imageStart)], { type: detectedType });
      }
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
function getLyricsUrl(track) {
  if (track?.lyrics) return track.lyrics;
  if (!track?.src) return "";
  return track.src.replace(/\.mp3(?=([?#]|$))/i, ".lrc");
}
function parseLrc(raw) {
  const entries = [];
  String(raw).split(/\r?\n/).forEach((line) => {
    const matches = [...line.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    if (!matches.length) return;
    const lyric = line.slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length).trim();
    if (!lyric) return;
    matches.forEach((match) => {
      entries.push({
        time: Number(match[1]) * 60 + Number(match[2]),
        text: lyric
      });
    });
  });
  return entries.sort((a, b) => a.time - b.time);
}
async function getLyrics(track) {
  const url = getLyricsUrl(track);
  if (!url) return [];
  if (!lyricsCache.has(url)) {
    lyricsCache.set(url, fetch(url, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error("lyrics fetch failed: " + response.status);
        return response.text();
      })
      .then(parseLrc)
      .catch((error) => {
        console.warn("Lyrics unavailable", error);
        return [];
      }));
  }
  return lyricsCache.get(url);
}
function renderLyrics(container, entries, status = "") {
  container.replaceChildren();
  if (status) {
    const p = document.createElement("p");
    p.className = "lyrics-status";
    p.textContent = status;
    container.append(p);
    return;
  }
  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    const p = document.createElement("p");
    p.className = "lyric-line";
    p.dataset.lyricIndex = String(index);
    p.textContent = entry.text;
    fragment.append(p);
  });
  container.append(fragment);
}
function setLyricsStatus(message) {
  renderLyrics($("desktopLyrics"), [], message);
  renderLyrics($("mobileLyrics"), [], message);
}
function lyricIndexAt(time) {
  const adjustedTime = time + lyricsLeadSeconds;
  let low = 0;
  let high = currentLyrics.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (currentLyrics[mid].time <= adjustedTime + 0.035) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}
function centerActiveLyric(container, index, smooth = true) {
  const line = container.querySelector('[data-lyric-index="' + index + '"]');
  if (!line || container.offsetParent === null) return;
  const top = line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: smooth && !reducedMotion.matches ? "smooth" : "auto" });
}
function updateLyrics(time = audio.currentTime, force = false) {
  if (!currentLyrics.length) return;
  const nextIndex = lyricIndexAt(Number.isFinite(time) ? time : 0);
  if (!force && nextIndex === activeLyricIndex) return;
  activeLyricIndex = nextIndex;
  ["desktopLyrics", "mobileLyrics"].forEach((id) => {
    const container = $(id);
    container.querySelectorAll(".lyric-line.active").forEach((line) => line.classList.remove("active"));
    if (nextIndex >= 0) {
      const line = container.querySelector('[data-lyric-index="' + nextIndex + '"]');
      if (line) line.classList.add("active");
      centerActiveLyric(container, nextIndex, !force);
    }
  });
}
async function loadLyrics(track, version) {
  currentLyrics = [];
  activeLyricIndex = -1;
  setLyricsStatus(text("player.lyricsLoading"));
  const entries = await getLyrics(track);
  if (version !== selectionVersion || tracks[activeIndex] !== track) return;
  currentLyrics = entries;
  activeLyricIndex = -1;
  if (!entries.length) {
    setLyricsStatus(text("player.lyricsUnavailable"));
    return;
  }
  renderLyrics($("desktopLyrics"), entries);
  renderLyrics($("mobileLyrics"), entries);
  updateLyrics(audio.currentTime, true);
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
  const expandedImage = $("expandedCoverImage");
  const expandedCover = $("expandedCover");
  const backdropImage = $("expandedBackdropImage");
  image.hidden = true;
  expandedImage.hidden = true;
  backdropImage.hidden = true;
  image.removeAttribute("src");
  expandedImage.removeAttribute("src");
  backdropImage.removeAttribute("src");
  cover.classList.remove("has-art");
  expandedCover.classList.remove("has-art");
  const coverUrl = await getCoverUrl(track);
  if (!coverUrl || version !== selectionVersion || tracks[activeIndex] !== track) return;
  image.src = coverUrl;
  expandedImage.src = coverUrl;
  backdropImage.src = coverUrl;
  image.hidden = false;
  expandedImage.hidden = false;
  backdropImage.hidden = false;
  cover.classList.add("has-art");
  expandedCover.classList.add("has-art");
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
  $("expandedPlayIcon").textContent = playing ? "❚❚" : "▶";
  $("playPause").setAttribute("aria-label", text(playing ? "player.pause" : "player.play"));
  $("expandedPlayPause").setAttribute("aria-label", text(playing ? "player.pause" : "player.play"));
  document.body.classList.toggle("is-playing", playing);
  if ("mediaSession" in navigator && tracks[activeIndex]?.src) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}
function updateProgress() {
  const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
  const value = hasDuration ? audio.currentTime / audio.duration * 100 : 0;
  const current = formatTime(audio.currentTime);
  const duration = formatTime(audio.duration);
  progress.disabled = !hasDuration;
  expandedProgress.disabled = !hasDuration;
  if (!scrubbing) {
    progress.value = value;
    $("currentTime").textContent = current;
    progress.setAttribute("aria-valuetext", text("player.time", { current, duration }));
  }
  if (!expandedScrubbing) {
    expandedProgress.value = value;
    $("expandedCurrentTime").textContent = current;
    expandedProgress.setAttribute("aria-valuetext", text("player.time", { current, duration }));
  }
  $("duration").textContent = duration;
  $("expandedDuration").textContent = duration;
  updateLyrics(audio.currentTime);
}
function setPlayerMode(expanded, { focus = true } = {}) {
  if (activeIndex < 0) return;
  const nowPlaying = $("nowPlaying");
  const open = Boolean(expanded);
  document.body.classList.toggle("player-expanded", open);
  nowPlaying.setAttribute("aria-hidden", String(!open));
  nowPlaying.inert = !open;
  document.querySelector("main").inert = open;
  document.querySelector(".topbar").inert = open;
  document.querySelector("footer").inert = open;
  $("playerShell").inert = open;
  $("playerShell").setAttribute("aria-hidden", String(open));
  if (!open) {
    if (focus) $("expandPlayer").focus({ preventScroll: true });
  } else if (focus) {
    $("minimizePlayer").focus({ preventScroll: true });
  }
}
function syncPlaybackModes() {
  ["desktopShuffleMode", "mobileShuffleMode"].forEach((id) => {
    const button = $(id);
    button.classList.toggle("active", shuffleEnabled);
    button.setAttribute("aria-pressed", String(shuffleEnabled));
  });
  ["desktopSequenceMode", "mobileSequenceMode"].forEach((id) => {
    const button = $(id);
    button.classList.toggle("active", !shuffleEnabled);
    button.setAttribute("aria-pressed", String(!shuffleEnabled));
  });
}
function setShuffleEnabled(enabled) {
  shuffleEnabled = Boolean(enabled);
  syncPlaybackModes();
}
function applyMobileDetailMode(mode) {
  mobileDetailMode = mode === "message" || mode === "lyrics" ? mode : null;
  const messageOpen = mobileDetailMode === "message";
  const lyricsOpen = mobileDetailMode === "lyrics";
  $("nowPlaying").classList.toggle("message-mode", messageOpen);
  $("nowPlaying").classList.toggle("lyrics-mode", lyricsOpen);
  $("messageMode").classList.toggle("active", messageOpen);
  $("messageMode").setAttribute("aria-pressed", String(messageOpen));
  $("mobileLyricsMode").classList.toggle("active", lyricsOpen);
  $("mobileLyricsMode").setAttribute("aria-pressed", String(lyricsOpen));
  $("mobileMessagePanel").setAttribute("aria-hidden", String(!messageOpen));
  $("mobileLyricsPanel").setAttribute("aria-hidden", String(!lyricsOpen));
  if (lyricsOpen) requestAnimationFrame(() => updateLyrics(audio.currentTime, true));
}
function animateArtworkBackToDefault() {
  if (reducedMotion.matches) {
    applyMobileDetailMode(null);
    return;
  }
  const nowPlaying = $("nowPlaying");
  const artwork = $("expandedCover");
  const first = artwork.getBoundingClientRect();
  const firstRadius = getComputedStyle(artwork).borderRadius;
  nowPlaying.classList.add("artwork-expanding");
  applyMobileDetailMode(null);
  const last = artwork.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = last.width ? first.width / last.width : 1;
  const sy = last.height ? first.height / last.height : 1;
  const lastRadius = getComputedStyle(artwork).borderRadius;
  const animation = artwork.animate([
    {
      transformOrigin: "top left",
      transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")",
      borderRadius: firstRadius
    },
    {
      transformOrigin: "top left",
      transform: "translate(0,0) scale(1,1)",
      borderRadius: lastRadius
    }
  ], {
    duration: 460,
    easing: "cubic-bezier(.2,.82,.2,1)",
    fill: "both"
  });
  const cleanup = () => nowPlaying.classList.remove("artwork-expanding");
  animation.addEventListener("finish", cleanup, { once: true });
  animation.addEventListener("cancel", cleanup, { once: true });
}
function setMobileDetailMode(mode) {
  const nextMode = mobileDetailMode === mode ? null : mode;
  if (mobileDetailMode && nextMode === null) {
    animateArtworkBackToDefault();
    return;
  }
  applyMobileDetailMode(nextMode);
}
function resetMobileDetailMode() {
  applyMobileDetailMode(null);
}
function setDesktopSideMode(mode) {
  desktopSideMode = mode === "lyrics" ? "lyrics" : "message";
  const lyricsOpen = desktopSideMode === "lyrics";
  $("desktopMessageTab").classList.toggle("active", !lyricsOpen);
  $("desktopMessageTab").setAttribute("aria-selected", String(!lyricsOpen));
  $("desktopLyricsTab").classList.toggle("active", lyricsOpen);
  $("desktopLyricsTab").setAttribute("aria-selected", String(lyricsOpen));
  $("desktopMessagePane").classList.toggle("active", !lyricsOpen);
  $("desktopMessagePane").hidden = lyricsOpen;
  $("desktopLyricsPane").classList.toggle("active", lyricsOpen);
  $("desktopLyricsPane").hidden = !lyricsOpen;
  if (lyricsOpen) requestAnimationFrame(() => updateLyrics(audio.currentTime, true));
}
function randomPlayableIndex(exclude = -1) {
  const candidates = tracks
    .map((track, index) => track.src ? index : -1)
    .filter((index) => index >= 0 && index !== exclude);
  if (!candidates.length) return exclude >= 0 && tracks[exclude]?.src ? exclude : -1;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
function expandPlayerFromCard(card) {
  if (!card || reducedMotion.matches || document.body.classList.contains("player-transitioning")) {
    setPlayerMode(true);
    return;
  }
  const rect = card.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    setPlayerMode(true);
    return;
  }

  playerTransitionToken += 1;
  const token = playerTransitionToken;
  const ghost = card.cloneNode(true);
  ghost.classList.remove("active");
  ghost.classList.add("player-card-transition");
  ghost.removeAttribute("aria-pressed");
  ghost.removeAttribute("aria-label");
  ghost.removeAttribute("data-track-index");
  ghost.setAttribute("aria-hidden", "true");
  ghost.tabIndex = -1;
  if ("disabled" in ghost) ghost.disabled = true;
  ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));

  Object.assign(ghost.style, {
    left: rect.left + "px",
    top: rect.top + "px",
    width: rect.width + "px",
    height: rect.height + "px",
    borderRadius: getComputedStyle(card).borderRadius
  });

  document.body.append(ghost);
  card.classList.add("transition-source");
  document.body.classList.add("player-transitioning");
  setPlayerMode(true, { focus: false });

  const cleanup = () => {
    if (token !== playerTransitionToken) return;
    ghost.remove();
    card.classList.remove("transition-source");
    document.body.classList.remove("player-transitioning");
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== playerTransitionToken) return;
      ghost.classList.add("is-opening");
      ghost.style.left = "0px";
      ghost.style.top = "0px";
      ghost.style.width = window.innerWidth + "px";
      ghost.style.height = window.innerHeight + "px";
      ghost.style.borderRadius = "0px";
    });
  });

  window.setTimeout(() => {
    if (token !== playerTransitionToken) return;
    ghost.classList.add("is-handoff");
    window.setTimeout(cleanup, 150);
  }, 520);
}
function fadeAudioVolume(target, duration, version = selectionVersion) {
  const token = ++audioFadeToken;
  const start = audio.volume;
  const change = target - start;
  if (duration <= 0 || Math.abs(change) < 0.001) {
    audio.volume = target;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now) => {
      if (token !== audioFadeToken || version !== selectionVersion) {
        resolve(false);
        return;
      }
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      audio.volume = Math.max(0, Math.min(1, start + change * eased));
      if (progress < 1) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}
function playCurrent({ fadeIn = false } = {}) {
  if (!tracks[activeIndex]?.src) { showToast(text("messages.emptyAudio")); return; }
  const version = selectionVersion;
  if (fadeIn) audio.volume = 0;
  else if (audio.volume < 0.999) audio.volume = 1;
  audio.play().then(() => {
    if (fadeIn && version === selectionVersion) fadeAudioVolume(1, 120, version);
  }).catch((error) => {
    if (version !== selectionVersion || error.name === "AbortError") return;
    audio.volume = 1;
    setPlaying(false);
    showToast(text(error.name === "NotAllowedError" ? "messages.blocked" : "messages.failed"));
  });
}
async function selectTrack(index, { autoplay = false, notify = true, expanded = true } = {}) {
  if (!tracks.length) return;
  const wasPlaying = !audio.paused && !audio.ended && Boolean(audio.getAttribute("src"));
  selectionVersion += 1;
  const version = selectionVersion;
  if (wasPlaying) {
    await fadeAudioVolume(0, 90, version);
    if (version !== selectionVersion) return;
  }
  audio.pause();
  activeIndex = (index + tracks.length) % tracks.length;
  const track = tracks[activeIndex];
  audio.removeAttribute("src");
  scrubbing = false;
  expandedScrubbing = false;
  progress.value = 0;
  expandedProgress.value = 0;
  progress.disabled = true;
  expandedProgress.disabled = true;
  $("currentTime").textContent = $("duration").textContent = "0:00";
  $("expandedCurrentTime").textContent = $("expandedDuration").textContent = "0:00";
  $("playerIndex").textContent = track.no;
  $("playerTitle").textContent = track.title;
  $("playerNote").textContent = track.note;
  $("expandedIndex").textContent = track.no;
  $("expandedCoverFallback").textContent = track.no;
  $("expandedTitle").textContent = track.title;
  $("expandedSubtitle").textContent = track.subtitle;
  $("expandedNote").textContent = track.note;
  $("expandedNoteMobile").textContent = track.note;
  resetMobileDetailMode();
  setDesktopSideMode("message");
  $("playerShell").classList.add("visible");
  $("playerShell").setAttribute("aria-hidden", "false");
  document.body.classList.add("has-player");
  setPlayerMode(expanded, { focus: false });
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
  loadLyrics(track, selectionVersion);
  if (track.src && autoplay) playCurrent({ fadeIn: true });
  else {
    audio.volume = 1;
    if (!track.src && notify) showToast(text("messages.emptySelection", { no: track.no }));
  }
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
  [["track-no", content.copy.playlist.prefix + " " + track.no], ["track-title", track.title], ["track-subtitle", track.subtitle], ["track-arrow", "▶"]].forEach(([className, value]) => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    if (className === "track-arrow") span.setAttribute("aria-hidden", "true");
    card.append(span);
  });
  card.addEventListener("click", () => {
    if (activeIndex === index) {
      if (!document.body.classList.contains("player-expanded")) expandPlayerFromCard(card);
      else if (audio.paused) playCurrent();
      else audio.pause();
    } else {
      selectTrack(index, { autoplay: true, expanded: false });
      expandPlayerFromCard(card);
    }
  });
  grid.append(card);
  if (track.src) {
    if (coverObserver) coverObserver.observe(card);
    else loadCardCover(index);
  }
});
function moveTrack(offset) {
  if (activeIndex < 0) return;
  let nextIndex = activeIndex + offset;
  if (shuffleEnabled && offset > 0) {
    const randomIndex = randomPlayableIndex(activeIndex);
    if (randomIndex >= 0) nextIndex = randomIndex;
  }
  selectTrack(nextIndex, {
    autoplay: !audio.paused,
    expanded: document.body.classList.contains("player-expanded")
  });
}
$("playPause").addEventListener("click", () => audio.paused ? playCurrent() : audio.pause());
$("previousTrack").addEventListener("click", () => moveTrack(-1));
$("nextTrack").addEventListener("click", () => moveTrack(1));
$("expandedPlayPause").addEventListener("click", () => audio.paused ? playCurrent() : audio.pause());
$("expandedPreviousTrack").addEventListener("click", () => moveTrack(-1));
$("expandedNextTrack").addEventListener("click", () => moveTrack(1));
$("expandPlayer").addEventListener("click", () => setPlayerMode(true));
$("minimizePlayer").addEventListener("click", () => setPlayerMode(false));
$("desktopShuffleMode").addEventListener("click", () => setShuffleEnabled(true));
$("mobileShuffleMode").addEventListener("click", () => setShuffleEnabled(true));
$("desktopSequenceMode").addEventListener("click", () => setShuffleEnabled(false));
$("mobileSequenceMode").addEventListener("click", () => setShuffleEnabled(false));
$("messageMode").addEventListener("click", () => setMobileDetailMode("message"));
$("mobileLyricsMode").addEventListener("click", () => setMobileDetailMode("lyrics"));
$("desktopMessageTab").addEventListener("click", () => setDesktopSideMode("message"));
$("desktopLyricsTab").addEventListener("click", () => setDesktopSideMode("lyrics"));
syncPlaybackModes();
setDesktopSideMode("message");
audio.addEventListener("play", () => setPlaying(true));
audio.addEventListener("pause", () => setPlaying(false));
audio.addEventListener("loadedmetadata", updateProgress);
audio.addEventListener("durationchange", updateProgress);
audio.addEventListener("timeupdate", updateProgress);
audio.addEventListener("waiting", () => { $("playerNote").textContent = text("player.loading"); });
audio.addEventListener("playing", () => { $("playerNote").textContent = tracks[activeIndex].note; });
audio.addEventListener("ended", () => {
  const next = shuffleEnabled
    ? randomPlayableIndex(activeIndex)
    : tracks.findIndex((track, i) => i > activeIndex && track.src);
  if (next >= 0 && next !== activeIndex) selectTrack(next, { autoplay: true, expanded: document.body.classList.contains("player-expanded") });
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
expandedProgress.addEventListener("pointerdown", () => { if (!expandedProgress.disabled) expandedScrubbing = true; });
expandedProgress.addEventListener("input", () => {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  expandedScrubbing = true;
  const target = Number(expandedProgress.value) / 100 * audio.duration;
  $("expandedCurrentTime").textContent = formatTime(target);
  expandedProgress.setAttribute("aria-valuetext", text("player.time", { current: formatTime(target), duration: formatTime(audio.duration) }));
});
expandedProgress.addEventListener("change", () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(expandedProgress.value) / 100 * audio.duration;
  expandedScrubbing = false;
  updateProgress();
});
expandedProgress.addEventListener("pointerup", () => { expandedScrubbing = false; });
expandedProgress.addEventListener("pointercancel", () => { expandedScrubbing = false; updateProgress(); });
expandedProgress.addEventListener("blur", () => { expandedScrubbing = false; updateProgress(); });
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
function syncThemeGlyph() {
  themeGlyph.textContent = document.documentElement.dataset.theme === "dusk" ? "◐" : "☼";
}
function setMobileSettingsOpen(open) {
  const next = Boolean(open);
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
  if (event.key === "Escape" && document.body.classList.contains("player-expanded")) {
    setPlayerMode(false);
    return;
  }
  if (event.key !== "Escape" || !headerControls.classList.contains("is-open")) return;
  setMobileSettingsOpen(false);
  mobileSettingsToggle.focus();
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
