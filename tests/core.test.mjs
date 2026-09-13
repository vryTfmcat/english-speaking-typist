import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceTyping,
  appendBoundary,
  appendPhoneme,
  createTypingState,
  defaultProgress,
  matchingWords,
  migrateProgress,
  phonemeForKeyboardEvent,
  removeLastToken,
} from "../static/core.mjs";

const lesson = {
  word: "ship",
  phonemes: ["SH", "IH", "P"],
  segments: [
    { letters: "sh", phonemes: ["SH"] },
    { letters: "i", phonemes: ["IH"] },
    { letters: "p", phonemes: ["P"] },
  ],
};

test("typing state advances, counts errors, and reports grapheme completion", () => {
  let state = createTypingState(lesson);
  let result = advanceTyping(state, lesson, "x");
  assert.equal(result.accepted, false);
  assert.equal(result.state.mistakes, 1);

  state = advanceTyping(result.state, lesson, "s").state;
  result = advanceTyping(state, lesson, "h");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.segment.phonemes, ["SH"]);

  state = advanceTyping(result.state, lesson, "i").state;
  result = advanceTyping(state, lesson, "p");
  assert.equal(result.state.completed, true);
});

test("phoneme keyboard respects Shift layer", () => {
  const phonemes = [
    { id: "IY", key: "KeyQ", shifted: false },
    { id: "EY", key: "KeyQ", shifted: true },
  ];
  assert.equal(phonemeForKeyboardEvent(phonemes, { code: "KeyQ", shiftKey: false }).id, "IY");
  assert.equal(phonemeForKeyboardEvent(phonemes, { code: "KeyQ", shiftKey: true }).id, "EY");
});

test("phoneme buffer supports append, boundary, backspace, and clear", () => {
  let tokens = appendPhoneme([], "K");
  tokens = appendPhoneme(tokens, "AE");
  tokens = appendBoundary(tokens);
  assert.deepEqual(tokens, ["K", "AE", "BOUNDARY"]);
  assert.strictEqual(appendBoundary(tokens), tokens);
  assert.deepEqual(removeLastToken(tokens), ["K", "AE"]);
  assert.deepEqual([], []);
});

test("exact phoneme sequence matches fixture word", () => {
  const fixtures = [{ word: "cat", phonemes: ["K", "AE", "T"] }];
  assert.deepEqual(matchingWords(["K", "AE", "T"], fixtures), ["cat"]);
  assert.deepEqual(matchingWords(["K", "AE"], fixtures), []);
});

test("progress migration repairs old and malformed data", () => {
  assert.deepEqual(migrateProgress("bad json"), defaultProgress());
  const migrated = migrateProgress({ totalKeys: 4, correctKeys: 3, settings: { rate: 999 } });
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.totalKeys, 4);
  assert.equal(migrated.settings.rate, 250);
  assert.deepEqual(migrated.words, {});
});
