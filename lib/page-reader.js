// lib/page-reader.js: a web page as the words someone reading it would see.
//
// One reader for every page Closedhand reads, fetched plainly (web_fetch) or
// in the sandbox computer's browser (lib/browse-engine.js). An article is
// picked out the way Firefox's Reader View does it (Mozilla Readability);
// any other page (a timetable, a shop, a results list) is read whole, without
// its menus, footers, cookie notices and pop-ups. Headings, lists, links and
// tables keep their shape, written as Markdown, so a price in a table still
// sits under its column. Nothing is cut: a long page is handed over in parts
// (textPart, lib/file-reader.js). Tag-stripping the raw HTML kept every menu
// and footer, ran a table's cells together, and stopped at 8,000 characters.

const { parseHTML } = require("linkedom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");
const { tables, strikethrough } = require("turndown-plugin-gfm");

// What is never the page's content. Not forms (some sites wrap the whole page
// in one) and not anything called a menu (a restaurant's is its content).
const CHROME = "script, style, noscript, template, svg, iframe, nav, aside, button, dialog, [role=navigation], [role=contentinfo], [role=dialog], [aria-hidden=true], [hidden]";
const CHROME_NAMES = /(^|[\s_-])(cookie|cookies|consent|gdpr|newsletter|subscribe|popup|pop-up|modal|overlay|advert|ads|advertisement|sponsored|breadcrumbs?|skip-link|navbar|sidebar)([\s_-]|$)/i;

function markdown() {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use([tables, strikethrough]);
  // A table with no header row is kept as rows of cells too, not as HTML.
  td.addRule("headlessTable", {
    filter: (node) => node.nodeName === "TABLE" && !node.querySelector("th, thead"),
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  td.remove(["script", "style", "noscript", "template", "svg", "iframe"]);
  // A link keeps its address only when it says where it goes.
  td.addRule("links", {
    filter: "a",
    replacement: (text, node) => {
      const href = node.getAttribute("href") || "";
      const words = text.trim();
      if (!words) return "";
      return /^https?:\/\//.test(href) && words !== href ? `[${words}](${href})` : words;
    },
  });
  td.addRule("images", { filter: "img", replacement: (_, node) => (node.getAttribute("alt") || "").trim() });
  return td;
}

function tidy(text) {
  return String(text || "").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The page's title and its words. `url` resolves relative links.
function readPage(html, url = "") {
  const source = String(html || "");
  if (!/<[a-z!]/i.test(source)) return { title: "", text: tidy(source), how: "text" };
  const { document } = parseHTML(source);
  const title = tidy(document.querySelector("title")?.textContent || "");
  const whole = tidy(document.body?.textContent || "").replace(/\s+/g, " ");
  // An article, when the page is one: Readability works on a copy.
  let article = null;
  try {
    const copy = parseHTML(source).document;
    article = new Readability(copy, { charThreshold: 300, keepClasses: false }).parse();
  } catch (_) { article = null; }
  const articleWords = tidy(article?.textContent || "").replace(/\s+/g, " ");
  if (article && articleWords.length >= 400 && articleWords.length >= whole.length * 0.25) {
    return { title: tidy(article.title || title), text: tidy(markdown().turndown(article.content || "")), how: "article" };
  }
  // Any other page, whole, without what is never its content.
  for (const el of [...document.querySelectorAll(CHROME)]) el.remove();
  // The site's own header and footer, not an article's.
  for (const el of [...document.querySelectorAll("header, footer, [role=banner]")]) if (!el.closest("main, article, [role=main]")) el.remove();
  for (const el of [...document.querySelectorAll("[class], [id]")]) {
    if (CHROME_NAMES.test(`${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`) && el.parentNode) el.remove();
  }
  const main = document.querySelector("main, [role=main]") || document.body || document.documentElement;
  return { title, text: tidy(markdown().turndown(main ? main.innerHTML || "" : "")), how: "page" };
}

// One part of a page's words, sized to sit in a tool result beside the
// others asked for at once, and saying how to read on.
function partOf(text, part = 1, { share = 1, readOn = "part" } = {}) {
  const { textPart, RESULT_PART } = require("./file-reader");
  const cut = textPart(text, part, require("./token-tracker").chatWindow(), Math.floor(RESULT_PART / Math.max(1, share)));
  const more = cut.part < cut.parts ? `\n\n[Part ${cut.part} of ${cut.parts}. Read on with ${readOn} ${cut.part + 1}.]` : cut.parts > 1 ? `\n\n[Part ${cut.part} of ${cut.parts}, the last.]` : "";
  return { text: cut.text + more, part: cut.part, parts: cut.parts };
}

module.exports = { readPage, partOf };
