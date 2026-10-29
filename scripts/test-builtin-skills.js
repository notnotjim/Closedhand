const { test } = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../lib/skills');
skills.loadAllSkills();
test('Meta skills follow the saved Meta Ads connection', () => {
  const connected = new Set(['meta_ads']);
  const store = { isConnected: service => connected.has(service) };
  let prompt = skills.getSkillsForPrompt(store, 'meta ads performance');
  assert.match(prompt, /--- SKILL: Manage Meta ad campaigns ---/);
  connected.clear();
  assert.doesNotMatch(skills.getSkillsForPrompt(store, 'meta ads performance'), /--- SKILL: Manage Meta ad campaigns ---/);
});
test('browser Instagram instructions require no ads connection', () => {
  const prompt = skills.getSkillsForPrompt({ isConnected: () => false }, 'comment on my instagram post');
  assert.match(prompt, /--- SKILL: Comment on Instagram posts ---/);
  assert.match(prompt, /sandbox_browse/);
});
