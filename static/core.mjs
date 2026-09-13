export const PROGRESS_VERSION = 1;

export function defaultProgress() {
  return {
    schemaVersion: PROGRESS_VERSION,
    totalKeys: 0,
    correctKeys: 0,
    completedWords: 0,
    words: {},
    lastPracticed: null,
    settings: { volume: 0.8, rate: 145, muted: false },
  };
}

export function migrateProgress(value) {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return defaultProgress();
    }
  }
  if (!source || typeof source !== "object") return defaultProgress();

  const fallback = defaultProgress();
  const settings = source.settings && typeof source.settings === "object"
    ? source.settings
    : {};
  return {
    schemaVersion: PROGRESS_VERSION,
    totalKeys: Number.isFinite(source.totalKeys) ? Math.max(0, source.totalKeys) : 0,
    correctKeys: Number.isFinite(source.correctKeys) ? Math.max(0, source.correctKeys) : 0,
    completedWords: Number.isFinite(source.completedWords) ? Math.max(0, source.completedWords) : 0,
    words: source.words && typeof source.words === "object" ? source.words : {},
    lastPracticed: typeof source.lastPracticed === "string" ? source.lastPracticed : null,
    settings: {
      volume: Number.isFinite(settings.volume) ? Math.min(1, Math.max(0, settings.volume)) : fallback.settings.volume,
      rate: Number.isFinite(settings.rate) ? Math.min(250, Math.max(80, settings.rate)) : fallback.settings.rate,
      muted: Boolean(settings.muted),
    },
  };
}

export function createTypingState(lesson) {
  return {
    word: lesson.word,
    position: 0,
    mistakes: 0,
    completed: false,
    revealed: false,
  };
}

export function completedSegmentAt(lesson, position) {
  let end = 0;
  for (const segment of lesson.segments) {
    end += segment.letters.length;
    if (end === position) return segment;
  }
  return null;
}

export function advanceTyping(state, lesson, key) {
  if (state.completed || typeof key !== "string" || key.length !== 1) {
    return { state, accepted: false, ignored: true, segment: null };
  }
  const normalized = key.toLowerCase();
  const expected = lesson.word[state.position];
  if (normalized !== expected) {
    return {
      state: { ...state, mistakes: state.mistakes + 1 },
      accepted: false,
      ignored: false,
      segment: null,
    };
  }

  const position = state.position + 1;
  return {
    state: { ...state, position, completed: position === lesson.word.length },
    accepted: true,
    ignored: false,
    segment: completedSegmentAt(lesson, position),
  };
}

export function recordKey(progress, word, correct) {
  const next = migrateProgress(progress);
  const prior = next.words[word] || { attempts: 0, errors: 0, lastPracticed: null };
  next.totalKeys += 1;
  if (correct) next.correctKeys += 1;
  if (!correct) prior.errors += 1;
  next.words = { ...next.words, [word]: prior };
  return next;
}

export function recordCompletedWord(progress, word) {
  const next = migrateProgress(progress);
  const now = new Date().toISOString();
  const prior = next.words[word] || { attempts: 0, errors: 0, lastPracticed: null };
  next.completedWords += 1;
  next.lastPracticed = now;
  next.words = {
    ...next.words,
    [word]: { ...prior, attempts: prior.attempts + 1, lastPracticed: now },
  };
  return next;
}

export function shortcutLabel(record) {
  const base = record.key === "Semicolon" ? ";" : record.key.replace(/^Key/, "");
  return record.shifted ? `⇧${base}` : base;
}

export function phonemeForKeyboardEvent(phonemes, eventLike) {
  return phonemes.find(
    (record) => record.key === eventLike.code && record.shifted === Boolean(eventLike.shiftKey),
  ) || null;
}

export function appendPhoneme(tokens, id) {
  return [...tokens, id];
}

export function appendBoundary(tokens) {
  if (!tokens.length || tokens[tokens.length - 1] === "BOUNDARY") return tokens;
  return [...tokens, "BOUNDARY"];
}

export function removeLastToken(tokens) {
  return tokens.slice(0, -1);
}

export function matchingWords(tokens, lessons) {
  const normalized = tokens.filter((item) => item !== "BOUNDARY").join(" ");
  if (!normalized) return [];
  return lessons
    .filter((lesson) => lesson.phonemes.join(" ") === normalized)
    .map((lesson) => lesson.word);
}
