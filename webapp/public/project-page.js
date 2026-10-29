// A project's page: its Context ends with the dashed "+ Add" tile every list
// people can add to ends with, opening the same choices as the project's form
// on the dashboard (project-context.js). Each is saved at once, and the page
// shows it: files, a note or a link straight away, things from apps when
// their search is closed.
(() => {
  const host = document.querySelector("[data-add-context]");
  if (!host || !window.ProjectContext) return;
  const id = host.dataset.addContext;
  async function call(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }
  const patch = (body) => call(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const have = new Set([...document.querySelectorAll("[data-ctx-id]")].map((n) => n.dataset.ctxId));
  let fromApps = false;
  const tile = host.querySelector(".add-tile");
  tile.onclick = () => {
    tile.hidden = true;
    host.append(window.ProjectContext.adder(async (x) => {
      if (x.kind === "item") { await patch({ add_items: [{ source: x.item.source, ref: x.item.ref }] }); have.add(x.item.id); fromApps = true; return; }
      if (x.kind === "files") {
        const fd = new FormData();
        for (const f of x.files) fd.append("files", f);
        const up = await call(`/api/projects/${id}/files`, { method: "POST", body: fd });
        if (up.refused && up.refused.length) { setTimeout(() => location.reload(), 2500); throw new Error(`Closedhand doesn't open ${up.refused.join(", ")}, so ${up.refused.length === 1 ? "it was" : "they were"} left out.`); }
      } else {
        await patch({ add_context: [x.kind === "note" ? { kind: "note", title: x.title, text: x.text } : { kind: "link", url: x.url, title: x.title }] });
      }
      location.reload();
    }, { added: (it) => have.has(it.id), closed: () => { if (fromApps) location.reload(); } }));
  };
})();
