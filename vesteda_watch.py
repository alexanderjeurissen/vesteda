#!/usr/bin/env python3
"""Watch the Vesteda saved search (hurenbij.vesteda.com/zoekopdracht/) and push
an alert when a listing is new, changes status, or disappears.

Filtering is done by the search profile saved on your Vesteda account; edit
your preferences on the site and this script follows them.

Env: VESTEDA_EMAIL, VESTEDA_PASSWORD (required)
     NTFY_TOPIC   ntfy.sh topic to push to (optional, otherwise stdout only)
     INTERVAL     seconds between checks; 0/unset = check once and exit
     STATE_DIR    where state.json and cookies.txt live (default: script dir)
"""
import html
import http.cookiejar
import json
import os
import re
import sys
import time
import traceback
import urllib.parse
import urllib.request

BASE = "https://hurenbij.vesteda.com"
SEARCH_URL = BASE + "/zoekopdracht/"
STATE_DIR = os.environ.get("STATE_DIR") or os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(STATE_DIR, "state.json")
COOKIE_FILE = os.path.join(STATE_DIR, "cookies.txt")

jar = http.cookiejar.MozillaCookieJar(COOKIE_FILE)
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) vesteda-watch")]


def fetch(url, data=None):
    body = urllib.parse.urlencode(data).encode() if data else None
    with opener.open(url, body, timeout=30) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def login():
    # The first request only gets PHPSESSID; the Laravel session + CSRF token
    # are only stable from the second request on, so warm up first.
    fetch(BASE + "/login")
    _, page = fetch(BASE + "/login")
    token = re.search(r'name="_token" value="([^"]+)"', page).group(1)
    fetch(BASE + "/login", {
        "postrequest": "login",
        "_token": token,
        "txtEmail": os.environ["VESTEDA_EMAIL"],
        "txtWachtwoord": os.environ["VESTEDA_PASSWORD"],
    })


def search_page():
    if os.path.exists(COOKIE_FILE):
        jar.load(ignore_discard=True)
    url, page = fetch(SEARCH_URL)
    if "/login" in url:  # session expired -> log in and retry once
        login()
        url, page = fetch(SEARCH_URL)
        if "/login" in url:
            raise RuntimeError("Login failed: still redirected to /login")
    jar.save(ignore_discard=True)
    return page


def parse_listings(page):
    listings = {}
    for card in page.split("card card-result-list")[1:]:
        link = re.search(r'href="/object/(\w+)/">([^<]+)</a>', card)
        if not link:
            continue
        def field(pattern):
            m = re.search(pattern, card, re.S)
            return html.unescape(m.group(1).strip()) if m else None
        listings[link.group(1)] = {
            "address": html.unescape(link.group(2).strip()),
            "city": field(r'class="card-text">([^<]+)<'),
            "status": field(r'card-image-label"><span>\s*(.*?)\s*</span>'),
            "price": field(r"Huurprijs: ([^<]+)<"),
            "bedrooms": field(r"Aantal slaapkamers: ([^<]+)<"),
            "area": field(r"Woonoppervlakte: (\d+)"),
            "url": f"{BASE}/object/{link.group(1)}/",
        }
    total = re.search(r"(\d+) resultaten", page)
    if total and int(total.group(1)) > len(listings):
        # shortcut: no pagination support; add it if this ever fires
        print(f"WARNING: site reports {total.group(1)} results, parsed {len(listings)}", file=sys.stderr)
    return listings


def diff(old, new):
    """Return a list of (title, listing, is_urgent) alerts."""
    alerts = []
    for oid, cur in new.items():
        prev = old.get(oid)
        if prev is None:
            alerts.append((f"Nieuw: {cur['status']}", cur, cur["status"] == "Te huur"))
        elif prev["status"] != cur["status"]:
            alerts.append((f"{prev['status']} → {cur['status']}", cur, cur["status"] == "Te huur"))
    for oid in old.keys() - new.keys():
        alerts.append(("Verdwenen uit zoekresultaten", old[oid], False))
    return alerts


def notify(title, listing, urgent):
    l = listing
    msg = f"{l['address']}, {l['city']}\n€ {l['price']} · {l['bedrooms']} slpk · {l['area']} m²\n{l['url']}"
    print(f"[{time.strftime('%H:%M:%S')}] {title}\n{msg}\n", flush=True)
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    payload = {"topic": topic, "title": f"Vesteda – {title}", "message": msg,
               "click": l["url"], "priority": 5 if urgent else 3, "tags": ["house"]}
    req = urllib.request.Request("https://ntfy.sh/", json.dumps(payload).encode(),
                                 {"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=15).close()


def check():
    new = parse_listings(search_page())
    if not new:
        # Don't overwrite state on an empty/unexpected page: that would fire
        # "verdwenen" for everything now and "nieuw" for everything later.
        raise RuntimeError("No listings parsed; page layout changed or not logged in?")
    first_run = not os.path.exists(STATE_FILE)
    old = {} if first_run else json.load(open(STATE_FILE))
    if first_run:
        print(f"First run: recorded {len(new)} listings, alerts start from the next check.")
    else:
        for alert in diff(old, new):
            notify(*alert)
    with open(STATE_FILE + ".tmp", "w") as f:
        json.dump(new, f, indent=1, ensure_ascii=False)
    os.replace(STATE_FILE + ".tmp", STATE_FILE)
    return new


def main():
    interval = int(os.environ.get("INTERVAL") or 0)
    if not interval:
        check()
        return
    while True:
        try:
            listings = check()
            print(f"[{time.strftime('%H:%M:%S')}] ok, {len(listings)} listings", flush=True)
        except Exception:
            traceback.print_exc()
        time.sleep(interval)


if __name__ == "__main__":
    main()
