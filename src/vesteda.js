// Pure parsing/diff logic, no Workers APIs, so it runs under `node --test`.

export const BASE = "https://hurenbij.vesteda.com";

const decode = (s) =>
  s.replace(/&(#\d+|amp|quot|#039|apos|lt|gt|nbsp);/g, (_, e) =>
    e[0] === "#" ? String.fromCharCode(+e.slice(1)) :
    { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[e]);

export function parseListings(page) {
  const listings = {};
  for (const card of page.split("card card-result-list").slice(1)) {
    const link = card.match(/href="\/object\/(\w+)\/">([^<]+)<\/a>/);
    if (!link) continue;
    const field = (re) => { const m = card.match(re); return m ? decode(m[1].trim()) : null; };
    listings[link[1]] = {
      address: decode(link[2].trim()),
      city: field(/class="card-text">([^<]+)</),
      status: field(/card-image-label"><span>\s*([\s\S]*?)\s*<\/span>/),
      price: field(/Huurprijs: ([^<]+)</),
      bedrooms: field(/Aantal slaapkamers: ([^<]+)</),
      area: field(/Woonoppervlakte: (\d+)/),
    };
  }
  const total = page.match(/(\d+) resultaten/);
  // shortcut: no pagination support; the warning shows up in Workers Logs if it's ever needed
  if (total && +total[1] > Object.keys(listings).length)
    console.warn(JSON.stringify({ msg: "more results than parsed", total: +total[1], parsed: Object.keys(listings).length }));
  return listings;
}

// known: { id: { status, active } } from storage; current: parseListings() output.
export function diff(known, current) {
  const events = [];
  for (const [id, l] of Object.entries(current)) {
    const k = known[id];
    if (!k) events.push({ id, kind: "nieuw", from: null, to: l.status });
    else if (!k.active) events.push({ id, kind: "terug", from: null, to: l.status });
    else if (k.status !== l.status) events.push({ id, kind: "status", from: k.status, to: l.status });
  }
  for (const [id, k] of Object.entries(known))
    if (k.active && !current[id]) events.push({ id, kind: "verdwenen", from: k.status, to: null });
  return events;
}
