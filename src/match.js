// Keyword matching. Used on its own when no AI key is set, as the AI's shortlist,
// and as the fallback when the AI provider is down.
// Words are weighted by how rare they are across the hotel's SOPs, so a specific word
// ("dog", "crib") beats a generic one ("need", "bring", "check").
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const STOP = new Set(
  "the a an and or to of for in on at is are be can do does did how what when where who why with my our your their they them it its this that there i we you he she his her me us has have had will would should could just get got want wants wanted guest guests someone somebody please".split(" ")
);
const stem = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const toks = (s) => norm(s).replace(/\bwi fi\b/g, "wifi").replace(/\bcheck in\b/g, "checkin").replace(/\bcheck out\b/g, "checkout").split(" ").filter(Boolean).map(stem);

// Per-SOP index, cached per SOP list (keyed by the array and its contents).
let cache = { key: null, idx: null };
function index(sops) {
  const key = sops.map((s) => s.id + ":" + (s.updated_at || s.updated || s.version || s.ver || "") + ":" + s.title + ":" + (s.keywords ?? s.kw ?? "")).join("|");
  if (cache.key === key) return cache.idx;
  const docs = sops.map((s) => {
    const kw = String(s.keywords ?? s.kw ?? "").split(",").map(toks).filter((p) => p.length);
    const title = new Set(toks(s.title).filter((w) => !STOP.has(w)));
    const kwSet = new Set(kw.flat().filter((w) => !STOP.has(w)));
    return { s, kw, title, kwSet };
  });
  const df = {};
  for (const d of docs) for (const w of new Set([...d.title, ...d.kwSet])) df[w] = (df[w] || 0) + 1;
  const N = Math.max(1, docs.length);
  const idf = (w) => Math.log((N + 1) / ((df[w] || 0) + 1)) + 0.2;
  cache = { key, idx: { docs, idf } };
  return cache.idx;
}

const hasSeq = (q, p) => {
  outer: for (let i = 0; i + p.length <= q.length; i++) {
    for (let j = 0; j < p.length; j++) if (q[i + j] !== p[j]) continue outer;
    return true;
  }
  return false;
};

function rank(question, sops, limit = 8) {
  const { docs, idf } = index(sops);
  const q = toks(question);
  const words = [...new Set(q.filter((w) => w.length > 1 && !STOP.has(w)))];
  if (!words.length) return [];
  const out = [];
  for (const d of docs) {
    let sc = 0;
    // Whole keyword phrases found in the question; longer phrases count for more.
    for (const p of d.kw) {
      const content = p.filter((w) => !STOP.has(w));
      if (content.length && hasSeq(q, p)) sc += content.reduce((a, w) => a + idf(w), 0) * (1 + 0.5 * (p.length - 1));
    }
    // Single words that appear in the title or keywords.
    for (const w of words) {
      if (d.title.has(w)) sc += idf(w) * 0.8;
      else if (d.kwSet.has(w)) sc += idf(w) * 0.4;
    }
    if (sc > 0) out.push({ s: d.s, sc: Math.round(sc * 100) / 100 });
  }
  return out.sort((a, b) => b.sc - a.sc).slice(0, limit);
}

const THRESHOLD = 2.5;
function best(question, sops) {
  const top = rank(question, sops, 1)[0];
  return top && top.sc >= THRESHOLD ? top.s : null;
}

module.exports = { norm, rank, best, THRESHOLD };
