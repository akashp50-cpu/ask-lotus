// Keyword matching. Used on its own when no AI key is set, as the AI's shortlist,
// and as the fallback when the AI provider is down.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const STOP = new Set("the a an and or to of for in on at is are be can do does how what when where who why with my our guest guests".split(" "));

function score(question, sop) {
  const nq = " " + norm(question) + " ";
  const words = nq.trim().split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  let sc = 0;
  for (const k of String(sop.keywords || "").split(",").map(norm).filter(Boolean)) {
    if (nq.includes(" " + k + " ") || nq.includes(k)) sc += k.split(" ").length * 3;
  }
  const hay = " " + norm(sop.title + " " + sop.keywords) + " ";
  for (const w of words) if (hay.includes(" " + w) || hay.includes(w + " ")) sc += 1;
  return sc;
}

function rank(question, sops, limit = 8) {
  return sops
    .map((s) => ({ s, sc: score(question, s) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit);
}

function best(question, sops) {
  const top = rank(question, sops, 1)[0];
  return top && top.sc >= 2 ? top.s : null;
}

module.exports = { norm, rank, best };
