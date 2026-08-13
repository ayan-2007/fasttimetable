# FastSchedule - Automated University Timetable

**FastSchedule** is a self-updating, zero-maintenance university timetable portal. A resilient Python scraper pulls the live timetable from a public Google Sheet on a nightly schedule (via GitHub Actions), stores it as clean, readable JSON, and serves it through a responsive web frontend hosted on GitHub Pages. No servers, no APIs, no secrets, no manual upkeep.

> Live demo: `https://ayan-2007.github.io/fse-schedule/`

---

## Features

- **Automated scraping** - the backend transforms the Google Sheets *view link* into a direct XLSX export URL and downloads the workbook nightly at `04:00 UTC` (`cron: 0 4 * * *`), with a manual "Run workflow" trigger available anytime.
- **Fuzzy column detection** - columns are located by regex pattern, so staff can rename or reorder columns (`Time|Slot`, `Instructor|Teacher|Faculty`, `Room|Venue|Lab`, `Course|Subject|Title`, `Section|Batch|Class`) without breaking the parser.
- **Self-healing time normalizer** - every time variant (`8:30-9:50`, `08:30AM to 09:50AM`, `8.30 - 9.50`, separate Start/End columns, etc.) is normalized to canonical `HH:MM - HH:MM`.
- **Fail-safe database** - if the sheet or network is unavailable, an alert is logged and the last known good `db/timetable.json` is preserved untouched.
- **Student/faculty portal UI**:
  - 📅 **Schedule View** - filterable grid by section, day, and live text search.
  - 🔍 **Free Slot Finder** - pick a day + time and instantly see every free room.
  - 👨🏫 **Teacher Directory** - search instructors and view all of their classes.
  - Light/dark theme, skeleton loading, empty states, and print-friendly output.

---

## Architecture

```
┌──────────────────────┐      ┌───────────────────────────┐
│ Google Sheet (public)│─────▶│  scraper.py  (GitHub      │
│  view URL            │xlsx  │  Actions, daily 04:00 UTC)│
└──────────────────────┘      └─────────────┬─────────────┘
                                            │ writes
                                            ▼
                                   ┌──────────────────┐
                                   │ db/timetable.json │  ← committed back to main
                                   └────────┬─────────┘
                                            │ served statically
                                            ▼
                              ┌───────────────────────────┐
                              │ index.html + css/ + js/   │
                              │       GitHub Pages        │
                              └───────────────────────────┘
```

### Repository layout

```text
fastschedule/
├── index.html                     UI entry point
├── css/styles.css                 responsive theming (light/dark, mobile cards, print)
├── js/app.js                      fetching, filtering, free-slot + teacher logic
├── db/timetable.json              seed + live database
├── scraper.py                     resilient backend scraper engine
├── .github/workflows/
│   └── update_timetable.yml       scheduled + manual scrape workflow
├── README.md                      this file
└── TO_DO_MANUALLY.md              one-time human setup checklist
```

---

## Setup (one-time, ~5 minutes)

All manual steps are captured with checkboxes in **[TO_DO_MANUALLY.md](TO_DO_MANUALLY.md)**. The short version:

1. Create a public GitHub repo and push this code to `main`.
2. Go to **Settings → Actions → General → Workflow permissions** and enable **Read and write permissions**.
3. Go to **Settings → Pages** and deploy `main` from the `/` (root) folder.
4. Open the **Actions** tab → **Update Timetable** → **Run workflow** to seed live data.

From then on the timetable refreshes itself every day at 04:00 UTC. There is nothing else to maintain.

---

## Local testing

Requirements: Python 3.8+, `git`.

```bash
# 1. Install Python dependencies
pip install pandas openpyxl requests

# 2. Run the scraper manually (downloads the live sheet and rewrites db/timetable.json)
python scraper.py

# 3. Serve the site locally
python -m http.server 8000
# open http://localhost:8000
```

> Note: the Google Sheet must be **shared as "Anyone with the link can view"** for the unauthenticated export to succeed. If you open the sheet in a private browser window and can read it without signing in, the scraper will work too.

### Verifying the scraper

- Success prints `[INFO] Wrote N entries to ...db/timetable.json` and the entry counts per sheet.
- Failure prints `[ALERT] ...` and leaves the existing `db/timetable.json` untouched.

---

## How the scraper stays resilient

| Threat | Defense |
| --- | --- |
| Staff rename columns | Regex fuzzy header matching in `scraper.py` |
| Time written differently each semester | `normalize_time()` handles 20+ formats and Start/End split columns |
| Merged cells | `resolve_merged_cells()` back-fills anchor values |
| Empty / lunch / cancelled slots | Filtered out before JSON is written |
| Sheet temporarily unavailable | Alert logged, last good file preserved (atomic `os.replace`) |
| Headers moved / new header row | `find_header_row()` scores rows by pattern coverage |
| Non-timetable sheets | Unmatched sheets are skipped safely |

---

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Commit your changes.
4. Open a pull request describing the change.

---

## License

MIT License

Copyright (c) 2026 FastSchedule contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.