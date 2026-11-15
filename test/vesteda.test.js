import { test } from "node:test";
import assert from "node:assert/strict";
import { diff, parseListings } from "../src/vesteda.js";

const card = (id, status) => `<div class="card card-result-list mb-4">
<h5 class="card-title mb-1"><a class="stretched-link" href="/object/${id}/">Brusselplein 107 &amp; co</a></h5>
<div class="card-text">Utrecht</div>
<div class="card-image-label"><span>
      ${status}
   </span></div>
<span class="sr-only">Huurprijs: 1.565,-</span>
<span class="sr-only">Aantal slaapkamers: 2</span>
<span class="sr-only">Woonoppervlakte: 72 m<sup>2</sup></span>
</div>`;

test("parseListings", () => {
  const got = parseListings("2 resultaten" + card("aa11", "Te huur") + card("bb22", "Verhuurd onder voorbehoud"));
  assert.deepEqual(got.aa11, {
    address: "Brusselplein 107 & co", city: "Utrecht", status: "Te huur",
    price: "1.565,-", bedrooms: "2", area: "72",
  });
  assert.equal(got.bb22.status, "Verhuurd onder voorbehoud");
});

test("diff", () => {
  const known = {
    a: { status: "Gereserveerd", active: 1 },
    b: { status: "Te huur", active: 1 },
    gone: { status: "Te huur", active: 1 },
    back: { status: "Gereserveerd", active: 0 },
  };
  const current = { a: { status: "Te huur" }, b: { status: "Te huur" }, c: { status: "Te huur" }, back: { status: "Te huur" } };
  assert.deepEqual(diff(known, current), [
    { id: "a", kind: "status", from: "Gereserveerd", to: "Te huur" },
    { id: "c", kind: "nieuw", from: null, to: "Te huur" },
    { id: "back", kind: "terug", from: null, to: "Te huur" },
    { id: "gone", kind: "verdwenen", from: "Te huur", to: null },
  ]);
});
