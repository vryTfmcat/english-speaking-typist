import {
  advanceTyping,
  appendBoundary,
  appendPhoneme,
  createTypingState,
  defaultProgress,
  matchingWords,
  migrateProgress,
  phonemeForKeyboardEvent,
  recordCompletedWord,
  recordKey,
  removeLastToken,
  shortcutLabel,
} from "/static/core.mjs";

const STORAGE_KEY = "english-speaking-typist-progress-v1";
const REQUIRED_SERVER_BUILD = "phoneme-direct-v2";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let lessons = [];
let phonemes = [];
let phonemesById = new Map();
let filteredLessons = [];
let lessonIndex = 0;
let typingState = null;
let phonemeTokens = [];
let activeMode = "practice";
let activeCategory = "全部";
let lastFreeText = "";
let progress = loadProgress();

function loadProgress() {
  return migrateProgress(localStorage.getItem(STORAGE_KEY));
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

function setMessage(message, kind = "") {
  const element = $("#message");
  element.textContent = message;
  element.className = kind;
}

function setServiceStatus(online, detail = "") {
  const element = $("#service-status");
  element.className = `status ${online ? "online" : "offline"}`;
  element.textContent = online ? `本地语音已连接${detail ? ` · ${detail}` : ""}` : "本地语音服务未连接";
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
    setServiceStatus(true);
    return payload;
  } catch (error) {
    setServiceStatus(false);
    throw error;
  }
}

async function postJson(url, payload) {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

class AudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.buffers = new Map();
    this.keySource = null;
    this.teachingSource = null;
    this.teachingQueue = Promise.resolve();
    this.generation = 0;
    this.lastSpec = null;
  }

  get enabled() { return Boolean(this.context); }

  async enable() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("当前浏览器不支持 Web Audio API");
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
    }
    await this.context.resume();
    this.applySettings();
  }

  applySettings() {
    if (!this.master) return;
    const target = progress.settings.muted ? 0 : progress.settings.volume;
    this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.015);
  }

  specKey(spec) {
    const value = Array.isArray(spec.value) ? spec.value.join(",") : spec.value;
    return `${spec.mode}:${progress.settings.rate}:${value}`;
  }

  async bufferFor(spec) {
    const key = this.specKey(spec);
    if (this.buffers.has(key)) return this.buffers.get(key);
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...spec, rate: progress.settings.rate }),
    });
    if (!response.ok) {
      let message = `语音请求失败：${response.status}`;
      try { message = (await response.json()).error || message; } catch { /* binary/no body */ }
      setServiceStatus(false);
      throw new Error(message);
    }
    setServiceStatus(true);
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    this.buffers.set(key, buffer);
    return buffer;
  }

  stopKey() {
    if (!this.keySource) return;
    try { this.keySource.stop(); } catch { /* already stopped */ }
    this.keySource = null;
  }

  playBuffer(buffer, channel) {
    return new Promise((resolve) => {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      gain.gain.value = channel === "key" ? 0.82 : 1;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(this.master);
      source.onended = () => {
        if (channel === "key" && this.keySource === source) this.keySource = null;
        if (channel === "teaching" && this.teachingSource === source) this.teachingSource = null;
        resolve();
      };
      if (channel === "key") {
        this.stopKey();
        this.keySource = source;
      } else {
        this.teachingSource = source;
      }
      source.start();
    });
  }

  async playKey(spec) {
    if (!this.enabled || progress.settings.muted) return;
    this.lastSpec = spec;
    try {
      const buffer = await this.bufferFor(spec);
      await this.playBuffer(buffer, "key");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  queueTeaching(spec) {
    if (!this.enabled || progress.settings.muted) return;
    this.lastSpec = spec;
    const generation = this.generation;
    this.teachingQueue = this.teachingQueue
      .then(async () => {
        if (generation !== this.generation) return;
        const buffer = await this.bufferFor(spec);
        if (generation !== this.generation) return;
        await this.playBuffer(buffer, "teaching");
      })
      .catch((error) => setMessage(error.message, "error"));
  }

  cancelTeaching() {
    this.generation += 1;
    this.teachingQueue = Promise.resolve();
    if (this.teachingSource) {
      try { this.teachingSource.stop(); } catch { /* already stopped */ }
      this.teachingSource = null;
    }
  }

  replay() {
    if (this.lastSpec) this.queueTeaching(this.lastSpec);
  }

  errorTone() {
    if (!this.enabled || progress.settings.muted) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 155;
    gain.gain.setValueAtTime(0.12, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start();
    oscillator.stop(this.context.currentTime + 0.13);
  }
}

const audio = new AudioEngine();

function currentLesson() {
  return filteredLessons[lessonIndex];
}

function applyCategory(category) {
  activeCategory = category;
  filteredLessons = category === "全部" ? lessons : lessons.filter((item) => item.category === category);
  lessonIndex = 0;
  typingState = createTypingState(currentLesson());
  $$(".filter").forEach((button) => button.classList.toggle("active", button.dataset.category === category));
  audio.cancelTeaching();
  renderLesson();
}

function renderTypingWord() {
  const lesson = currentLesson();
  const container = $("#typing-word");
  container.replaceChildren();
  [...lesson.word].forEach((letter, index) => {
    const span = document.createElement("span");
    span.className = "typing-letter";
    if (index < typingState.position) span.classList.add("done");
    if (!typingState.completed && index === typingState.position) span.classList.add("cursor");
    span.textContent = typingState.revealed || index < typingState.position ? letter : "•";
    container.append(span);
  });
}

function renderLesson() {
  const lesson = currentLesson();
  if (!lesson) return;
  $("#lesson-category").textContent = lesson.category;
  $("#lesson-count").textContent = `${lessonIndex + 1} / ${filteredLessons.length}`;
  $("#lesson-meaning").textContent = lesson.meaning;
  $("#show-answer").textContent = typingState.revealed ? "隐藏答案" : "显示答案";
  $("#typing-hint").textContent = typingState.completed
    ? `完成，错误 ${typingState.mistakes} 次。按 Enter 进入下一个。`
    : "直接用键盘输入；错误不会推进光标。";
  $("#next-word").disabled = !typingState.completed;
  $("#previous-word").disabled = filteredLessons.length < 2;
  renderTypingWord();

  const result = $("#lesson-result");
  result.classList.toggle("hidden", !typingState.completed);
  if (typingState.completed) {
    $("#result-word").textContent = lesson.word;
    $("#result-ipa").textContent = `/${lesson.ipa}/`;
    $("#result-example").textContent = lesson.example;
    const segments = $("#result-segments");
    segments.replaceChildren();
    lesson.segments.forEach((segment) => {
      const item = document.createElement("span");
      item.className = "segment";
      const ipa = segment.phonemes.map((id) => phonemesById.get(id)?.ipa || id).join("");
      item.textContent = `${segment.letters} /${ipa}/`;
      segments.append(item);
    });
  }
  renderStats();
}

function renderStats() {
  const accuracy = progress.totalKeys ? Math.round((progress.correctKeys / progress.totalKeys) * 100) : null;
  $("#accuracy").textContent = accuracy === null ? "—" : `${accuracy}%`;
  $("#completed-count").textContent = String(progress.completedWords);
  const ranked = Object.entries(progress.words).sort((a, b) => (b[1].errors || 0) - (a[1].errors || 0));
  $("#hardest-word").textContent = ranked.length && ranked[0][1].errors ? ranked[0][0] : "暂无";
}

function flashTypingError() {
  const word = $("#typing-word");
  word.classList.add("wrong");
  window.setTimeout(() => word.classList.remove("wrong"), 180);
}

function handleTypingKey(key) {
  const lesson = currentLesson();
  const result = advanceTyping(typingState, lesson, key);
  if (result.ignored) return;
  typingState = result.state;
  progress = recordKey(progress, lesson.word, result.accepted);
  if (result.accepted) {
    audio.playKey({ mode: "text", value: key.toLowerCase() });
    if (result.segment) audio.queueTeaching({ mode: "phonemes", value: result.segment.phonemes });
    if (typingState.completed) {
      progress = recordCompletedWord(progress, lesson.word);
      audio.queueTeaching({ mode: "text", value: lesson.word });
    }
  } else {
    audio.errorTone();
    flashTypingError();
  }
  saveProgress();
  renderLesson();
}

function moveLesson(delta) {
  lessonIndex = (lessonIndex + delta + filteredLessons.length) % filteredLessons.length;
  typingState = createTypingState(currentLesson());
  audio.cancelTeaching();
  renderLesson();
  $("#lesson-card").focus();
}

function repeatLesson() {
  const lesson = currentLesson();
  typingState = createTypingState(lesson);
  audio.cancelTeaching();
  renderLesson();
  $("#lesson-card").focus();
  setMessage(`重新练习：${lesson.word}`, "success");
}

function renderPhonemeGroups() {
  const container = $("#phoneme-groups");
  container.replaceChildren();
  const categories = [...new Set(phonemes.map((item) => item.category))];
  categories.forEach((category) => {
    const section = document.createElement("section");
    section.className = "phoneme-group";
    const title = document.createElement("h3");
    title.textContent = category;
    const grid = document.createElement("div");
    grid.className = "phoneme-grid";
    phonemes.filter((item) => item.category === category).forEach((record) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "phoneme-key";
      button.dataset.phonemeId = record.id;
      const ipa = document.createElement("span");
      ipa.className = "ipa";
      ipa.textContent = record.ipa;
      const meta = document.createElement("span");
      meta.className = "key-meta";
      const example = document.createElement("span");
      example.textContent = record.example;
      const shortcut = document.createElement("span");
      shortcut.textContent = shortcutLabel(record);
      meta.append(example, shortcut);
      button.append(ipa, meta);
      button.addEventListener("click", () => addPhoneme(record));
      grid.append(button);
    });
    section.append(title, grid);
    container.append(section);
  });
}

function addPhoneme(record) {
  phonemeTokens = appendPhoneme(phonemeTokens, record.id);
  audio.playKey({ mode: "phonemes", value: [record.id] });
  pulsePhonemeKey(record.id);
  renderPhonemeBuffer();
}

function pulsePhonemeKey(id) {
  const button = document.querySelector(`[data-phoneme-id="${id}"]`);
  if (!button) return;
  button.classList.add("active");
  window.setTimeout(() => button.classList.remove("active"), 130);
}

function renderPhonemeBuffer() {
  const container = $("#phoneme-buffer");
  container.replaceChildren();
  if (!phonemeTokens.length) {
    const placeholder = document.createElement("span");
    placeholder.className = "placeholder";
    placeholder.textContent = "按物理键或点击下面的音素…";
    container.append(placeholder);
  } else {
    phonemeTokens.forEach((id) => {
      const token = document.createElement("span");
      if (id === "BOUNDARY") {
        token.className = "boundary";
        token.setAttribute("aria-label", "边界");
      } else {
        token.className = "token";
        token.textContent = phonemesById.get(id)?.ipa || id;
      }
      container.append(token);
    });
  }
  const matches = matchingWords(phonemeTokens, lessons);
  $("#word-matches").textContent = matches.length ? `可能的单词：${matches.join("、")}` : "";
  $("#speak-phonemes").disabled = !phonemeTokens.some((item) => item !== "BOUNDARY");
}

function speakPhonemeBuffer() {
  if (!phonemeTokens.some((item) => item !== "BOUNDARY")) return;
  audio.cancelTeaching();
  audio.queueTeaching({ mode: "phonemes", value: phonemeTokens });
}

function setMode(mode) {
  activeMode = mode;
  $$(".mode-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  $$(".mode-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${mode}-panel`));
  audio.cancelTeaching();
  if (mode === "practice") $("#lesson-card").focus();
  if (mode === "free") $("#free-input").focus();
  if (mode === "phoneme") $(".phoneme-composer").focus();
}

function persistSettings() {
  progress.settings.volume = Number($("#volume").value);
  progress.settings.rate = Number($("#rate").value);
  progress.settings.muted = $("#mute").getAttribute("aria-pressed") === "true";
  saveProgress();
  audio.applySettings();
}

async function preloadSoundBank() {
  const tasks = [
    ...[..."abcdefghijklmnopqrstuvwxyz"].map((letter) => ({ mode: "text", value: letter })),
    ...phonemes.map((record) => ({ mode: "phonemes", value: [record.id] })),
  ];
  let cursor = 0;
  let loaded = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const spec = tasks[cursor++];
      try {
        await audio.bufferFor(spec);
        loaded += 1;
        if (loaded % 10 === 0) setMessage(`正在准备声音 ${loaded}/${tasks.length}…`);
      } catch (error) {
        setMessage(error.message, "error");
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (loaded === tasks.length) setMessage(`声音准备完成：${loaded} 个`, "success");
}

function bindEvents() {
  $$(".mode-tab").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$(".filter").forEach((button) => button.addEventListener("click", () => applyCategory(button.dataset.category)));

  $("#show-answer").addEventListener("click", () => {
    typingState.revealed = !typingState.revealed;
    renderLesson();
  });
  $("#next-word").addEventListener("click", () => { if (typingState.completed) moveLesson(1); });
  $("#previous-word").addEventListener("click", () => moveLesson(-1));
  $("#repeat-word").addEventListener("click", repeatLesson);

  $("#enable-audio").addEventListener("click", async () => {
    try {
      await audio.enable();
      $("#enable-audio").textContent = "声音已启用";
      $("#enable-audio").disabled = true;
      setMessage("正在准备字母与音素声音…");
      preloadSoundBank();
    } catch (error) {
      setMessage(error.message, "error");
    }
  });

  $("#volume").addEventListener("input", persistSettings);
  $("#rate").addEventListener("input", () => {
    $("#rate-value").textContent = $("#rate").value;
    persistSettings();
  });
  $("#mute").addEventListener("click", () => {
    const next = $("#mute").getAttribute("aria-pressed") !== "true";
    $("#mute").setAttribute("aria-pressed", String(next));
    $("#mute").textContent = next ? "取消静音" : "静音";
    persistSettings();
  });
  $("#replay").addEventListener("click", () => audio.replay());

  $("#clear-progress").addEventListener("click", () => {
    if (!window.confirm("清空这台浏览器中的全部练习记录和设置？")) return;
    progress = defaultProgress();
    saveProgress();
    applyStoredSettings();
    renderStats();
    setMessage("本机学习记录已清空", "success");
  });

  $("#free-input").addEventListener("keydown", (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[a-z]$/i.test(event.key)) audio.playKey({ mode: "text", value: event.key.toLowerCase() });
  });
  $("#free-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#free-input").value.trim();
    if (!text) return;
    try {
      setMessage("正在分析…");
      const result = await postJson("/api/analyze", { text });
      lastFreeText = result.text;
      $("#free-ipa").textContent = `/${result.ipa}/`;
      $("#free-espeak").textContent = result.espeak;
      $("#free-result").classList.remove("hidden");
      audio.cancelTeaching();
      audio.queueTeaching({ mode: "text", value: result.text });
      setMessage("分析完成", "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  });

  $("#backspace-phoneme").addEventListener("click", () => {
    phonemeTokens = removeLastToken(phonemeTokens);
    renderPhonemeBuffer();
  });
  $("#clear-phonemes").addEventListener("click", () => {
    phonemeTokens = [];
    audio.cancelTeaching();
    renderPhonemeBuffer();
  });
  $("#speak-phonemes").addEventListener("click", speakPhonemeBuffer);

  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

    if (activeMode === "practice") {
      if (event.key === "Enter" && typingState.completed) {
        event.preventDefault();
        moveLesson(1);
      } else if (/^[a-z]$/i.test(event.key)) {
        event.preventDefault();
        handleTypingKey(event.key);
      }
      return;
    }

    if (activeMode !== "phoneme") return;
    if (event.key === "Backspace") {
      event.preventDefault();
      phonemeTokens = removeLastToken(phonemeTokens);
      renderPhonemeBuffer();
    } else if (event.key === "Escape") {
      event.preventDefault();
      phonemeTokens = [];
      audio.cancelTeaching();
      renderPhonemeBuffer();
    } else if (event.key === " ") {
      event.preventDefault();
      phonemeTokens = appendBoundary(phonemeTokens);
      renderPhonemeBuffer();
    } else if (event.key === "Enter") {
      event.preventDefault();
      speakPhonemeBuffer();
    } else {
      const record = phonemeForKeyboardEvent(phonemes, event);
      if (record) {
        event.preventDefault();
        addPhoneme(record);
      }
    }
  });
}

function applyStoredSettings() {
  $("#volume").value = String(progress.settings.volume);
  $("#rate").value = String(progress.settings.rate);
  $("#rate-value").textContent = String(progress.settings.rate);
  $("#mute").setAttribute("aria-pressed", String(progress.settings.muted));
  $("#mute").textContent = progress.settings.muted ? "取消静音" : "静音";
  audio.applySettings();
}

async function init() {
  try {
    const [lessonResponse, phonemeResponse] = await Promise.all([
      fetch("/data/lessons.json"),
      fetch("/data/phonemes.json"),
    ]);
    if (!lessonResponse.ok || !phonemeResponse.ok) throw new Error("无法读取课程数据");
    lessons = await lessonResponse.json();
    phonemes = await phonemeResponse.json();
    phonemesById = new Map(phonemes.map((item) => [item.id, item]));
    filteredLessons = lessons;
    typingState = createTypingState(currentLesson());
    applyStoredSettings();
    renderLesson();
    renderPhonemeGroups();
    renderPhonemeBuffer();
    bindEvents();

    try {
      const health = await fetchJson("/api/health");
      if (health.build !== REQUIRED_SERVER_BUILD) {
        setServiceStatus(false);
        $("#enable-audio").disabled = true;
        $("#enable-audio").textContent = "请重启本地服务";
        setMessage("检测到旧版语音服务：请在终端停止后重新运行 python3 server.py", "error");
        return;
      }
      const shortVersion = health.engine.match(/\d+\.\d+(?:\.\d+)?/)?.[0] || "eSpeak";
      setServiceStatus(true, shortVersion);
    } catch (error) {
      setMessage("请用 python3 server.py 启动本地服务", "error");
    }
  } catch (error) {
    setMessage(error.message, "error");
    setServiceStatus(false);
  }
}

init();
