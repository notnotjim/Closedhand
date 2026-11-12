// What needs the maintainer now, at the top of closedhand.com's insights page
// (closedhand-com/lib/needs.js): each rule says what is wrong and what to do,
// and a quiet day says nothing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { needsOf } = require("../closedhand-com/lib/needs");

const NOW = Date.parse("2026-11-12T12:00:00Z");
const DAY = 86400000;
const calm = {
  now: NOW,
  managed: { provider: "NEAR AI", credit: { left: 100, days: 90 } },
  near: { signedIn: true, until: new Date(NOW + 6 * DAY).toISOString(), failedAt: null },
  bugs: { open: 0 }, messages: 0,
  backup: { count: 14, newest: new Date(NOW - 8 * 3600000).toISOString() },
  crypto: { networks: ["Ethereum", "Polygon"], behind: [] },
  cards: { payments: 0, usd: 0 },
  github: { runs: { checks: { conclusion: "success" }, mac: { conclusion: "success" } } },
  urls: { used: 3, limit: 100, you: { used: 1 } },
};
const said = (over) => needsOf({ ...calm, ...over }).map((n) => n.what).join(" | ");

test("a quiet day needs nothing", () => {
  assert.deepEqual(needsOf(calm), []);
});

test("each thing that is wrong is said, with what to do", () => {
  assert.match(said({ near: { signedIn: false, until: null, failedAt: new Date(NOW).toISOString() } }), /NEAR AI sign-in has stopped working/);
  assert.match(said({ near: { signedIn: true, until: new Date(NOW + DAY).toISOString(), failedAt: null } }), /sign-in has stopped working/, "about to run out means renewing failed");
  assert.match(said({ managed: { provider: "NEAR AI", credit: { left: 9, days: 6 } } }), /credit lasts about 6 more days/);
  assert.match(said({ managed: { provider: "NEAR AI", credit: { left: 0, days: 0 } } }), /credit is used up/);
  assert.match(said({ managed: { provider: "NEAR AI", credit: null } }), /can't read NEAR AI's credit/);
  assert.match(said({ bugs: { open: 2 } }), /2 bug reports are open/);
  assert.match(said({ messages: 1 }), /1 message from the site is waiting/);
  assert.match(said({ crypto: { networks: ["Ethereum", "Polygon"], behind: ["Polygon"] } }), /isn't keeping up with Polygon/);
  assert.match(said({ crypto: { error: true } }), /can't reach BTCPay/);
  assert.match(said({ cards: { error: true } }), /can't reach Polar/);
  assert.match(said({ backup: { count: 14, newest: new Date(NOW - 3 * DAY).toISOString() } }), /newest backup is 3 days old/);
  assert.match(said({ backup: { error: true } }), /can't list its backups/);
  assert.match(said({ github: { runs: { checks: { conclusion: "failure" }, mac: { conclusion: "success" } } } }), /checks failed on the latest push/);
  assert.match(said({ github: { runs: { checks: { conclusion: "success" }, mac: { conclusion: "cancelled" } } } }), /last Mac build did not finish/);
  assert.match(said({ urls: { ...calm.urls, used: 79 } }), /80% of personal URLs are taken/, "the maintainer's own count too");
  for (const need of needsOf({ ...calm, bugs: { open: 1 }, messages: 2, crypto: { error: true } })) assert.ok(need.do, need.what);
});

test("what isn't set up is not called wrong", () => {
  assert.deepEqual(needsOf({ ...calm, near: null, crypto: null, cards: null, backup: null, github: null, managed: {} }), []);
});
