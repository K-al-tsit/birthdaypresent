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

function noteLineStats(value) {
  const line = String(value || "").trim();
  const cjk = (line.match(/[\u3400-\u9fff]/g) || []).length;
  const kana = (line.match(/[\u3040-\u30ff]/g) || []).length;
  const latin = (line.match(/[A-Za-z]/g) || []).length;
  return { line, cjk, kana, latin };
}
function renderTrackNote(container, value) {
  const rawLines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const stats = rawLines.map(noteLineStats);

  /* Keep quote detection deliberately conservative:
     - Japanese/English lyric originals are detected by script balance.
     - Chinese translations are only attached when they are short and directly
       adjacent to a detected foreign-language lyric line.
     - A short Chinese line can be treated as a quote only when isolated by
       blank lines and written without sentence punctuation.
     This prevents ordinary prose that happens to contain quotes/foreign words
     from being styled as lyrics. */
  const primaryLyric = stats.map(({ line, cjk, kana, latin }, index) => {
    if (!line) return false;

    const japaneseLyric =
      kana >= 3 &&
      kana >= Math.max(3, cjk * .35) &&
      line.length <= 72;

    const englishLyric =
      latin >= 4 &&
      latin > Math.max(4, cjk * 1.5) &&
      line.length <= 92;

    if (japaneseLyric || englishLyric) return true;

    const blankBefore = index === 0 || !stats[index - 1].line;
    const blankAfter = index === stats.length - 1 || !stats[index + 1].line;
    const isolatedChineseLyric =
      cjk >= 4 &&
      cjk <= 14 &&
      line.length <= 22 &&
      blankBefore &&
      blankAfter &&
      !/[。！？!?，,；;：:“”"「」『』]$/.test(line);

    return isolatedChineseLyric;
  });

  const quoteLine = stats.map(({ line, cjk, kana, latin }, index) => {
    if (!line) return false;
    if (primaryLyric[index]) return true;

    const chineseTranslation =
      cjk >= 2 &&
      kana === 0 &&
      latin <= 2 &&
      cjk <= 26 &&
      line.length <= 34;

    if (!chineseTranslation) return false;
    return Boolean(primaryLyric[index - 1] || primaryLyric[index + 1]);
  });

  const fragment = document.createDocumentFragment();
  let quoteGroup = null;
  let pendingGap = false;

  const flushQuote = () => {
    if (!quoteGroup) return;
    if (pendingGap) quoteGroup.classList.add("note-block-gap");
    fragment.append(quoteGroup);
    quoteGroup = null;
    pendingGap = false;
  };

  stats.forEach(({ line, cjk }, index) => {
    if (!line) {
      flushQuote();
      pendingGap = true;
      return;
    }

    if (quoteLine[index]) {
      if (!quoteGroup) {
        quoteGroup = document.createElement("span");
        quoteGroup.className = "note-quote";
      }
      const quote = document.createElement("span");
      quote.className = "note-quote-line";
      quote.textContent = line;
      quoteGroup.append(quote);
      return;
    }

    flushQuote();
    const block = document.createElement("span");
    const isLongChinese = cjk >= 24 && cjk / Math.max(1, line.length) >= .55;
    block.className = "note-block " + (isLongChinese ? "note-prose-long" : "note-prose-short");
    if (pendingGap) block.classList.add("note-block-gap");
    block.textContent = line;
    fragment.append(block);
    pendingGap = false;
  });

  flushQuote();
  container.replaceChildren(fragment);
}

const audio = $("audio");
const lyricsLeadSeconds = Number(content.settings?.lyricsLeadSeconds || 0);
const grid = $("trackGrid");
const progress = $("progress");
const expandedProgress = $("expandedProgress");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let activeIndex = -1;
let toastTimer;
let selectionVersion = 0;
let desktopMessageResetPending = false;
let mobileMessageResetPending = false;
let scrubbing = false;
let expandedScrubbing = false;
let motionEnabled = false;
let audioFadeToken = 0;
let shuffleEnabled = false;
let mobileDetailMode = null;
let desktopSideMode = "message";
let desiredPlayerExpanded = false;
let currentLyrics = [];
let activeLyricIndex = -1;
const coverCache = new Map();
const lyricsCache = new Map();

const fallbackArtworkPalette = {
  dark: [18, 27, 53],
  mid: [88, 67, 118],
  warm: [207, 105, 126],
  light: [236, 196, 188]
};
function averageArtworkColors(items, fallback) {
  if (!items.length) return fallback;
  const total = items.reduce((sum, pixel) => [
    sum[0] + pixel.r,
    sum[1] + pixel.g,
    sum[2] + pixel.b
  ], [0, 0, 0]);
  return total.map((value) => Math.round(value / items.length));
}
function applyArtworkPalette(palette) {
  const root = document.documentElement;
  root.style.setProperty("--art-dark-rgb", palette.dark.join(" "));
  root.style.setProperty("--art-mid-rgb", palette.mid.join(" "));
  root.style.setProperty("--art-warm-rgb", palette.warm.join(" "));
  root.style.setProperty("--art-light-rgb", palette.light.join(" "));
}
async function extractArtworkPalette(image, isCurrent = () => true) {
  if (!image) return;
  try {
    if (!image.complete || !image.naturalWidth) await image.decode();
    if (!isCurrent() || !image.naturalWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = [];
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] < 220) continue;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max - min;
      const luminance = .2126 * r + .7152 * g + .0722 * b;
      if (luminance < 18 || luminance > 242) continue;
      pixels.push({
        r, g, b,
        saturation,
        luminance,
        warm: (r - b) + .6 * (r - g) + saturation
      });
    }
    if (!pixels.length || !isCurrent()) return;
    pixels.sort((a, b) => a.luminance - b.luminance);
    const darkStart = Math.floor(pixels.length * .08);
    const darkEnd = Math.max(darkStart + 8, Math.floor(pixels.length * .3));
    const dark = averageArtworkColors(pixels.slice(darkStart, darkEnd), fallbackArtworkPalette.dark);
    const colorful = pixels
      .filter((pixel) => pixel.luminance > 52 && pixel.luminance < 205)
      .sort((a, b) => b.saturation - a.saturation);
    const mid = averageArtworkColors(colorful.slice(0, Math.max(10, Math.floor(pixels.length * .1))), fallbackArtworkPalette.mid);
    const warmPixels = pixels
      .filter((pixel) => pixel.luminance > 58 && pixel.luminance < 225 && pixel.r > pixel.b * 1.04)
      .sort((a, b) => b.warm - a.warm);
    const warm = averageArtworkColors(warmPixels.slice(0, Math.max(8, Math.floor(pixels.length * .07))), fallbackArtworkPalette.warm);
    const lightPixels = pixels
      .filter((pixel) => pixel.luminance > 145)
      .sort((a, b) => b.saturation - a.saturation);
    const light = averageArtworkColors(lightPixels.slice(0, Math.max(8, Math.floor(pixels.length * .06))), fallbackArtworkPalette.light);
    if (isCurrent()) {
      applyArtworkPalette({ dark, mid, warm, light });
      if (image.id === "expandedCoverImage") {
        const averageLuminance = pixels.reduce((sum, pixel) => sum + pixel.luminance, 0) / pixels.length;
        const bright = averageLuminance >= 165;
        const veryBright = averageLuminance >= 195;
        const root = document.documentElement;
        root.style.setProperty("--player-shade-top", veryBright ? ".58" : bright ? ".42" : ".20");
        root.style.setProperty("--player-shade-mid", veryBright ? ".74" : bright ? ".66" : ".55");
        root.style.setProperty("--player-shade-bottom", veryBright ? ".94" : bright ? ".92" : ".90");
        root.style.setProperty("--player-shade-base", veryBright ? ".42" : bright ? ".3" : ".12");
        root.style.setProperty("--player-backdrop-opacity", veryBright ? ".48" : bright ? ".58" : ".72");
      }
    }
  } catch (error) {
    console.debug("Artwork palette extraction unavailable", error);
  }
}
function applyHeroArtworkPalette(isCurrent = () => true) {
  return extractArtworkPalette($("heroAlbumImage"), isCurrent);
}
const heroAlbumImage = $("heroAlbumImage");
if (heroAlbumImage) {
  if (heroAlbumImage.complete && heroAlbumImage.naturalWidth) applyHeroArtworkPalette();
  else heroAlbumImage.addEventListener("load", () => applyHeroArtworkPalette(), { once: true });
}
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
function getLyricsTranslationUrl(track) {
  if (track?.lyricsTranslation) return track.lyricsTranslation;
  const url = getLyricsUrl(track);
  if (!url) return "";
  return url.replace(/\.lrc(?=([?#]|$))/i, ".zh.lrc");
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
function fetchLyricsFile(url, { quiet = false } = {}) {
  if (!url) return Promise.resolve([]);
  if (!lyricsCache.has(url)) {
    lyricsCache.set(url, fetch(url, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error("lyrics fetch failed: " + response.status);
        return response.text();
      })
      .then(parseLrc)
      .catch((error) => {
        if (!quiet) console.warn("Lyrics unavailable", error);
        return [];
      }));
  }
  return lyricsCache.get(url);
}
function mergeLyricTranslations(entries, translations) {
  if (!translations.length) return entries;
  let pointer = 0;
  return entries.map((entry) => {
    while (pointer + 1 < translations.length &&
      Math.abs(translations[pointer + 1].time - entry.time) <= Math.abs(translations[pointer].time - entry.time)) {
      pointer += 1;
    }
    const candidate = translations[pointer];
    const translation = candidate && Math.abs(candidate.time - entry.time) <= .4 ? candidate.text : "";
    return translation ? { ...entry, translation } : entry;
  });
}
async function getLyrics(track) {
  const originalUrl = getLyricsUrl(track);
  const translationUrl = getLyricsTranslationUrl(track);
  const [entries, translations] = await Promise.all([
    fetchLyricsFile(originalUrl),
    fetchLyricsFile(translationUrl, { quiet: true })
  ]);
  return mergeLyricTranslations(entries, translations);
}
function resetScrollPosition(container) {
  if (!container) return;
  const previousBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = "auto";
  container.scrollTop = 0;
  requestAnimationFrame(() => {
    container.scrollTop = 0;
    requestAnimationFrame(() => {
      container.scrollTop = 0;
      container.style.scrollBehavior = previousBehavior;
    });
  });
}
function resetLyricsScroll(container) {
  resetScrollPosition(container);
}
function resetMessageScroll() {
  document.querySelectorAll(".now-playing-message-scroll, .now-playing-message-mobile-scroll")
    .forEach(resetScrollPosition);
}
function resetDesktopMessageScroll() {
  resetScrollPosition(document.querySelector(".now-playing-message-scroll"));
}
function resetMobileMessageScroll() {
  resetScrollPosition(document.querySelector(".now-playing-message-mobile-scroll"));
}
function renderLyrics(container, entries, status = "") {
  container.replaceChildren();
  if (status) {
    const p = document.createElement("p");
    p.className = "lyrics-status";
    p.textContent = status;
    container.append(p);
    resetLyricsScroll(container);
    return;
  }
  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    const p = document.createElement("p");
    p.className = "lyric-line";
    p.dataset.lyricIndex = String(index);

    const original = document.createElement("span");
    original.className = "lyric-original";
    original.textContent = entry.text;
    p.append(original);

    if (entry.translation) {
      const translation = document.createElement("span");
      translation.className = "lyric-translation";
      translation.textContent = entry.translation;
      p.append(translation);
    }

    fragment.append(p);
  });
  container.append(fragment);
  resetLyricsScroll(container);
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
  updateLyrics(0, true);
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
  const stillCurrent = () => version === selectionVersion && tracks[activeIndex] === track;
  image.hidden = true;
  expandedImage.hidden = true;
  backdropImage.hidden = true;
  image.removeAttribute("src");
  expandedImage.removeAttribute("src");
  backdropImage.removeAttribute("src");
  cover.classList.remove("has-art");
  expandedCover.classList.remove("has-art");
  const coverUrl = await getCoverUrl(track);
  if (!stillCurrent()) return;
  if (!coverUrl) {
    await applyHeroArtworkPalette(stillCurrent);
    return;
  }
  image.src = coverUrl;
  expandedImage.src = coverUrl;
  backdropImage.src = coverUrl;
  image.hidden = false;
  expandedImage.hidden = false;
  backdropImage.hidden = false;
  cover.classList.add("has-art");
  expandedCover.classList.add("has-art");
  updateMediaMetadata(track, coverUrl);
  await extractArtworkPalette(expandedImage, stillCurrent);
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
  const open = Boolean(expanded);
  desiredPlayerExpanded = open;
  if (activeIndex < 0) return;
  const nowPlaying = $("nowPlaying");
  const wasOpen = document.body.classList.contains("player-expanded");
  if (open && !wasOpen) {
    resetMobileDetailMode();
    setDesktopSideMode("message");
    nowPlaying.classList.remove("artwork-expanding");
  }
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
  if (messageOpen && mobileMessageResetPending) {
    requestAnimationFrame(() => {
      resetMobileMessageScroll();
      mobileMessageResetPending = false;
    });
  }
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
  if (!lyricsOpen && desktopMessageResetPending) {
    requestAnimationFrame(() => {
      resetDesktopMessageScroll();
      desktopMessageResetPending = false;
    });
  }
  if (lyricsOpen) requestAnimationFrame(() => updateLyrics(audio.currentTime, true));
}
function randomPlayableIndex(exclude = -1) {
  const candidates = tracks
    .map((track, index) => track.src ? index : -1)
    .filter((index) => index >= 0 && index !== exclude);
  if (!candidates.length) return exclude >= 0 && tracks[exclude]?.src ? exclude : -1;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
function expandPlayerFromCard() {
  setPlayerMode(true);
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
  desiredPlayerExpanded = Boolean(expanded);
  const wasPlaying = !audio.paused && !audio.ended && Boolean(audio.getAttribute("src"));
  selectionVersion += 1;
  const version = selectionVersion;
  desktopMessageResetPending = true;
  mobileMessageResetPending = true;
  currentLyrics = [];
  activeLyricIndex = -1;
  setLyricsStatus(text("player.lyricsLoading"));
  if (wasPlaying) {
    await fadeAudioVolume(0, 90, version);
    if (version !== selectionVersion) return;
  }
  audio.pause();
  try { audio.currentTime = 0; } catch (_) {}
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
  renderTrackNote($("expandedNote"), track.note);
  renderTrackNote($("expandedNoteMobile"), track.note);
  resetMessageScroll();
  resetMobileDetailMode();
  setDesktopSideMode("message");
  $("playerShell").classList.add("visible");
  $("playerShell").setAttribute("aria-hidden", "false");
  document.body.classList.add("has-player");
  setPlayerMode(desiredPlayerExpanded, { focus: false });
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
      selectTrack(index, { autoplay: true, expanded: true });
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
