import unittest

from vesteda_watch import diff, parse_listings

CARD = """<div class="card card-result-list mb-4">
<h5 class="card-title mb-1"><a class="stretched-link" href="/object/{id}/">Brusselplein 107</a></h5>
<div class="card-text">Utrecht</div>
<div class="card-image-label"><span>
      {status}
   </span></div>
<span class="sr-only">Huurprijs: 1.565,-</span>
<span class="sr-only">Aantal slaapkamers: 2</span>
<span class="sr-only">Woonoppervlakte: 72 m<sup>2</sup></span>
</div>"""


class WatchTest(unittest.TestCase):
    def test_parse(self):
        page = "2 resultaten" + CARD.format(id="aa11", status="Te huur") + CARD.format(id="bb22", status="Gereserveerd")
        got = parse_listings(page)
        self.assertEqual(got["aa11"], {
            "address": "Brusselplein 107", "city": "Utrecht", "status": "Te huur",
            "price": "1.565,-", "bedrooms": "2", "area": "72",
            "url": "https://hurenbij.vesteda.com/object/aa11/",
        })
        self.assertEqual(got["bb22"]["status"], "Gereserveerd")

    def test_diff(self):
        old = {"a": {"status": "Gereserveerd"}, "b": {"status": "Te huur"}, "gone": {"status": "Te huur"}}
        new = {"a": {"status": "Te huur"}, "b": {"status": "Te huur"}, "c": {"status": "Te huur"}}
        got = {(t, u) for t, _, u in diff(old, new)}
        self.assertEqual(got, {
            ("Gereserveerd → Te huur", True),
            ("Nieuw: Te huur", True),
            ("Verdwenen uit zoekresultaten", False),
        })


if __name__ == "__main__":
    unittest.main()
