const tracks = Array.from({ length: 21 }, function (_, index) {
  const no = String(index + 1).padStart(2, "0");
  return {
    no: no,
    title: "Track " + no,
    subtitle: "这首歌的位置还空着",
    note: "等待把属于我们的这首歌放进来",
    src: ""
  };
});

/*
以后把上面的 tracks 替换成真实歌曲即可，例如：
{
  no: "01",
  title: "歌曲名",
  subtitle: "歌手 · 这一首为什么重要",
  note: "可以写一句只有你们懂的话",
  src: "https://你的音频地址/01.mp3"
}
*/

const grid = document.getElementById("trackGrid");
const playerShell = document.getElementById("playerShell");
const playerIndex = document.getElementById("playerIndex");
const playerTitle = document.getElementById("playerTitle");
const playerNote = document.getElementById("playerNote");
const playPause = document.getElementById("playPause");
const playIcon = document.getElementById("playIcon");
const audio = document.getElementById("audio");
const progress = document.getElementById("progress");
const currentTime = document.getElementById("currentTime");
const duration = document.getElementById("duration");
const toast = document.getElementById("toast");
const shuffleBtn = document.getElementById("shuffleBtn");
const soundToggle = document.getElementById("soundToggle");
const memoryTrigger = document.getElementById("memoryTrigger");
const memoryModal = document.getElementById("memoryModal");

let activeIndex = -1;
let toastTimer;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60).toString().padStart(2, "0");
  return min + ":" + sec;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 2200);
}

function renderTracks() {
  grid.innerHTML = "";
  tracks.forEach(function (track, index) {
    const card = document.createElement("button");
    card.className = "track-card";
    card.type = "button";
    card.setAttribute("aria-label", "打开第 " + track.no + " 首歌");
    card.innerHTML =
      '<span class="track-no">TRACK ' + track.no + '</span>' +
      '<span class="track-title">' + track.title + '</span>' +
      '<span class="track-subtitle">' + track.subtitle + '</span>' +
      '<span class="track-arrow">↗</span>';

    card.addEventListener("click", function () {
      selectTrack(index);
    });

    grid.appendChild(card);
  });
}

function selectTrack(index) {
  const track = tracks[index];
  activeIndex = index;

  document.querySelectorAll(".track-card").forEach(function (card, cardIndex) {
    card.classList.toggle("active", cardIndex === index);
  });

  playerIndex.textContent = track.no;
  playerTitle.textContent = track.title;
  playerNote.textContent = track.note;
  playerShell.classList.add("visible");
  playerShell.setAttribute("aria-hidden", "false");

  audio.pause();
  playIcon.textContent = "▶";
  progress.value = 0;
  currentTime.textContent = "0:00";
  duration.textContent = "0:00";

  if (track.src) {
    audio.src = track.src;
    audio.load();
  } else {
    audio.removeAttribute("src");
    showToast("第 " + track.no + " 首还没有放进来，播放器框架已经准备好了。");
  }
}

playPause.addEventListener("click", function () {
  if (activeIndex < 0) return;
  const track = tracks[activeIndex];

  if (!track.src) {
    showToast("音频还没接入，等你把歌单给我后这里就能直接播放。");
    return;
  }

  if (audio.paused) {
    audio.play().catch(function () {
      showToast("浏览器阻止了自动播放，请再点一次播放。");
    });
  } else {
    audio.pause();
  }
});

audio.addEventListener("play", function () {
  playIcon.textContent = "❚❚";
});

audio.addEventListener("pause", function () {
  playIcon.textContent = "▶";
});

audio.addEventListener("loadedmetadata", function () {
  duration.textContent = formatTime(audio.duration);
});

audio.addEventListener("timeupdate", function () {
  const ratio = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  progress.value = ratio;
  currentTime.textContent = formatTime(audio.currentTime);
});

progress.addEventListener("input", function () {
  if (!audio.duration) return;
  audio.currentTime = (Number(progress.value) / 100) * audio.duration;
});

shuffleBtn.addEventListener("click", function () {
  const index = Math.floor(Math.random() * tracks.length);
  selectTrack(index);
  document.getElementById("playlist").scrollIntoView({ behavior: "smooth", block: "start" });
});

soundToggle.addEventListener("click", function () {
  const enabled = document.body.classList.toggle("sound-on");
  soundToggle.classList.toggle("active", enabled);
  soundToggle.querySelector("span:last-child").textContent = enabled ? "sound on" : "sound off";
});

function openMemory() {
  memoryModal.classList.add("open");
  memoryModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeMemory() {
  memoryModal.classList.remove("open");
  memoryModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

memoryTrigger.addEventListener("click", openMemory);
document.querySelectorAll("[data-close-memory]").forEach(function (el) {
  el.addEventListener("click", closeMemory);
});
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeMemory();
});

renderTracks();