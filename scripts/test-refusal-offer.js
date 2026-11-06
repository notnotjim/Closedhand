// When the person's own LLM provider refuses, Managed Models are offered once
// a month, after the answer; a reply about something missing is no refusal.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const offer = require("../lib/refusal-offer");

const own = (extra = {}) => ({ profile: { settings: { model_config: { connections: {} }, ...extra } } });
const NOW = Date.parse("2026-03-10T12:00:00Z");

test("a clear refusal at the start of a short reply counts; missing things and long answers do not", () => {
  for (const r of ["I'm sorry, but I can't help with that.", "I can’t assist with that request.", "Sorry, but I won't provide instructions for that.",
    "I must decline. That goes against my guidelines.", "I'm unable to write that kind of content."]) assert.ok(offer.refused(r), r);
  for (const r of ["I can't help with that yet: your calendar isn't connected.", "I couldn't find a booking for Lisbon in your mail.",
    "Here are three bars near Alfama that stay open late.", "I can't help with that without access to your Drive.", "x".repeat(1300) + " I can't help with that."]) assert.ok(!offer.refused(r), r);
});

test("offered after the answer as a follow-on, once in 30 days, never while Managed Models answer", async () => {
  const store = own();
  const first = await offer.addOffer({ store, reply: "I can't help with that.", platform: "whatsapp", now: NOW, link: null });
  assert.match(first, /^I can't help with that\.\n\n\[\[next\]\]\n\nYour LLM provider chose not to answer that\. With Closedhand Managed Models, what Closedhand answers is up to you, and nobody but you can read what you ask\. closedhand\.com\/subscribe$/);
  assert.equal(store.profile.settings.refusal_offer_at, new Date(NOW).toISOString());
  assert.equal(await offer.addOffer({ store, reply: "I can't help with that.", platform: "whatsapp", now: NOW + 29 * 86400000, link: null }), "I can't help with that.");
  assert.match(await offer.addOffer({ store, reply: "I can't help with that.", platform: "whatsapp", now: NOW + 31 * 86400000, link: null }), /\[\[next\]\]/);
  const managed = own({ model_config: { included: true }, included_api_key: "sealed" });
  assert.equal(await offer.addOffer({ store: managed, reply: "I can't help with that.", platform: "web", now: NOW, link: null }), "I can't help with that.");
  assert.equal(managed.profile.settings.refusal_offer_at, undefined);
});

test("where to get them follows the plan: back in Settings, paying ahead again, or the subscription", () => {
  const live = { included_api_key: "sealed", included_ai: { plan: { name: "plus" } } };
  assert.match(offer.offerText(live, "https://quiet-fern-12.closedhand.ai/dashboard#settings", true), /Switch to Managed Models in the \[dashboard\]\(https:\/\/quiet-fern-12\.closedhand\.ai\/dashboard#settings\)\.$/);
  assert.match(offer.offerText({ included_ai: { plan: { name: "ended", was: "ahead" } } }, null, false), /Pay ahead again in My Account\.$/);
  assert.match(offer.offerText({}, null, true), /\[closedhand\.com\/subscribe\]\(https:\/\/closedhand\.com\/subscribe\)$/);
});

test("the chat adds it after the answer, before follow-ons are split", () => {
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  const at = engine.indexOf('require("./refusal-offer").addOffer');
  assert.ok(at > engine.indexOf('require("./ask-who").addQuestion') && at < engine.indexOf('require("./follow-on").withBreaks(finalText)'));
});
