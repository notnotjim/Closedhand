// webapp/pin-fact.js: a fact typed in on the dashboard, filed the way
// Closedhand files one in chat (pin_fact): worked into the fact already
// pinned about the same person or thing, or pinned as a new one in its
// group. The person's own LLM decides, given every pinned fact.
const CATEGORIES = ["person", "business", "profile", "preference", "topic"];
const FILE = {
  name: "file_fact",
  description: "Where the typed fact goes.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "A pinned fact's key when the typed fact is about the same person or thing; otherwise a new short label, e.g. 'family-mums-name'." },
      subject: { type: "string", description: "Who or what it is about, written as the pinned fact writes it: a person's full name, a company's name." },
      category: { type: "string", enum: CATEGORIES },
      value: { type: "string", description: "The whole fact as it should now read. For a pinned fact's key: what it said, with the typed fact worked in, keeping everything still true." },
    },
    required: ["key", "subject", "category", "value"],
  },
};
const SYSTEM = "The person typed a fact for Closedhand to pin about their own life. You are given what they are called and the facts already pinned, one per line as key | subject | group | fact. "
  + "When the typed fact is about the same person or thing as a pinned fact, file it there: that fact's key, subject and group, and its fact rewritten with the typed one worked in, keeping everything in it that is still true. "
  + "Otherwise give a new key, the subject and its group: person (someone in their life), business (a company, product or project they run or work on), profile (the person themself), preference (how they want Closedhand to behave), topic (anything else lasting). "
  + "Never add anything the typed fact and the pinned facts don't say.";

const slug = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// text: what was typed. facts: [{ key, value, subject, category }]. names:
// what the person is called. selected: their LLM (model-policy getRole).
// Returns { key, value, subject, category, merged }. Without an LLM, or when
// it can't be asked, the fact is pinned as typed, on its own.
async function fileFact(text, facts, names, selected, { request = require("./model-wire").request } = {}) {
  const alone = { key: slug(text.split(/\s+/).slice(0, 6).join(" ")) || "fact", value: text, subject: null, category: "topic", merged: false };
  if (!selected) return alone;
  const lines = facts.map((f) => [f.key, f.subject || "", f.category || "", String(f.value || "").replace(/\s+/g, " ").slice(0, 600)].join(" | ")).join("\n");
  let out;
  try {
    const response = await request(selected, {
      model: selected.model, effort: "fast", system: SYSTEM, max_tokens: 1024,
      messages: [{ role: "user", content: "They are called: " + (names.filter(Boolean).join(", ") || "not known") + "\n\nPinned facts:\n" + (lines || "(none)") + "\n\nTyped fact: " + text }],
      tools: [FILE], tool_choice: { type: "tool", name: FILE.name },
    }, { signal: AbortSignal.timeout(30000) });
    out = response.content?.find((b) => b.type === "tool_use" && b.name === FILE.name)?.input;
  } catch (e) {
    console.log("[pin-fact] could not file it: " + e.message);
    return alone;
  }
  const value = String(out?.value || "").trim().slice(0, 2000);
  if (!value) return alone;
  const existing = facts.find((f) => f.key === out.key);
  return {
    key: existing ? existing.key : slug(out.key) || alone.key,
    value,
    subject: String(out.subject || "").trim().slice(0, 120) || existing?.subject || null,
    category: CATEGORIES.includes(out.category) ? out.category : existing?.category || "topic",
    merged: !!existing,
  };
}

module.exports = { fileFact, CATEGORIES };
