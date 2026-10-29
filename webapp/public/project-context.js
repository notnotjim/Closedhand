// project-context.js: adding context to a project, the same on its page and
// in its form on the dashboard: files, a note, a link, or an email, event or
// message from connected apps. adder(onAdd, { added }) returns the choices and
// the box each opens. onAdd gets one of
//   { kind: "files", files: [File] }   { kind: "note", title, text }
//   { kind: "link", url, title }       { kind: "item", item }
// and may return a promise: the page saves at once, the form keeps it until
// Save. added(item) says whether an app item is already in the project;
// closed() is called when a choice's box closes.
(() => {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const btn = (cls, text, onclick) => { const b = el("button", cls, text); b.type = "button"; if (onclick) b.onclick = onclick; return b; };
  const KIND = { file: "File", note: "Note", link: "Link", email: "Email", event: "Event", message: "Message", page: "Page" };
  const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  function adder(onAdd, { added = () => false, closed = () => {} } = {}) {
    const wrap = el("div", "context-add");
    const actions = el("div", "context-actions");
    const box = el("div", "context-adder");
    const open = (build) => { box.textContent = ""; box.append(build()); const first = box.querySelector("input, textarea"); if (first) first.focus(); };
    const close = () => { box.textContent = ""; closed(); };
    const fail = (where, e) => { where.querySelectorAll(".project-hint.error").forEach((n) => n.remove()); const p = el("p", "project-hint error", e.message || String(e)); where.append(p); };

    const fileInput = el("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true;
    fileInput.onchange = async () => {
      const files = [...fileInput.files]; fileInput.value = "";
      if (files.length) { try { await onAdd({ kind: "files", files }); } catch (e) { fail(wrap, e); } }
    };
    const filesBtn = el("label", "goal-small", "Add files"); filesBtn.append(fileInput);

    actions.append(filesBtn,
      btn("goal-small", "Write a note", () => open(() => {
        const b = el("div", "context-box");
        const t = el("input"); t.type = "text"; t.placeholder = "Title (optional)"; t.maxLength = 120;
        const body = el("textarea"); body.rows = 5; body.placeholder = "Anything Closedhand should know: a brief, details, pasted text";
        const row = el("div", "goal-new-actions");
        row.append(btn("goal-small", "Add note", async () => {
          if (!body.value.trim()) return;
          try { await onAdd({ kind: "note", title: t.value.trim(), text: body.value }); close(); } catch (e) { fail(b, e); }
        }), btn("goal-small goal-quiet", "Cancel", close));
        b.append(t, body, row);
        return b;
      })),
      btn("goal-small", "Add a link", () => open(() => {
        const b = el("div", "context-box");
        const u = el("input"); u.type = "url"; u.placeholder = "https://";
        const t = el("input"); t.type = "text"; t.placeholder = "What it is (optional)"; t.maxLength = 120;
        const row = el("div", "goal-new-actions");
        row.append(btn("goal-small", "Add link", async () => {
          if (!/^https?:\/\/\S+$/i.test(u.value.trim())) { u.setCustomValidity("Enter a web address starting with https://"); u.reportValidity(); return; }
          try { await onAdd({ kind: "link", url: u.value.trim(), title: t.value.trim() }); close(); } catch (e) { fail(b, e); }
        }), btn("goal-small goal-quiet", "Cancel", close));
        u.oninput = () => u.setCustomValidity("");
        b.append(u, t, row);
        return b;
      })),
      btn("goal-small", "Add an email, event or message", () => open(() => {
        const b = el("div", "context-box");
        const q = el("input"); q.type = "search"; q.placeholder = "Search your email, calendar and chats";
        const results = el("div", "context-results");
        let timer = null, seq = 0;
        q.oninput = () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const mine = ++seq;
            if (q.value.trim().length < 2) { results.textContent = ""; return; }
            try {
              const res = await fetch("/api/projects/find?q=" + encodeURIComponent(q.value.trim()));
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
              if (mine !== seq) return;
              results.textContent = "";
              if (!data.items.length) results.append(el("p", "project-hint", "Nothing synced matches that."));
              for (const it of data.items) {
                const already = added(it);
                const row = el("div", "context-row");
                const meta = [KIND[it.kind] || "Item", it.from, it.at ? shortDate(it.at) : ""].filter(Boolean).join(" · ");
                const text = el("span", "context-title"); text.append(el("span", "", it.title), el("span", "context-meta", meta));
                const add = btn("goal-small", already ? "Added" : "Add", async () => {
                  add.disabled = true;
                  try { await onAdd({ kind: "item", item: it }); add.textContent = "Added"; } catch (e) { add.disabled = false; fail(b, e); }
                });
                add.disabled = already;
                row.append(el("span", "context-kind", KIND[it.kind] || "Item"), text, add);
                results.append(row);
              }
            } catch (e) { results.textContent = ""; results.append(el("p", "project-hint", e.message)); }
          }, 250);
        };
        const row = el("div", "goal-new-actions");
        row.append(btn("goal-small goal-quiet", "Done", close));
        b.append(q, results, row);
        return b;
      })));
    wrap.append(actions, box);
    return wrap;
  }

  window.ProjectContext = { adder, KIND };
})();
