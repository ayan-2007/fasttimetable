"""
FastSchedule - Automated University Timetable

Resilient backend scraper engine.

Pipeline:
  1. Transform the public Google Sheets "view" URL into a direct XLSX export URL.
  2. Download the workbook, read every sheet, and detect the header row using
     fuzzy regex column matching so renamed or moved columns never break parsing.
  3. Normalize every time value into the canonical "HH:MM - HH:MM" format.
  4. Clean the rows and persist them as plain, readable JSON in db/timetable.json.

Fail-safe behavior:
  If any network call or parsing step fails, an alert is logged and the last
  known valid db/timetable.json is left untouched. A corrupt or partial file is
  never written.
"""

import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

import pandas
import requests
from openpyxl import load_workbook

SHEET_URL = "https://docs.google.com/spreadsheets/d/1fL2TWhPgbPc2d66vm_KywTpdsGBIaBLqlmz4JLPudCw/edit?usp=sharing"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, "db", "timetable.json")

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
}
DOWNLOAD_TIMEOUT = 60
MIN_XLSX_PAYLOAD_BYTES = 1024

DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

EMPTY_MARKERS = {
    "free",
    "lunch",
    "break",
    "empty",
    "blank",
    "available",
    "no class",
    "noclass",
    "cancelled",
    "canceled",
    "cancel",
    "holiday",
    "n/a",
    "na",
    "nil",
    "none",
    "off",
    "—",
    "-",
    "–",
}

COLUMN_PATTERNS = [
    ("department", re.compile(r"department|dept\.?|program|stream|school|discipline", re.IGNORECASE)),
    ("batch_section", re.compile(r"batch|section|\bgroup\b|division", re.IGNORECASE)),
    ("day", re.compile(r"\bday\b|weekday|\bdate\b|session", re.IGNORECASE)),
    ("time_start", re.compile(r"start(?:\s*time)?|begin(?:\s*time)?|\bfrom\b", re.IGNORECASE)),
    ("time_end", re.compile(r"end(?:\s*time)?|finish(?:\s*time)?|\bto\b", re.IGNORECASE)),
    ("time", re.compile(r"\btime\b|\bslot\b|period|timings?|hours?", re.IGNORECASE)),
    ("course", re.compile(r"course|subject|module|title|offering|paper", re.IGNORECASE)),
    ("instructor", re.compile(r"instructor|teacher|lecturer|faculty|professor|staff", re.IGNORECASE)),
    ("room", re.compile(r"room|venue|classroom|\bhall\b|building|location|block", re.IGNORECASE)),
    ("type", re.compile(r"\btype\b|mode|kind|format|category", re.IGNORECASE)),
]

SHEET_URL_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9_-]+)")
TIME_TOKEN_RE = re.compile(
    r"\d{1,2}[:.]\d{1,2}\s*(?:[apAP](?:\.?[mM]\.?)?)?"
    r"|\d{1,2}\s*(?:[apAP](?:\.?[mM]\.?)?)"
)
TIME_LABEL_RE = re.compile(
    r"\d{1,2}[:.]\d{1,2}\s*(?:[apAP](?:\.?[mM]\.?)?)?"
    r"(?:\s*(?:-|–|—|to)\s*\d{1,2}[:.]\d{1,2}\s*(?:[apAP](?:\.?[mM]\.?)?)?)?"
)
AM_RE = re.compile(r"[aA](?:\.?[mM]\.?)?")
PM_RE = re.compile(r"[pP](?:\.?[mM]\.?)?")

DAY_NAME_MAP = {
    "monday": "Mon",
    "tuesday": "Tue",
    "wednesday": "Wed",
    "thursday": "Thu",
    "friday": "Fri",
    "saturday": "Sat",
    "sunday": "Sun",
    "mon": "Mon",
    "tue": "Tue",
    "tues": "Tue",
    "wed": "Wed",
    "thu": "Thu",
    "thur": "Thu",
    "thurs": "Thu",
    "fri": "Fri",
    "sat": "Sat",
    "sun": "Sun",
}

PROGRAM_MAP = {
    "CE": "Computer Engineering",
    "EE": "Electrical Engineering",
    "CS": "Computer Science",
    "SE": "Software Engineering",
    "AI": "Artificial Intelligence",
    "DS": "Data Science",
    "ME": "Mechanical Engineering",
    "BM": "Business Administration",
    "BA": "Business Administration",
    "PE": "Petroleum Engineering",
    "PG": "Physics",
    "PH": "Physics",
}

MATRIX_SECTION_RE = re.compile(
    r"(?:(\b(?:CE|EE|CS|SE|AI|DS|ME|BM|BA|PE|PG|PH)\b)[ ._\-]*)?([A-E])$"
)


def log_alert(message):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[ALERT] {stamp} {message}", file=sys.stderr)


def get_export_url(url):
    match = SHEET_URL_RE.search(url)
    if not match:
        raise ValueError(f"Could not extract spreadsheet id from URL: {url}")
    spreadsheet_id = match.group(1)
    return f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/export?format=xlsx"


def clean_cell(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            if value == int(value):
                return str(int(value))
            return f"{value:.2f}"
        return str(value)
    text = str(value)
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[\r\n\t]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if text else None


def clean_header(value):
    return (clean_cell(value) or "").lower()


def is_blank(value):
    if value is None:
        return True
    if isinstance(value, (int, float)):
        return False
    text = str(value).strip().lower()
    return not text or text in EMPTY_MARKERS


def _token_to_minutes(token):
    token = token.strip()
    if not token:
        return None
    is_pm = bool(PM_RE.search(token))
    is_am = bool(AM_RE.search(token)) and not is_pm
    match = re.match(r"(\d{1,2})(?:[:.](\d{1,2}))?", token)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2)) if match.group(2) else 0
    if minute >= 60:
        return None
    if is_pm and hour < 12:
        hour += 12
    if is_am and hour == 12:
        hour = 0
    return hour * 60 + minute


def normalize_time(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        text = clean_cell(value)
    else:
        text = str(value)
    if not text:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    tokens = TIME_TOKEN_RE.findall(text)
    minutes = [_token_to_minutes(tok) for tok in tokens]
    minutes = [m for m in minutes if m is not None]
    if len(minutes) == 0:
        return None
    if len(minutes) == 1:
        total = minutes[0]
        return f"{total // 60:02d}:{total % 60:02d}"
    start, end = minutes[0], minutes[-1]
    return f"{start // 60:02d}:{start % 60:02d} - {end // 60:02d}:{end % 60:02d}"


def has_time_label(value):
    text = clean_cell(value)
    if not text:
        return False
    return bool(TIME_LABEL_RE.fullmatch(text))


def first_cell_in_range(row, start, end):
    for col_index in range(start, min(end, len(row) - 1) + 1):
        value = clean_cell(row[col_index])
        if value:
            return value
    return None


def find_matrix_header_row(rows, max_rows=30):
    best_index = -1
    best_score = 0
    for index, row in enumerate(rows[:max_rows]):
        headers = [clean_header(c) for c in row]
        score = 0
        if any(header == "room" for header in headers if header):
            score += 2
        for raw in row:
            if has_time_label(clean_cell(raw)):
                score += 1
        if score > best_score:
            best_score = score
            best_index = index
    return best_index


def build_matrix_slots(rows, header_index):
    header_row = rows[header_index]
    merged_spans = {}
    for col_index, raw in enumerate(header_row):
        if has_time_label(clean_cell(raw)):
            merged_spans[col_index] = (col_index, col_index)
    slots = []
    for col_index, raw in enumerate(header_row):
        if col_index not in merged_spans:
            continue
        value = clean_cell(raw)
        label = normalize_time(value) or value
        slots.append({"start": col_index, "end": merged_spans[col_index][1], "label": label})
    slots.sort(key=lambda slot: slot["start"])
    return slots


def expand_slot_spans(worksheet, rows, header_index, slots):
    header_row = rows[header_index]
    for rng in worksheet.merged_cells.ranges:
        if rng.min_row - 1 != header_index:
            continue
        start = rng.min_col - 1
        end = rng.max_col - 1
        for slot in slots:
            if start == slot["start"]:
                slot["end"] = end
                break
    return slots


def find_room_column(rows, header_index):
    for col_index, raw in enumerate(rows[header_index]):
        if clean_header(raw) == "room":
            return col_index
    return 2


def find_day_blocks(rows):
    blocks = []
    current_start = None
    current_day = None
    for index, row in enumerate(rows):
        first = clean_cell(row[0]) if row else None
        day = DAY_NAME_MAP.get(first.lower()) if first else None
        if day:
            if current_start is not None:
                blocks.append((current_start, index - 1, current_day))
            current_start = index
            current_day = day
    if current_start is not None:
        blocks.append((current_start, len(rows) - 1, current_day))
    return blocks


def build_course_rows(worksheet, rows, block_start, block_end, room_col):
    course_rows = set()
    for rng in worksheet.merged_cells.ranges:
        if rng.min_col - 1 != room_col:
            continue
        anchor = rng.min_row - 1
        if block_start <= anchor <= block_end:
            course_rows.add(anchor)
    for index in range(block_start, block_end + 1):
        row = rows[index]
        if room_col < len(row) and clean_cell(row[room_col]) and not has_time_label(clean_cell(row[room_col])):
            course_rows.add(index)
    return course_rows


def extract_matrix_section(course):
    text = clean_cell(course) or ""
    match = MATRIX_SECTION_RE.search(text)
    if not match:
        return None, None
    program = match.group(1)
    section = match.group(2)
    if program:
        return f"{program}-{section}", program
    return section, None


def build_matrix_entry(day, time_label, course, instructor, room):
    section, program = extract_matrix_section(course)
    department = PROGRAM_MAP.get(program, "School of Engineering")
    entry_type = classify_type(None, course)
    return {
        "department": department,
        "batch_section": section or "All",
        "day": day,
        "time": time_label,
        "course": course,
        "instructor": instructor or "Not assigned",
        "room": room or "Not specified",
        "type": entry_type,
    }


def parse_matrix(worksheet, rows, header_index):
    slots = build_matrix_slots(rows, header_index)
    if len(slots) < 2:
        return []
    slots = expand_slot_spans(worksheet, rows, header_index, slots)
    room_col = find_room_column(rows, header_index)
    entries = []
    for block_start, block_end, day in find_day_blocks(rows):
        slot_labels = [slot["label"] for slot in slots]
        course_rows = build_course_rows(worksheet, rows, block_start, block_end, room_col)
        for row_index in range(block_start, block_end + 1):
            row = rows[row_index]
            is_subheader = False
            for index, slot in enumerate(slots):
                value = first_cell_in_range(row, slot["start"], slot["end"])
                if has_time_label(value):
                    slot_labels[index] = normalize_time(value) or value
                    is_subheader = True
            if is_subheader:
                continue
            if row_index not in course_rows:
                continue
            room_value = clean_cell(row[room_col]) if room_col < len(row) else None
            for index, slot in enumerate(slots):
                course = first_cell_in_range(row, slot["start"], slot["end"])
                if not course or has_time_label(course):
                    continue
                if re.search(r"reserv|resrv", course.lower()):
                    continue
                instructor = None
                if row_index + 1 < len(rows):
                    instructor = first_cell_in_range(rows[row_index + 1], slot["start"], slot["end"])
                entries.append(build_matrix_entry(day, slot_labels[index], course, instructor, room_value))
    return entries


def resolve_merged_cells(worksheet, rows):
    if not worksheet.merged_cells.ranges:
        return rows
    for rng in worksheet.merged_cells.ranges:
        top = rng.min_row - 1
        left = rng.min_col - 1
        if top >= len(rows) or left >= len(rows[top]):
            continue
        anchor = rows[top][left]
        if anchor is None:
            continue
        for r in range(top, min(rng.max_row, len(rows))):
            for c in range(left, min(rng.max_col, len(rows[r]))):
                if rows[r][c] is None:
                    rows[r][c] = anchor
    return rows


def find_header_row(rows, max_rows=25):
    best_index = -1
    best_score = -1
    for index, row in enumerate(rows[:max_rows]):
        headers = [clean_header(c) for c in row]
        score = 0
        for _field, pattern in COLUMN_PATTERNS:
            if any(pattern.search(header) for header in headers if header):
                score += 1
        if score > best_score:
            best_score = score
            best_index = index
    return best_index


def map_columns(header_row):
    mapping = {}
    for col_index, raw in enumerate(header_row):
        header = clean_header(raw)
        if not header:
            continue
        for field, pattern in COLUMN_PATTERNS:
            if pattern.search(header):
                mapping.setdefault(field, []).append(col_index)
                break
    return mapping


def _first_cell(field, mapping, row):
    for col_index in mapping.get(field, []):
        if col_index >= len(row):
            continue
        value = clean_cell(row[col_index])
        if value and not is_blank(value):
            return value
    return None


def resolve_time(field_single, mapping, row):
    single = _first_cell(field_single, mapping, row)
    if single:
        return normalize_time(single)
    start = _first_cell("time_start", mapping, row)
    end = _first_cell("time_end", mapping, row)
    if start or end:
        combined = " - ".join(part for part in (start, end) if part)
        if combined:
            return normalize_time(combined)
    return None


def classify_type(type_raw, course_raw):
    raw = clean_cell(type_raw)
    if raw:
        text = raw.lower()
    else:
        text = (clean_cell(course_raw) or "").lower()
    if re.search(r"\blab\b|laboratory|laborator", text):
        return "Lab"
    return "Lecture"


def is_cancelled_entry(values):
    joined = " | ".join(str(v) for v in values if v is not None).lower()
    return any(marker in joined for marker in ("cancelled", "canceled", "cancell"))


def parse_flat(rows, header_index):
    mapping = map_columns(rows[header_index])
    required_fields = ("day", "course", "time")
    if not all(mapping.get(field) for field in required_fields):
        return []

    entries = []
    for row in rows[header_index + 1 :]:
        day = _first_cell("day", mapping, row)
        course = _first_cell("course", mapping, row)
        if not day or not course:
            continue
        if is_blank(course):
            continue
        if is_cancelled_entry(row):
            continue
        time_value = resolve_time("time", mapping, row)
        if not time_value:
            continue
        department = _first_cell("department", mapping, row)
        batch_section = _first_cell("batch_section", mapping, row)
        instructor = _first_cell("instructor", mapping, row)
        room = _first_cell("room", mapping, row)
        type_raw = _first_cell("type", mapping, row)
        entry_type = classify_type(type_raw, course)

        entry = {
            "department": department or "General",
            "batch_section": batch_section or "All",
            "day": str(day).strip(),
            "time": time_value,
            "course": course,
            "instructor": instructor or "Not assigned",
            "room": room or "Not specified",
            "type": entry_type,
        }
        entries.append(entry)
    return entries


def parse_sheet(worksheet, sheet_name, rows):
    matrix_header = find_matrix_header_row(rows)
    if matrix_header >= 0:
        entries = parse_matrix(worksheet, rows, matrix_header)
        if entries:
            return entries
    flat_header = find_header_row(rows)
    if flat_header < 0:
        return []
    merged_rows = resolve_merged_cells(worksheet, rows)
    return parse_flat(merged_rows, flat_header)


def read_workbook_rows(worksheet, workbook_path, sheet_name):
    frame = pandas.read_excel(
        workbook_path,
        sheet_name=sheet_name,
        header=None,
        dtype=str,
        engine="openpyxl",
    )
    rows = frame.astype(object).where(pandas.notna(frame), None).values.tolist()
    return [[clean_cell(cell) for cell in row] for row in rows]


def scrape_workbook(payload):
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(payload)
        tmp_path = tmp.name
    try:
        workbook = load_workbook(tmp_path, read_only=False, data_only=True)
        entries = []
        sheet_stats = {}
        for sheet_name in workbook.sheetnames:
            worksheet = workbook[sheet_name]
            rows = read_workbook_rows(worksheet, tmp_path, sheet_name)
            if not rows:
                continue
            sheet_entries = parse_sheet(worksheet, sheet_name, rows)
            sheet_stats[sheet_name] = len(sheet_entries)
            entries.extend(sheet_entries)
        workbook.close()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    entries.sort(key=lambda item: (
        DAY_ORDER.index(item["day"]) if item["day"] in DAY_ORDER else len(DAY_ORDER),
        item["time"],
        item["batch_section"].lower(),
    ))
    print(f"[INFO] Sheets parsed: {sheet_stats}")
    return entries


def write_db(entries):
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": SHEET_URL,
        "count": len(entries),
        "entries": entries,
    }
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    temp_path = DB_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
    os.replace(temp_path, DB_PATH)
    print(f"[INFO] Wrote {len(entries)} entries to {DB_PATH}")


def scrape():
    export_url = get_export_url(SHEET_URL)
    print(f"[INFO] Export URL: {export_url}")
    response = requests.get(export_url, timeout=DOWNLOAD_TIMEOUT, headers=REQUEST_HEADERS)
    response.raise_for_status()
    if len(response.content) < MIN_XLSX_PAYLOAD_BYTES:
        raise RuntimeError(
            f"Export payload unexpectedly small ({len(response.content)} bytes); "
            "the sheet may require sign-in or returned an error page."
        )
    if response.content[:2] not in (b"PK", b"<?") and b"<html" in response.content[:512].lower():
        raise RuntimeError("Export returned an HTML page instead of a workbook.")
    return scrape_workbook(response.content)


def main():
    try:
        entries = scrape()
    except Exception as exc:
        log_alert(f"Scrape failed: {exc}")
        log_alert("Preserving the last known valid db/timetable.json untouched.")
        return 1
    try:
        write_db(entries)
    except Exception as exc:
        log_alert(f"Could not write timetable database: {exc}")
        log_alert("Preserving the last known valid db/timetable.json untouched.")
        return 1
    print("[INFO] Timetable update completed successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
