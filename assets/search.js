// Client-side search over the page: BM25 ranking with prefix and fuzzy
// expansion. Every element marked [data-doc] is one searchable document.
(() => {
  const K1 = 1.2;
  const B = 0.75;
  const MAX_HITS = 5;
  const MAX_PER_SOURCE = 2;
  const FIRST_QUERY = "retrieval";

  const STOP = new Set(
    "a an and are as at be by for from in into is it its of on or our over that the this to using with i my me we".split(" ")
  );
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}+#]*(?:\.[\p{L}\p{N}]+)*/gu;

  // Fold case and diacritics so "Akçin" matches "akcin" and "İstanbul" matches "istanbul".
  const fold = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");

  // A light plural stemmer: enough for "agents" to find "agent".
  const stem = (t) => {
    if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
    if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
    return t;
  };

  const tokenize = (s) =>
    (fold(s).match(WORD) || []).filter((t) => !STOP.has(t)).map(stem);

  const esc = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Build the index from the page itself.
  const docs = [...document.querySelectorAll("[data-doc]")].map((el, i) => {
    if (!el.id) el.id = "item-" + (i + 1);
    const titled = el.closest("[data-title]");
    const title = el.dataset.title || titled?.dataset.title || "";
    const kind = el.closest("[data-kind]")?.dataset.kind || "";
    const text = el.textContent.replace(/\s+/g, " ").trim();
    const snippetEl = el.querySelector("[data-snippet]");
    const snippetText = snippetEl ? snippetEl.textContent.replace(/\s+/g, " ").trim() : text;

    const tf = new Map();
    const add = (s, weight) => tokenize(s).forEach((t) => tf.set(t, (tf.get(t) || 0) + weight));
    add(text, 1);
    add(title, 2);
    add(el.dataset.tags || "", 1.5);

    return { id: el.id, title, kind, text, snippetText, tf, len: tokenize(text).length };
  });

  const df = new Map();
  docs.forEach((d) => d.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  const vocab = [...df.keys()];
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / docs.length;
  const idf = (t) => Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));

  // Edit distance that counts a swap of two neighbouring letters as one edit ("neoj4" -> "neo4j").
  function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let before = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          row[j] = Math.min(row[j], before[j - 2] + 1);
        }
        best = Math.min(best, row[j]);
      }
      if (best > limit) return limit + 1;
      before = prev;
      prev = row;
    }
    return prev[b.length];
  }

  // Each query term expands to [term, weight] pairs: exact, prefixes, then a fuzzy fallback.
  function expand(term) {
    const out = [];
    if (df.has(term)) out.push([term, 1]);
    if (term.length >= 2) {
      vocab
        .filter((v) => v !== term && v.startsWith(term))
        .sort((a, b) => a.length - b.length)
        .slice(0, 8)
        .forEach((v) => out.push([v, 0.75]));
    }
    if (out.length || term.length < 4) return { pairs: out, fixed: term, corrected: false };

    const limit = term.length >= 7 ? 2 : 1;
    let best = null;
    let bestDist = limit + 1;
    for (const v of vocab) {
      const d = distance(term, v, limit);
      if (d < bestDist || (d === bestDist && best && df.get(v) > df.get(best))) {
        best = v;
        bestDist = d;
      }
    }
    return best
      ? { pairs: [[best, 0.7]], fixed: best, corrected: true }
      : { pairs: [], fixed: term, corrected: false };
  }

  function search(query) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return { hits: [], corrected: null };

    const expanded = terms.map(expand);
    const phrase = terms.length > 1 ? fold(query.trim()) : null;

    const scored = docs
      .map((d) => {
        let score = 0;
        let covered = 0;
        const matched = new Set();
        for (const { pairs } of expanded) {
          let best = 0;
          for (const [t, w] of pairs) {
            const f = d.tf.get(t);
            if (!f) continue;
            matched.add(t);
            const s = w * idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen)));
            best = Math.max(best, s);
          }
          if (best > 0) covered++;
          score += best;
        }
        score *= 0.5 + 0.5 * (covered / terms.length);
        if (phrase && fold(d.text).includes(phrase)) score *= 1.25;
        return { ...d, score, matched };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score);

    // Keep the list varied: at most two hits from the same role, project or group.
    const perSource = new Map();
    const hits = [];
    for (const d of scored) {
      const n = perSource.get(d.title) || 0;
      if (n >= MAX_PER_SOURCE) continue;
      perSource.set(d.title, n + 1);
      hits.push(d);
      if (hits.length === MAX_HITS) break;
    }

    const top = hits[0]?.score || 1;
    hits.forEach((h) => (h.relative = h.score / top));

    const corrected = expanded.some((e) => e.corrected) ? expanded.map((e) => e.fixed).join(" ") : null;
    return { hits, corrected };
  }

  function snippet(text, matched, max = 170) {
    const words = [...text.matchAll(WORD)];
    const isHit = (w) => matched.has(stem(fold(w)));
    const first = words.find((m) => isHit(m[0]));

    let start = 0;
    if (first && first.index > 70) start = text.lastIndexOf(" ", first.index - 50) + 1;
    let end = Math.min(text.length, start + max);
    if (end < text.length) end = Math.max(text.lastIndexOf(" ", end), start + 1);

    let html = "";
    let pos = start;
    for (const m of words) {
      if (m.index < start) continue;
      if (m.index + m[0].length > end) break;
      html += esc(text.slice(pos, m.index));
      html += isHit(m[0]) ? `<mark>${esc(m[0])}</mark>` : esc(m[0]);
      pos = m.index + m[0].length;
    }
    html += esc(text.slice(pos, end));
    return (start > 0 ? "…" : "") + html + (end < text.length ? "…" : "");
  }

  const input = document.getElementById("q");
  const status = document.getElementById("status");
  const list = document.getElementById("results");
  const chips = [...document.querySelectorAll(".chips button")];

  function render() {
    const query = input.value;
    chips.forEach((c) =>
      c.setAttribute("aria-pressed", String(fold(c.dataset.q) === fold(query.trim())))
    );

    if (!query.trim()) {
      list.innerHTML = "";
      status.textContent = "Pick an example or start typing.";
      return;
    }

    const { hits, corrected } = search(query);
    if (!hits.length) {
      list.innerHTML = "";
      status.innerHTML = `Nothing matches <b>“${esc(query.trim())}”</b>. Try a tool such as Elasticsearch or a topic such as FPGA.`;
      return;
    }

    const count = `${hits.length} ${hits.length === 1 ? "result" : "results"}`;
    status.innerHTML = corrected
      ? `${count} for <b>“${esc(corrected)}”</b>. No exact match for “${esc(query.trim())}”.`
      : `${count}, best match first.`;

    list.innerHTML = hits
      .map(
        (h) => `<li><a class="hit" href="#${h.id}">
          <span class="hit-kind">${esc(h.kind)}</span>
          <span class="hit-title">${esc(h.title)}</span>
          <span class="hit-text">${snippet(h.snippetText, h.matched)}</span>
          <span class="hit-score" aria-label="Relevance ${h.relative.toFixed(2)}"><span class="bar" style="--w:${h.relative.toFixed(3)}"></span>${h.relative.toFixed(2)}</span>
        </a></li>`
      )
      .join("");
  }

  input.addEventListener("input", render);

  chips.forEach((c) =>
    c.addEventListener("click", () => {
      input.value = c.dataset.q;
      render();
    })
  );

  // Skills jump back up to the search and show where each one was used.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.querySelectorAll(".skills button[data-q]").forEach((b) => {
    b.setAttribute("aria-controls", "results");
    b.addEventListener("click", () => {
      input.value = b.dataset.q;
      render();
      document.getElementById("finder").scrollIntoView({
        behavior: reduceMotion.matches ? "auto" : "smooth",
        block: "start",
      });
      list.focus({ preventScroll: true });
    });
  });

  input.value = FIRST_QUERY;
  render();
})();
