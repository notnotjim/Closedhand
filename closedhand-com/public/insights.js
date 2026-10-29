// The insights page (lib/insights.js), drawn from /api/insights as pictures
// first: tiles for the headline numbers, the steps from download to daily
// use, a weekly chart, and a square for each personal URL closedhand.com can
// give out. Then everyone, and the bug reports.
(() => {
  const $ = id => document.getElementById(id);
  const n = v => (v == null || Number.isNaN(Number(v)) ? 'n/a' : Number(v).toLocaleString('en-GB'));
  const pct = (part, whole) => (whole > 0 ? Math.round(part / whole * 100) : 0);
  const day = v => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const when = v => (v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const usd = v => (v == null || Number.isNaN(Number(v)) ? 'n/a' : '$' + Number(v).toFixed(2));
  const weekOf = v => new Date(v + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // How long ago, in the largest whole unit that fits.
  function ago(v) {
    if (!v) return 'never';
    const s = (Date.now() - new Date(v)) / 1000;
    if (s < 3600) return 'within the hour';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    const days = Math.floor(s / 86400);
    return days === 1 ? 'yesterday' : days + ' days ago';
  }
  // The same four bands the personal URL squares use.
  function band(v) {
    if (!v) return 'never';
    const h = (Date.now() - new Date(v)) / 3600000;
    return h < 24 ? 'today' : h < 168 ? 'week' : h < 720 ? 'month' : 'quiet';
  }

  // A bar split into parts, each as wide as its share.
  function split(parts) {
    const bar = el('div', 'split');
    for (const [label, value, cls] of parts) {
      if (!value) continue;
      const part = el('span', cls);
      part.style.flexGrow = value;
      part.title = `${label}: ${n(value)}`;
      bar.append(part);
    }
    return bar;
  }
  function meter(part, whole, cls) {
    const bar = el('div', 'split');
    const fill = el('span', cls);
    fill.style.flex = `0 0 ${whole > 0 ? Math.min(100, part / whole * 100) : 0}%`;
    bar.append(fill);
    return bar;
  }
  function tile({ label, value, chip, bar, sub, tone }) {
    const t = el('div', 'tile' + (tone ? ' ' + tone : ''));
    t.append(el('p', 'tile-label', label));
    const line = el('p', 'tile-value', value);
    if (chip) line.append(el('span', 'chip up', chip));
    t.append(line);
    if (bar) t.append(bar);
    if (sub) t.append(el('p', 'tile-sub', sub));
    return t;
  }

  function drawTiles(d) {
    const a = d.accounts, u = d.urls, g = d.github, mac = g ? g.macTotal : 0, installs = d.installs.total, latest = g && g.macLatest;
    $('tiles').replaceChildren(
      tile({ label: 'Closedhand accounts', value: n(a.total), chip: a.week ? `+${n(a.week)} this week` : '',
        bar: split([['Google', a.google, 'tone-a'], ['Microsoft', a.microsoft, 'tone-b']]),
        sub: `${n(a.google)} Google, ${n(a.microsoft)} Microsoft` }),
      tile({ label: 'Personal URLs taken', value: n(u.used), bar: meter(u.used, u.limit, u.limit > 0 && u.used / u.limit >= 0.8 ? 'tone-warn' : 'tone-b'),
        sub: `of ${n(u.limit)}. Past ${n(u.limit)} nobody new can claim one.`, tone: u.limit > 0 && u.used / u.limit >= 0.8 ? 'warn' : '' }),
      tile({ label: 'Online today', value: n(u.day), bar: meter(u.day, u.working, 'tone-today'),
        sub: `of ${n(u.working)} personal ${u.working === 1 ? 'URL' : 'URLs'} working` }),
      tile({ label: 'Downloads', value: n(mac + installs),
        bar: split([['Mac app', mac, 'tone-a'], ['Install command', installs, 'tone-b']]),
        sub: g ? `${n(mac)} Mac app${latest ? ` (${n(latest.downloads)} of ${latest.version})` : ''}, ${n(installs)} install command` : `${n(installs)} install command. GitHub didn't answer.` }),
    );
    $('more').replaceChildren(
      tile({ label: 'Bug reports open', value: n(d.bugs.open), chip: d.bugs.week ? `+${n(d.bugs.week)} this week` : '',
        sub: d.bugs.open ? 'Listed at the bottom' : 'All clear', tone: d.bugs.open ? 'warn' : 'good' }),
      tile({ label: 'GitHub stars', value: g ? n(g.stars) : 'n/a', sub: g ? `${n(g.forks)} ${g.forks === 1 ? 'fork' : 'forks'}` : "GitHub didn't answer" }),
      tile({ label: 'Managed Models this month', value: usd(d.managed.spentThisMonth),
        sub: `${n(d.managed.running)} first ${d.managed.running === 1 ? 'month' : 'months'} running (${usd(d.managed.allowance)} allowed), ` +
          `${n(d.managed.plus.active || 0)} Closedhand+` + (d.managed.spentThisMonth == null ? '. OpenRouter didn\'t answer.' : '') }),
      tile({ label: 'Closedhand email', value: n(d.email.accounts), sub: `${d.email.accounts === 1 ? 'address' : 'addresses'} on, ${n(d.email.sent)} sent and ${n(d.email.received)} received this month` }),
    );
  }

  function drawFunnel(d) {
    const g = d.github, downloads = (g ? g.macTotal : 0) + d.installs.total;
    const steps = [
      ['Downloads', downloads, 'downloads', 'Mac app and install command together'],
      ['Closedhand accounts', d.accounts.total, 'accounts', 'Signed in on closedhand.com'],
      ['Personal URLs working', d.urls.working, 'working URLs', 'Claimed and connected'],
      ['Online this week', d.urls.week, '', 'Their computer connected in the last 7 days'],
    ];
    // Each bar's track ends where the step before ended, and its fill is the
    // share of that step that made it here, the same share the note states.
    const max = Math.max(1, ...steps.map(s => s[1] || 0));
    $('funnel').replaceChildren(...steps.map(([label, value, , note], i) => {
      const step = el('div', 'step');
      const head = el('div', 'step-head');
      head.append(el('span', 'step-label', label), el('span', 'step-value', n(value)));
      const before = steps[i - 1], from = before ? before[1] || 0 : max;
      const track = el('div', 'step-track'), fill = el('span');
      track.style.width = (from ? Math.max(from / max * 100, 3) : 3) + '%';
      fill.style.width = (from && value ? Math.min(100, value / from * 100) : 0) + '%';
      track.append(fill);
      step.append(head, track, el('p', 'step-note', before ? `${pct(value, before[1])}% of ${before[2]}. ${note}.` : `${note}.`));
      return step;
    }));
  }

  const SERIES = [
    ['installs', 'Install command', 'tone-b'],
    ['accounts', 'New accounts', 'tone-new'],
    ['claimed', 'Personal URLs claimed', 'tone-today'],
  ];
  function drawWeeks(weeks) {
    const max = Math.max(1, ...weeks.flatMap(w => SERIES.map(([k]) => w[k] || 0)));
    $('weeks-key').replaceChildren(...SERIES.map(([k, label, cls]) => {
      const li = el('li');
      li.append(el('i', cls), `${label}, ${n(weeks.reduce((s, w) => s + (w[k] || 0), 0))} in ${weeks.length} weeks`);
      return li;
    }));
    const chart = $('weeks');
    chart.replaceChildren(...weeks.map((w, i) => {
      const col = el('div', 'col'), bars = el('div', 'bars');
      for (const [k, label, cls] of SERIES) {
        const v = w[k] || 0, bar = el('span', 'bar ' + cls);
        bar.style.height = (v / max * 100) + '%';
        bar.title = `${label}, week of ${weekOf(w.week)}: ${n(v)}`;
        if (v) bar.append(el('b', '', n(v)));
        bars.append(bar);
      }
      col.append(bars, el('span', 'col-label', i === weeks.length - 1 ? 'This week' : weekOf(w.week)));
      return col;
    }));
    chart.setAttribute('aria-label', weeks.map(w => `Week of ${weekOf(w.week)}: ` + SERIES.map(([k, label]) => `${n(w[k] || 0)} ${label.toLowerCase()}`).join(', ')).join('. '));
  }

  function drawGrid(u) {
    const limit = u.limit > 0 ? u.limit : 100, per = Math.max(1, Math.ceil(limit / 100)), cells = Math.ceil(limit / per);
    const at0 = v => Math.max(0, v || 0);
    const groups = [
      ['today', 'Online today', at0(u.day)],
      ['week', 'Online this week', at0(u.week - u.day)],
      ['month', 'Online this month', at0(u.month - u.week)],
      ['quiet', 'Quiet for over a month', at0(u.working - u.month)],
      ['starting', 'Still setting up', at0(u.used - u.working)],
    ];
    const grid = $('grid');
    grid.textContent = '';
    let drawn = 0;
    for (const [cls, label, count] of groups) {
      for (let i = 0; i < Math.ceil(count / per) && drawn < cells; i++, drawn++) {
        const cell = el('span', 'tone-' + cls);
        cell.title = label;
        grid.append(cell);
      }
    }
    for (; drawn < cells; drawn++) grid.append(el('span', 'tone-free'));
    const free = at0(limit - u.used);
    grid.setAttribute('aria-label', groups.map(([, label, count]) => `${n(count)} ${label.toLowerCase()}`).join(', ') + `, ${n(free)} free`);
    $('grid-note').textContent = (per === 1 ? `Each square is one of the ${n(limit)} personal URLs closedhand.com can give out.`
      : `Each square is ${n(per)} of the ${n(limit)} personal URLs closedhand.com can give out.`) +
      ' Online means the computer running Closedhand connected.';
    const key = groups.filter(g => g[2]).map(([cls, label, count]) => {
      const li = el('li');
      li.append(el('i', 'tone-' + cls), `${n(count)} ${label.toLowerCase()}`);
      return li;
    });
    const room = el('li');
    room.append(el('i', 'tone-free'), `${n(free)} free`);
    key.push(room);
    if (u.errors) key.push(el('li', 'warn', `${n(u.errors)} stuck with an error`));
    $('grid-key').replaceChildren(...key);
    const dns = $('dns'), head = el('div', 'meter-head'), full = u.dns != null && u.dns / u.dnsCeiling > 0.8;
    head.append(el('span', '', 'DNS records'), el('span', full ? 'warn' : '', u.dns == null ? 'n/a' : `${n(u.dns)} of ${n(u.dnsCeiling)}`));
    dns.replaceChildren(head, meter(u.dns || 0, u.dnsCeiling, full ? 'tone-warn' : 'tone-b'),
      el('p', 'step-note', 'New personal URLs stop at the ceiling, so this needs room.'));
  }

  // Everything held about one person, opened from their email. This
  // month's Managed Models use is read from OpenRouter when it opens.
  function firstMonth(p) {
    if (p.first_month_usd == null) return 'None';
    const ended = p.first_month_stopped || (p.first_month_until && new Date(p.first_month_until) <= Date.now());
    return `${usd(p.first_month_usd)} allowance, ${when(p.first_month_from)} to ${when(p.first_month_until)}` +
      (p.first_month_stopped ? `, stopped ${when(p.first_month_stopped)}` : ended ? ', ended' : '');
  }
  function plusLine(p) {
    if (!p.plus_status) return 'None';
    return `${p.plus_status}` + (p.plus_since ? ` since ${when(p.plus_since)}` : '') +
      (p.plus_until ? `, ${p.plus_cancels ? 'ends' : 'renews'} ${when(p.plus_until)}` : '') +
      (p.plus_extended ? ', carried on past fair use this month' : '');
  }
  function details(p) {
    const box = el('dl', 'person-details');
    const row = (label, value) => { box.append(el('dt', '', label), el('dd', '', value)); return box.lastChild; };
    const signIns = [`${p.provider === 'microsoft' ? 'Microsoft' : 'Google'} ${p.email || '(no email given)'}${p.email_verified ? '' : ' (unverified)'}`]
      .concat((p.more_sign_ins || []).map(s => `${s.provider === 'microsoft' ? 'Microsoft' : 'Google'} ${s.email || '(no email given)'}`));
    row('Signs in with', signIns.join(', '));
    row('Signed up', when(p.signed_up));
    row('Personal URL', p.hostname ? `${p.hostname} (${p.state})${p.claimed ? `, claimed ${when(p.claimed)}` : ''}` : p.held_name ? `Name held: ${p.held_name}` : 'None');
    if (p.hostname) row('Last online', p.last_online ? `${when(p.last_online)} (${ago(p.last_online)})` : 'Never');
    if (p.renames) row('Renamed', `${n(p.renames)} ${p.renames === 1 ? 'time' : 'times'}`);
    row('Closedhand email', p.assistant_email ? `${p.assistant_email}: ${n(p.email_sent)} sent, ${n(p.email_received)} received this month` : 'Off');
    row('First month', firstMonth(p));
    row('Closedhand+', plusLine(p));
    if (p.first_month_usd != null || p.plus_status) {
      const used = row('Managed Models use', 'Reading from OpenRouter…');
      fetch('/api/insights/person/' + encodeURIComponent(p.id), { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : Promise.reject()))
        .then(d => { used.textContent = d.usage ? `${usd(d.usage.used)} of ${usd(d.usage.limit)} (${pct(d.usage.used, d.usage.limit)}%)` : 'No key at OpenRouter'; })
        .catch(() => { used.textContent = "OpenRouter didn't answer"; });
    }
    row('Account id', p.id);
    return box;
  }

  let everyone = [];
  const open = new Set();
  function drawPeople() {
    const q = $('search').value.trim().toLowerCase();
    const shown = everyone.filter(p => !q || [p.email, p.hostname, p.held_name, p.assistant_email, ...(p.more_sign_ins || []).map(s => s.email)].some(v => v && v.toLowerCase().includes(q)));
    $('people-list').replaceChildren(...shown.map(p => {
      const li = el('li', 'person');
      li.append(el('span', 'avatar', (p.email || '?').charAt(0).toUpperCase()));
      const main = el('div', 'person-main');
      const head = el('p', 'person-head');
      const seen = el('span', 'person-seen');
      seen.append(el('i', 'dot tone-' + (p.hostname ? band(p.last_online) : 'never')), !p.hostname ? 'no personal URL' : p.last_online ? 'online ' + ago(p.last_online) : 'never online');
      const name = el('button', 'person-email', p.email || '(no email given)');
      name.type = 'button';
      name.setAttribute('aria-expanded', String(open.has(p.id)));
      head.append(name, seen);
      main.append(head);
      const line = el('p', 'person-url');
      if (p.hostname) {
        const link = el('a', '', p.hostname);
        link.href = 'https://' + p.hostname; link.rel = 'noopener noreferrer'; link.target = '_blank';
        line.append(link);
        if (p.state !== 'active') line.append(el('span', 'chip warn', p.state));
      } else line.textContent = p.held_name ? `Name held: ${p.held_name}` : 'Signed in, nothing claimed';
      main.append(line);
      const chips = el('p', 'chips');
      chips.append(el('span', 'chip', p.provider === 'microsoft' ? 'Microsoft' : 'Google'));
      if (!p.email_verified) chips.append(el('span', 'chip warn', 'email unverified'));
      chips.append(el('span', 'chip', 'signed up ' + day(p.signed_up)));
      if (p.claimed) chips.append(el('span', 'chip', 'claimed ' + day(p.claimed)));
      if (p.renames) chips.append(el('span', 'chip', `renamed ${p.renames}x`));
      if (p.assistant_email) chips.append(el('span', 'chip', `${p.assistant_email}: ${n(p.email_sent)} sent, ${n(p.email_received)} received this month`));
      if (p.plus_status) chips.append(el('span', 'chip' + (p.plus_status === 'active' ? ' up' : ''), 'Closedhand+ ' + p.plus_status));
      else if (p.first_month_usd != null && !p.first_month_stopped && new Date(p.first_month_until) > Date.now()) chips.append(el('span', 'chip', 'first month to ' + day(p.first_month_until)));
      main.append(chips);
      let more = open.has(p.id) ? details(p) : null;
      if (more) main.append(more);
      name.addEventListener('click', () => {
        if (more) { more.remove(); more = null; open.delete(p.id); }
        else { more = details(p); main.append(more); open.add(p.id); }
        name.setAttribute('aria-expanded', String(!!more));
      });
      li.append(main);
      return li;
    }));
    $('everyone-title').textContent = q ? `Everyone (${shown.length} of ${everyone.length})` : `Everyone (${everyone.length})`;
  }
  $('search').addEventListener('input', drawPeople);

  // Where the report was sent from.
  const PLATFORMS = { web: 'web chat', dashboard: 'dashboard', telegram: 'Telegram', whatsapp: 'WhatsApp', whatsapp_linked: 'WhatsApp',
    slack: 'Slack', discord: 'Discord', line: 'LINE', email: 'email', own_email: 'email' };
  function drawReports(d) {
    const list = d.reports || [];
    $('reports-title').textContent = d.bugs.open ? `Bug reports (${n(d.bugs.open)} open)` : 'Bug reports';
    if (!list.length) {
      $('reports').replaceChildren(el('li', 'empty', 'None yet. Reports people choose to send arrive here.'));
      return;
    }
    $('reports').replaceChildren(...list.map(r => {
      const li = el('li', 'report');
      const head = el('p', 'chips');
      head.append(el('span', 'pill ' + (r.status === 'open' ? 'warn' : r.status === 'resolved' ? 'good' : ''), r.status), el('span', 'report-day', day(r.created_at)));
      if (r.platform) head.append(el('span', 'chip', PLATFORMS[r.platform] || r.platform));
      if (r.app_version) head.append(el('span', 'chip', r.app_version));
      if (r.resolved_at) head.append(el('span', 'chip', 'resolved ' + day(r.resolved_at)));
      li.append(head, el('p', 'report-text', r.comment || '(no comment)'));
      return li;
    }));
  }

  function draw(d) {
    drawTiles(d);
    drawFunnel(d);
    drawWeeks(d.weeks || []);
    drawGrid(d.urls);
    everyone = d.people || [];
    drawPeople();
    drawReports(d);
    $('updated').textContent = 'Only you can open this page. Updated ' +
      new Date(d.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '.';
  }
  async function load() {
    try {
      const response = await fetch('/api/insights', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      draw(await response.json());
      $('status').textContent = '';
    } catch (_) { $('status').textContent = 'Could not load the numbers. Reload to try again.'; }
  }
  // Possible misuse: shown only when there is something to report.
  async function loadMisuse() {
    try {
      const response = await fetch('/api/insights/misuse', { cache: 'no-store' });
      if (!response.ok) return;
      const d = await response.json();
      if (!d.signs || !d.signs.length) return;
      $('misuse-summary').textContent = d.summary || "Closedhand couldn't write a summary just now. The signs it found are below.";
      $('misuse-signs').replaceChildren(...d.signs.map(text => el('li', 'misuse-sign', text)));
      $('misuse').hidden = false;
    } catch (_) { /* nothing shown */ }
  }
  load();
  loadMisuse();
})();
