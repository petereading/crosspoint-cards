# CrossPoint Cards

A fork of [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader) that turns the
e-reader into an always-on e-ink card display, without giving up the reader.

Everything CrossPoint does — EPUB rendering, dictionaries, OPDS, KOReader sync — still works. This
fork adds one thing: **Cards**.

![CrossPoint Reader running on Xteink device](./docs/images/cover.jpg)

---

## What Cards does

A card is a URL to a 1-bit BMP, and nothing else. The firmware fetches it, checks it, draws it, and
sleeps until the next refresh. It has no idea whether it is showing a clock, the weather or a photo —
everything that distinguishes one card from another lives in the URL.

That is the whole design, and it is deliberate. Adding a new kind of card needs no firmware change.

- **Six slots.** Each holds a complete HTTPS URL and its own refresh interval
  (1, 2, 5, 10, 15, 30, 60, 120 or 240 minutes).
- **Display mode.** Open a card from **Main Menu → Cards** and it stays on screen, refreshing in
  place with the radio off between fetches. Back leaves.
- **Sleep screen.** Set **Settings → Display → Sleep Screen** to *Card* and pick one under
  *Sleep Card*. The device then wakes on a timer, refreshes that card, and sleeps again — the panel
  keeps showing the card the whole time.

The image is validated before it replaces the one on screen, and the previous card is kept until a
new one has been written successfully, so a failed refresh never leaves a blank panel.

## Where the pictures come from

`examples/cloudflare-dashboard-worker.js` is a single-file Cloudflare Worker that renders the cards.
Deploy it to your own account, then paste its URLs into the six slots.

| Route | Shows |
|---|---|
| `/clock.bmp` | Time, date and place |
| `/weather.bmp` | Current conditions and forecast |
| `/moon.bmp` | Moon phase and upcoming phases |
| `/today.bmp` | On this day, from Wikipedia |
| `/quote.bmp` | Quote of the day, from Wikiquote |
| `/bitcoin.bmp` | BTC/USD with a seven-day chart |
| `/solar.bmp` | Heliocentric solar system |
| `/astro.bmp` | Astrological chart |

Open the Worker's root URL for the full parameter list, and `/locations.txt` for the 81 location
codes.

```
https://your-worker.workers.dev/clock.bmp?device=x3&location=HKG&lead=90&round=5
https://your-worker.workers.dev/weather.bmp?device=x3&location=London,GB
https://your-worker.workers.dev/astro.bmp?device=x3&location=LON&houses=whole
```

Two clock parameters are worth knowing about. The device shows what the Worker rendered some seconds
earlier, so `lead=90` renders that far ahead and the card is right *when it appears*; `round=5` snaps
the displayed time to a coarser mark. Together they make a clock that reads correctly instead of
always trailing the fetch.

`device` and `orientation` set the bitmap size (`x3`/`x4`, `portrait`/`landscape`). Everything is
computed inside the Worker — the astro chart and moon phases included — so no third-party API key is
needed and no upstream service can take a card down.

## Install

Build from the **Actions** tab: *Build one board* → `gh_release` → download `firmware.bin` and flash
it with the [CrossPoint web installer](https://crosspointreader.com). Tagged releases build every
board through *Compile Release*.

Then open the device's web interface (**Settings → System → WiFi**, then browse to its address) and
paste your card URLs under **Cards**. Intervals live under **Settings → System** on the device or in
the same web page.

## Status

Developed and tested on an **Xteink X3**. It builds for every board CrossPoint supports, but the
timed sleep that drives the sleep-screen card is implemented for the ESP32-C3 boards (X3/X4); on
other boards a card sleeps on its timer without the power button armed as a second wake source.

Known limitation, inherited from upstream and present in stock CrossPoint 1.6 on the same hardware:
**downloading fonts** through Manage Fonts fails on the X3 with a memory error. The font list loads;
the download does not. Copy fonts to the SD card instead.

## Development

See the upstream [contributing docs](./docs/contributing/README.md) — the build, formatting and
testing workflow is unchanged.

```bash
git clone --recursive https://github.com/petereading/crosspoint-cards
cd crosspoint-cards
pio run -e default
```

## Credits

CrossPoint Reader is built by [its contributors](https://github.com/crosspoint-reader/crosspoint-reader/graphs/contributors)
and everything good about this firmware comes from them. This fork only adds the card layer on top.

The card idea began as [t0nyz0/crosspoint-reader-lockscreens](https://github.com/t0nyz0/crosspoint-reader-lockscreens);
the implementation here was rewritten around URL slots and no longer shares code with it.

MIT licensed — see [LICENSE](./LICENSE). Copyright remains with the original authors.

CrossPoint Reader is **not affiliated with Xteink or any device manufacturer**.
