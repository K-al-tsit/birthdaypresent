/* Replace these placeholders with the songs and audio URLs when the playlist is ready. */
const tracks = Array.from({ length: 21 }, (_, index) => ({
  no: String(index + 1).padStart(2, "0"),
  title: "Track " + String(index + 1).padStart(2, "0"),
  subtitle: "这首歌的位置还空着",
  note: "等待把属于我们的这首歌放进来。",
  src: ""
}));

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const grid = $("trackGrid");
const progress = $("progress");
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
let activeIndex = 0;
let toastTimer;
let selectionVersion = 0;
let motionEnabled = !motionPreference.matches;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}
function showToast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
}
function setMotion(enabled) {
  motionEnabled = enabled && !motionPreference.matches;
  document.body.classList.toggle("motion-on", motionEnabled);
  $("motionToggle").setAttribute("aria-pressed", String(motionEnabled));
  $("motionToggle").setAttribute("aria-label", motionEnabled ? "关闭画面微风" : "开启画面微风");
  $("motionLabel").textContent = "微风 · " + (motionEnabled ? "开" : "关");
}
function setPlaybackState(playing) {
  document.body.classList.toggle("is-playing", playing);
  $("playPause").setAttribute("aria-label", playing ? "暂停" : "播放");
  $("playIcon").innerHTML = playing ? '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>' : '<path d="m9 5 11 7-11 7Z"/>';
  $("playbackStatus").textContent = !tracks[activeIndex].src ? "等待一首歌" : playing ? "正在播放" : "按下播放，慢慢听";
}
function renderTracks() {
  tracks.forEach((track, index) => {
    const card = document.createElement("button");
    card.className = "track-card";
    card.type = "button";
    card.setAttribute("aria-label", "选择第 " + track.no + " 首：" + track.title);
    const no = document.createElement("span");
    no.className = "track-no";
    no.textContent = track.no;
    const copy = document.createElement("span");
    copy.className = "track-copy";
    const title = document.createElement("span");
    title.className = "track-title";
    title.textContent = track.title;
    const subtitle = document.createElement("span");
    subtitle.className = "track-subtitle";
    subtitle.textContent = track.subtitle;
    copy.append(title, subtitle);
    const arrow = document.createElement("span");
    arrow.className = "track-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    card.append(no, copy, arrow);
    card.addEventListener("click", () => selectTrack(index, { notify: true }));
    grid.append(card);
  });
}
function selectTrack(index, { notify = false, autoplay = false } = {}) {
  activeIndex = (index + tracks.length) % tracks.length;
  selectionVersion += 1;
  const track = tracks[activeIndex];
  audio.pause();
  audio.removeAttribute("src");
  progress.value = 0;
  progress.disabled = true;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  $("playerIndex").textContent = track.no + " / 21";
  $("playerTitle").textContent = $("noteTitle").textContent = track.title;
  $("playerNote").textContent = track.src ? track.subtitle : "歌曲待加入";
  $("noteIndex").textContent = track.no;
  $("noteText").textContent = track.note;
  Array.from(grid.children).forEach((card, i) => {
    card.classList.toggle("active", i === activeIndex);
    card.setAttribute("aria-pressed", String(i === activeIndex));
    card.querySelector(".track-arrow").textContent = i === activeIndex ? "♪" : "↗";
  });
  if (track.src) audio.src = track.src;
  audio.load();
  setPlaybackState(false);
  if (!track.src && notify) showToast("第 " + track.no + " 首还在准备中，先把这一页留给你。");
  if (track.src && autoplay) playCurrent();
}
function playCurrent() {
  if (!tracks[activeIndex].src) {
    showToast("这首歌还没有加入音频，再等一等。可以先翻翻其他页。");
    return;
  }
  const version = selectionVersion;
  audio.play().catch((error) => {
    if (version !== selectionVersion || error.name === "AbortError") return;
    setPlaybackState(false);
    showToast(error.name === "NotAllowedError" ? "请再按一下播放，让音乐开始。" : "这首歌暂时无法播放，请稍后重试。");
  });
}
function moveTrack(offset) {
  const wasPlaying = !audio.paused;
  selectTrack(activeIndex + offset, { notify: true, autoplay: wasPlaying });
  const selected = grid.children[activeIndex];
  // Keep the selection visible inside the list without moving the whole page.
  grid.scrollTo({ top: selected.offsetTop - grid.offsetTop - grid.clientHeight / 2 + selected.clientHeight / 2, behavior: motionPreference.matches ? "instant" : "smooth" });
}
$("playPause").addEventListener("click", () => audio.paused ? playCurrent() : audio.pause());
$("prevTrack").addEventListener("click", () => moveTrack(-1));
$("nextTrack").addEventListener("click", () => moveTrack(1));
$("shuffleBtn").addEventListener("click", () => {
  const offset = 1 + Math.floor(Math.random() * (tracks.length - 1));
  moveTrack(offset);
});
$("repeatToggle").addEventListener("click", () => {
  audio.loop = !audio.loop;
  $("repeatToggle").setAttribute("aria-pressed", String(audio.loop));
  $("repeatToggle").setAttribute("aria-label", audio.loop ? "关闭单曲循环" : "开启单曲循环");
  showToast(audio.loop ? "单曲循环已开启。" : "按歌单顺序播放。");
});
audio.addEventListener("play", () => setPlaybackState(true));
audio.addEventListener("pause", () => setPlaybackState(false));
audio.addEventListener("loadedmetadata", () => {
  progress.disabled = !(Number.isFinite(audio.duration) && audio.duration > 0);
  $("duration").textContent = formatTime(audio.duration);
});
audio.addEventListener("timeupdate", () => {
  progress.value = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration * 100 : 0;
  $("currentTime").textContent = formatTime(audio.currentTime);
});
progress.addEventListener("input", () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(progress.value) / 100 * audio.duration;
});
audio.addEventListener("ended", () => {
  const next = tracks.findIndex((_, i) => i > activeIndex && tracks[i].src);
  if (next >= 0) selectTrack(next, { autoplay: true });
  else setPlaybackState(false);
});
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return;
  setPlaybackState(false);
  progress.disabled = true;
  $("playbackStatus").textContent = "暂时无法播放";
  showToast("这首歌暂时无法加载，请检查网络后重试。");
});
$("motionToggle").addEventListener("click", () => {
  if (motionPreference.matches) showToast("已遵循你设备的“减少动态效果”设置。");
  setMotion(!motionEnabled);
});
motionPreference.addEventListener("change", () => setMotion(!motionPreference.matches));
$("memoryTrigger").addEventListener("click", () => $("memoryModal").showModal());
$("memoryClose").addEventListener("click", () => $("memoryModal").close());
$("memoryModal").addEventListener("click", (event) => {
  if (event.target === $("memoryModal")) {
    const box = event.target.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
  }
});
renderTracks();
selectTrack(0);
setMotion(motionEnabled);
