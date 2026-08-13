"use strict";

(function () {
  const DB_URL = "db/timetable.json?v=" + Date.now();
  const THEME_KEY = "fastschedule-theme";

  const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const state = {
    data: [],
    degree: "",
    semester: "",
    section: "",
    day: "",
    loading: true,
  };

  const elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  function timeToMinutes(token) {
    const parts = String(token).split(":").map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
      return null;
    }
    return parts[0] * 60 + parts[1];
  }

  function parseRange(timeValue) {
    const match = String(timeValue || "").match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!match) {
      return null;
    }
    const start = timeToMinutes(match[1]);
    const end = timeToMinutes(match[2]);
    if (start === null || end === null) {
      return null;
    }
    return { start, end };
  }

  function sortByDay(value) {
    const index = DAY_ORDER.indexOf(value);
    return index === -1 ? DAY_ORDER.length : index;
  }

  function uniqueValues(entries, field, sortFn) {
    const values = Array.from(new Set(entries.map((item) => String(item[field] || "").trim()).filter(Boolean)));
    if (sortFn) {
      values.sort(sortFn);
    }
    return values;
  }

  function bindElements() {
    elements.updatedBadge = byId("updated-badge");
    elements.themeToggle = byId("theme-toggle");
    elements.resetFilters = byId("reset-filters");
    elements.degree = byId("filter-degree");
    elements.semester = byId("filter-semester");
    elements.section = byId("filter-section");
    elements.day = byId("filter-day");
    elements.status = byId("status");
    elements.results = byId("results");
    elements.footerYear = byId("footer-year");
  }

  function todayKey() {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];
  }

  function isEntryNow(item) {
    const range = parseRange(item.time);
    if (!range) {
      return false;
    }
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return todayKey() === String(item.day || "").trim() && nowMinutes >= range.start && nowMinutes <= range.end;
  }

  function semesterLabel(value) {
    const text = String(value == null ? "" : value).trim();
    return text ? "Semester " + text : text;
  }

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function emptyState(message, icon) {
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state";
    const iconEl = document.createElement("div");
    iconEl.className = "empty-icon";
    iconEl.textContent = icon || "🗓️";
    const text = document.createElement("p");
    text.textContent = message;
    wrapper.appendChild(iconEl);
    wrapper.appendChild(text);
    return wrapper;
  }

  function typeBadge(type) {
    const span = document.createElement("span");
    const normalized = normalizeText(type);
    span.className = "type-badge " + (normalized === "lecture" || normalized === "lab" ? normalized : "other");
    span.textContent = type || "Other";
    return span;
  }

  function fetchData() {
    state.loading = true;
    render();

    fetch(DB_URL, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then(function (payload) {
        const source = payload && Array.isArray(payload.entries) ? payload.entries : payload;
        state.data = Array.isArray(source) ? source : [];
        state.loading = false;
        populateOptions();
        updateUpdatedBadge(payload);
        render();
      })
      .catch(function (error) {
        state.loading = false;
        setStatus("Could not load timetable data: " + error.message);
        elements.results.innerHTML = "";
        elements.results.appendChild(emptyState("Unable to fetch the timetable. Check the network or refresh.", "⚠️"));
        updateUpdatedBadge(null);
      });
  }

  function updateUpdatedBadge(payload) {
    const raw = payload && payload.generated_at;
    if (!raw) {
      elements.updatedBadge.textContent = "Last updated: unavailable";
      elements.updatedBadge.classList.remove("is-live");
      return;
    }
    const date = new Date(raw);
    const label = isNaN(date.getTime()) ? raw : date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    elements.updatedBadge.textContent = "Last updated: " + label;
    elements.updatedBadge.classList.add("is-live");
  }

  function fillSelect(select, values, placeholderLabel, format) {
    select.innerHTML = "";
    if (placeholderLabel) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = placeholderLabel;
      select.appendChild(option);
    }
    values.forEach(function (value) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = format ? format(value) : value;
      select.appendChild(option);
    });
  }

  function populateOptions() {
    const degrees = uniqueValues(state.data, "department", function (a, b) {
      return normalizeText(a).localeCompare(normalizeText(b));
    });
    const days = uniqueValues(state.data, "day", function (a, b) {
      return sortByDay(a) - sortByDay(b);
    });
    fillSelect(elements.degree, degrees, "All programs");
    fillSelect(elements.day, days, "All days");
    populateSemesters();
  }

  function populateSemesters() {
    const pool = state.degree
      ? state.data.filter(function (item) {
          return String(item.department) === state.degree;
        })
      : state.data;
    const semesters = uniqueValues(pool, "semester", function (a, b) {
      return Number(a) - Number(b);
    });
    fillSelect(elements.semester, semesters, "All semesters", semesterLabel);
    if (state.semester && semesters.indexOf(state.semester) === -1) {
      state.semester = "";
    }
    elements.semester.value = state.semester;
    populateSections();
  }

  function batchLabel(value) {
    const text = String(value == null ? "" : value).trim();
    let match = /^([A-Z]{2})-(\d+)([A-E])$/.exec(text);
    if (match) {
      return "Semester " + match[2] + " · Section " + match[3];
    }
    match = /^([A-Z]{2})-(\d+)\s*\(All\)$/.exec(text);
    if (match) {
      return "Semester " + match[2] + " · All sections";
    }
    match = /^([A-Z]{2})-([A-E])$/.exec(text);
    if (match) {
      return match[1] + " · Section " + match[2];
    }
    match = /^([A-E])$/.exec(text);
    if (match) {
      return "Section " + match[1];
    }
    return text;
  }

  function populateSections() {
    const pool = state.data.filter(function (item) {
      if (state.degree && String(item.department) !== state.degree) {
        return false;
      }
      if (state.semester && String(item.semester) !== state.semester) {
        return false;
      }
      return true;
    });
    const sections = uniqueValues(pool, "batch_section", function (a, b) {
      return normalizeText(a).localeCompare(normalizeText(b));
    });
    fillSelect(elements.section, sections, "All sections", batchLabel);
    if (state.section && sections.indexOf(state.section) === -1) {
      state.section = "";
    }
    elements.section.value = state.section;
  }

  function getEntries() {
    return state.data.filter(function (item) {
      if (state.degree && String(item.department) !== state.degree) {
        return false;
      }
      if (state.semester && String(item.semester) !== state.semester) {
        return false;
      }
      if (state.section && String(item.batch_section) !== state.section) {
        return false;
      }
      if (state.day && String(item.day) !== state.day) {
        return false;
      }
      return true;
    });
  }

  function render() {
    if (state.loading) {
      renderSkeleton();
      return;
    }
    elements.results.innerHTML = "";
    const entries = getEntries();

    if (!state.degree && !state.semester && !state.section && !state.day) {
      setStatus("");
      elements.results.appendChild(emptyState("Select your program, semester, batch and day above to see your timetable.", "🗓️"));
      return;
    }

    if (entries.length === 0) {
      setStatus("No classes scheduled for these selections.");
      elements.results.appendChild(emptyState("Nothing scheduled here. Try another day or section.", "📭"));
      return;
    }

    const summary = [state.day, state.semester ? semesterLabel(state.semester) : "", state.section, state.degree]
      .filter(Boolean)
      .join(" · ");
    setStatus(summary + " — " + entries.length + (entries.length === 1 ? " class" : " classes"));

    const showDay = !state.day;
    const labels = showDay ? ["Day", "Time", "Course", "Room", "Type"] : ["Time", "Course", "Room", "Type"];

    const grid = document.createElement("div");
    grid.className = "grid" + (showDay ? " show-day" : "");

    const headerRow = document.createElement("div");
    headerRow.className = "grid-header";
    labels.forEach(function (label) {
      const cell = document.createElement("div");
      cell.textContent = label;
      headerRow.appendChild(cell);
    });
    grid.appendChild(headerRow);

    entries
      .slice()
      .sort(function (a, b) {
        const dayDiff = sortByDay(a.day) - sortByDay(b.day);
        if (dayDiff !== 0) {
          return dayDiff;
        }
        const ra = parseRange(a.time);
        const rb = parseRange(b.time);
        return (ra ? ra.start : 0) - (rb ? rb.start : 0);
      })
      .forEach(function (item) {
        grid.appendChild(renderRow(item, showDay));
      });

    elements.results.appendChild(grid);
  }

  function renderRow(item, showDay) {
    const row = document.createElement("div");
    const now = isEntryNow(item);
    row.className = "grid-row" + (now ? " is-now" : "");

    if (showDay) {
      const dayCell = document.createElement("div");
      dayCell.className = "grid-cell";
      dayCell.setAttribute("data-label", "Day");
      const dayText = document.createElement("strong");
      dayText.textContent = item.day;
      dayCell.appendChild(dayText);
      row.appendChild(dayCell);
    }

    const cells = [
      { label: "Time", value: item.time, dim: true },
      { label: "Course", value: item.course, dim: false },
      { label: "Room", value: item.room, dim: false },
    ];
    cells.forEach(function (cell) {
      const div = document.createElement("div");
      div.className = "grid-cell";
      div.setAttribute("data-label", cell.label);
      if (cell.label === "Time") {
        const timeText = document.createElement("span");
        timeText.className = "cell-time";
        timeText.textContent = cell.value;
        div.appendChild(timeText);
        if (now) {
          const tag = document.createElement("span");
          tag.className = "now-tag";
          tag.textContent = "NOW";
          div.appendChild(tag);
        }
      } else if (cell.label === "Course") {
        const courseText = document.createElement("span");
        courseText.className = "course-name";
        courseText.textContent = cell.value;
        div.appendChild(courseText);
      } else {
        const text = document.createElement("span");
        text.className = "room-chip";
        text.textContent = cell.value;
        div.appendChild(text);
      }
      row.appendChild(div);
    });

    const typeCell = document.createElement("div");
    typeCell.className = "grid-cell";
    typeCell.setAttribute("data-label", "Type");
    typeCell.appendChild(typeBadge(item.type));
    row.appendChild(typeCell);

    return row;
  }

  function renderSkeleton() {
    elements.results.innerHTML = "";
    const area = document.createElement("div");
    area.className = "schedule-area";

    const showDay = !state.day;
    const header = document.createElement("div");
    header.className = "grid-header";
    const labels = showDay ? ["Day", "Time", "Course", "Room", "Type"] : ["Time", "Course", "Room", "Type"];
    labels.forEach(function (label) {
      const cell = document.createElement("div");
      cell.textContent = label;
      header.appendChild(cell);
    });
    area.appendChild(header);

    for (let i = 0; i < 6; i++) {
      const row = document.createElement("div");
      row.className = "skeleton-row" + (showDay ? " show-day" : "");
      for (let c = 0; c < labels.length; c++) {
        const block = document.createElement("div");
        block.className = "skeleton-block";
        row.appendChild(block);
      }
      area.appendChild(row);
    }
    elements.results.appendChild(area);
  }

  function setupListeners() {
    if (elements.degree) {
      elements.degree.addEventListener("change", function () {
        state.degree = elements.degree.value;
        populateSemesters();
        render();
      });
    }
    if (elements.semester) {
      elements.semester.addEventListener("change", function () {
        state.semester = elements.semester.value;
        populateSections();
        render();
      });
    }
    if (elements.section) {
      elements.section.addEventListener("change", function () {
        state.section = elements.section.value;
        render();
      });
    }
    if (elements.day) {
      elements.day.addEventListener("change", function () {
        state.day = elements.day.value;
        render();
      });
    }
    if (elements.resetFilters) {
      elements.resetFilters.addEventListener("click", function () {
        state.degree = "";
        state.semester = "";
        state.section = "";
        state.day = "";
        if (elements.degree) {
          elements.degree.value = "";
        }
        if (elements.semester) {
          elements.semester.value = "";
        }
        if (elements.section) {
          elements.section.value = "";
        }
        if (elements.day) {
          elements.day.value = "";
        }
        render();
      });
    }
  }

  function setupTheme() {
    if (!elements.themeToggle) {
      return;
    }
    function applyTheme(theme) {
      document.documentElement.setAttribute("data-theme", theme);
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (error) {
        console.warn("Theme preference could not be stored.", error);
      }
    }
    elements.themeToggle.addEventListener("click", function () {
      const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }

  function init() {
    bindElements();
    setupTheme();
    setupListeners();
    if (elements.footerYear) {
      elements.footerYear.textContent = new Date().getFullYear();
    }
    fetchData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
