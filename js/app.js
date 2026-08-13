"use strict";

(function () {
  const DB_URL = "db/timetable.json?v=" + Date.now();
  const THEME_KEY = "fastschedule-theme";

  const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const FALLBACK_ROOM = "Not specified";
  const FALLBACK_INSTRUCTOR = "Not assigned";

  const state = {
    data: [],
    section: "",
    day: "",
    query: "",
    teacherQuery: "",
    loading: true,
  };

  const elements = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function bindElements() {
    elements.updatedBadge = byId("updated-badge");
    elements.themeToggle = byId("theme-toggle");
    elements.tabs = Array.from(document.querySelectorAll(".tab"));
    elements.panels = Array.from(document.querySelectorAll(".tab-panel"));

    elements.scheduleReset = byId("schedule-reset");
    elements.filterSection = byId("filter-section");
    elements.filterDay = byId("filter-day");
    elements.filterSearch = byId("filter-search");
    elements.scheduleStatus = byId("schedule-status");
    elements.scheduleContainer = byId("schedule-container");

    elements.freeReset = byId("free-reset");
    elements.freeDay = byId("free-day");
    elements.freeTime = byId("free-time");
    elements.freeFind = byId("free-find");
    elements.freeResult = byId("free-result");

    elements.teachersReset = byId("teachers-reset");
    elements.teacherSearch = byId("teacher-search");
    elements.teacherStatus = byId("teacher-status");
    elements.teacherList = byId("teacher-list");
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

  function rangesOverlap(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  function uniqueValues(entries, field, sortFn) {
    const values = Array.from(new Set(entries.map((item) => String(item[field] || "").trim()).filter(Boolean)));
    if (sortFn) {
      values.sort(sortFn);
    }
    return values;
  }

  function sortByDay(value) {
    const index = DAY_ORDER.indexOf(value);
    return index === -1 ? DAY_ORDER.length : index;
  }

  function setStatus(element, message) {
    if (element) {
      element.textContent = message;
    }
  }

  function emptyState(message, icon) {
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state";
    const iconEl = document.createElement("div");
    iconEl.className = "empty-icon";
    iconEl.textContent = icon || "🔍";
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
    renderSchedule();

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
        populateFilterOptions();
        updateUpdatedBadge(payload);
        renderSchedule();
      })
      .catch(function (error) {
        state.loading = false;
        setStatus(elements.scheduleStatus, "Could not load timetable data: " + error.message);
        elements.scheduleContainer.innerHTML = "";
        elements.scheduleContainer.appendChild(emptyState("Unable to fetch the timetable. Check the network or refresh.", "⚠️"));
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

  function populateFilterOptions() {
    const sections = uniqueValues(state.data, "batch_section", function (a, b) {
      return normalizeText(a).localeCompare(normalizeText(b));
    });
    const days = uniqueValues(state.data, "day", function (a, b) {
      return sortByDay(a) - sortByDay(b);
    });
    const times = uniqueValues(state.data, "time", function (a, b) {
      const ra = parseRange(a);
      const rb = parseRange(b);
      return (ra ? ra.start : 0) - (rb ? rb.start : 0);
    });

    fillSelect(elements.filterSection, sections, "All sections");
    fillSelect(elements.filterDay, days, "All days");
    fillSelect(elements.freeDay, days, null);
    fillSelect(elements.freeTime, times, null);
  }

  function fillSelect(select, values, placeholderLabel) {
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
      option.textContent = value;
      select.appendChild(option);
    });
  }

  function getFilteredEntries() {
    const query = normalizeText(state.query);
    return state.data.filter(function (item) {
      if (state.section && String(item.batch_section) !== state.section) {
        return false;
      }
      if (state.day && String(item.day) !== state.day) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = normalizeText([item.course, item.instructor, item.room, item.batch_section, item.department].join(" "));
      return haystack.indexOf(query) !== -1;
    });
  }

  function renderSchedule() {
    if (state.loading) {
      renderSkeleton();
      return;
    }
    elements.scheduleContainer.innerHTML = "";
    const entries = getFilteredEntries();
    if (entries.length === 0) {
      setStatus(elements.scheduleStatus, "No classes match the current filters.");
      elements.scheduleContainer.appendChild(emptyState("Nothing found for the selected filters.", "🗂️"));
      return;
    }
    setStatus(elements.scheduleStatus, entries.length + (entries.length === 1 ? " class" : " classes") + " listed.");

    const headerRow = document.createElement("div");
    headerRow.className = "grid-header";
    ["Day", "Time", "Course", "Instructor", "Room", "Type", "Section", "Department"].forEach(function (label) {
      const cell = document.createElement("div");
      cell.textContent = label;
      headerRow.appendChild(cell);
    });

    const grid = document.createElement("div");
    grid.className = "grid";
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
        const timeDiff = (ra ? ra.start : 0) - (rb ? rb.start : 0);
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return normalizeText(a.batch_section).localeCompare(normalizeText(b.batch_section));
      })
      .forEach(function (item) {
        grid.appendChild(renderRow(item));
      });

    elements.scheduleContainer.appendChild(grid);
  }

  function renderRow(item) {
    const row = document.createElement("div");
    row.className = "grid-row";
    const cells = [
      { label: "Day", value: item.day, bold: true, dim: false },
      { label: "Time", value: item.time, bold: false, dim: true },
      { label: "Course", value: item.course, bold: false, dim: false },
      { label: "Instructor", value: item.instructor, bold: false, dim: true },
      { label: "Room", value: item.room, bold: false, dim: false },
      { label: "Type", value: null, bold: false, dim: false },
      { label: "Section", value: item.batch_section, bold: false, dim: true },
      { label: "Department", value: item.department, bold: false, dim: false },
    ];
    cells.forEach(function (cell) {
      const div = document.createElement("div");
      div.className = "grid-cell";
      div.setAttribute("data-label", cell.label);
      if (cell.value !== null) {
        const strong = cell.bold;
        const text = document.createElement(strong ? "strong" : "span");
        text.textContent = cell.value;
        if (cell.dim) {
          text.classList.add("cell-dim");
        }
        div.appendChild(text);
      } else {
        div.appendChild(typeBadge(item.type));
      }
      row.appendChild(div);
    });
    return row;
  }

  function renderSkeleton() {
    elements.scheduleContainer.innerHTML = "";
    const area = document.createElement("div");
    area.className = "schedule-area";
    const header = document.createElement("div");
    header.className = "grid-header";
    ["Day", "Time", "Course", "Instructor", "Room", "Type", "Section", "Department"].forEach(function (label) {
      const cell = document.createElement("div");
      cell.textContent = label;
      header.appendChild(cell);
    });
    area.appendChild(header);
    for (let i = 0; i < 6; i++) {
      const row = document.createElement("div");
      row.className = "skeleton-row";
      for (let c = 0; c < 8; c++) {
        const block = document.createElement("div");
        block.className = "skeleton-block";
        row.appendChild(block);
      }
      area.appendChild(row);
    }
    elements.scheduleContainer.appendChild(area);
  }

  function renderFreeFinder() {
    elements.freeResult.innerHTML = "";
    const day = elements.freeDay.value;
    const range = parseRange(elements.freeTime.value);

    if (!day || !range) {
      elements.freeResult.appendChild(emptyState("Pick a day and a time slot to see which rooms are free.", "📋"));
      return;
    }

    const inventory = new Set();
    const occupied = new Set();
    const occupiedBy = {};

    state.data.forEach(function (item) {
      if (!item.room || item.room === FALLBACK_ROOM) {
        return;
      }
      inventory.add(item.room);
      const itemRange = parseRange(item.time);
      if (item.day === day && itemRange && rangesOverlap(itemRange, range)) {
        occupied.add(item.room);
        occupiedBy[item.room] = item.course + " · " + item.batch_section;
      }
    });

    const freeRooms = Array.from(inventory).filter(function (room) {
      return !occupied.has(room);
    }).sort(function (a, b) {
      return a.localeCompare(b, undefined, { numeric: true });
    });
    const busyRooms = Array.from(occupied).sort(function (a, b) {
      return a.localeCompare(b, undefined, { numeric: true });
    });

    const note = document.createElement("div");
    note.className = "summary-note";
    note.textContent = day + " " + elements.freeTime.value + " · " + freeRooms.length + " free of " + inventory.size + " rooms.";
    elements.freeResult.appendChild(note);

    if (freeRooms.length === 0) {
      elements.freeResult.appendChild(emptyState("No free rooms for this slot. Try another time.", "⏳"));
    }
    freeRooms.forEach(function (room) {
      const card = document.createElement("div");
      card.className = "room-card free";
      const name = document.createElement("div");
      name.className = "room-name";
      name.textContent = room;
      const meta = document.createElement("div");
      meta.className = "room-meta";
      meta.textContent = "Available on " + day;
      const chip = document.createElement("span");
      chip.className = "status-chip free";
      chip.textContent = "FREE";
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(chip);
      elements.freeResult.appendChild(card);
    });

    if (busyRooms.length > 0) {
      const busyNote = document.createElement("div");
      busyNote.className = "summary-note";
      busyNote.textContent = busyRooms.length + " room" + (busyRooms.length === 1 ? "" : "s") + " occupied during this slot:";
      elements.freeResult.appendChild(busyNote);
      busyRooms.forEach(function (room) {
        const card = document.createElement("div");
        card.className = "room-card busy";
        const name = document.createElement("div");
        name.className = "room-name";
        name.textContent = room;
        const meta = document.createElement("div");
        meta.className = "room-meta";
        meta.textContent = occupiedBy[room] || "In use";
        const chip = document.createElement("span");
        chip.className = "status-chip busy";
        chip.textContent = "BUSY";
        card.appendChild(name);
        card.appendChild(meta);
        card.appendChild(chip);
        elements.freeResult.appendChild(card);
      });
    }
  }

  function getTeacherGroups() {
    const groups = {};
    state.data.forEach(function (item) {
      const instructor = String(item.instructor || "").trim();
      if (!instructor || instructor === FALLBACK_INSTRUCTOR) {
        return;
      }
      if (!groups[instructor]) {
        groups[instructor] = [];
      }
      groups[instructor].push(item);
    });
    return Object.keys(groups)
      .sort(function (a, b) {
        return a.localeCompare(b, undefined, { numeric: true });
      })
      .map(function (name) {
        const classes = groups[name].slice().sort(function (a, b) {
          const dayDiff = sortByDay(a.day) - sortByDay(b.day);
          if (dayDiff !== 0) {
            return dayDiff;
          }
          const ra = parseRange(a.time);
          const rb = parseRange(b.time);
          return (ra ? ra.start : 0) - (rb ? rb.start : 0);
        });
        return { name: name, classes: classes };
      });
  }

  function renderTeachers() {
    elements.teacherList.innerHTML = "";
    const query = normalizeText(state.teacherQuery);
    const groups = getTeacherGroups().filter(function (group) {
      if (!query) {
        return true;
      }
      return normalizeText(group.name).indexOf(query) !== -1 || group.classes.some(function (item) {
        return normalizeText([item.course, item.batch_section].join(" ")).indexOf(query) !== -1;
      });
    });

    if (groups.length === 0) {
      setStatus(elements.teacherStatus, "No instructors match your search.");
      elements.teacherList.appendChild(emptyState("No instructors found for your search.", "👨‍🏫"));
      return;
    }
    setStatus(elements.teacherStatus, groups.length + (groups.length === 1 ? " instructor" : " instructors") + " found.");

    groups.forEach(function (group) {
      const card = document.createElement("details");
      card.className = "teacher-card";
      card.open = !query;

      const summary = document.createElement("summary");
      const left = document.createElement("div");
      const name = document.createElement("div");
      name.className = "teacher-name";
      name.textContent = group.name;
      const meta = document.createElement("div");
      meta.className = "teacher-meta";
      meta.textContent = group.classes.length + " class" + (group.classes.length === 1 ? "" : "es") + " scheduled";
      left.appendChild(name);
      left.appendChild(meta);

      const caret = document.createElement("span");
      caret.className = "teacher-caret";
      caret.textContent = "▾";
      summary.appendChild(left);
      summary.appendChild(caret);

      const classes = document.createElement("div");
      classes.className = "teacher-classes";
      group.classes.forEach(function (item) {
        const row = document.createElement("div");
        row.className = "teacher-class";
        const when = document.createElement("span");
        when.className = "cell-dim";
        when.textContent = item.day + " " + item.time;
        const nameEl = document.createElement("strong");
        nameEl.textContent = item.course;
        const roomEl = document.createElement("span");
        roomEl.className = "cell-dim";
        roomEl.textContent = item.room;
        row.appendChild(when);
        row.appendChild(nameEl);
        row.appendChild(roomEl);
        row.appendChild(typeBadge(item.type));
        classes.appendChild(row);
      });

      card.appendChild(summary);
      card.appendChild(classes);
      elements.teacherList.appendChild(card);
    });
  }

  function resetAllFilters() {
    state.section = "";
    state.day = "";
    state.query = "";
    elements.filterSection.value = "";
    elements.filterDay.value = "";
    elements.filterSearch.value = "";
    elements.scheduleStatus.textContent = "";
    renderSchedule();
  }

  function setupTabs() {
    elements.tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const target = tab.getAttribute("data-tab");
        elements.tabs.forEach(function (other) {
          other.classList.toggle("is-active", other === tab);
        });
        elements.panels.forEach(function (panel) {
          panel.classList.toggle("is-active", panel.getAttribute("data-panel") === target);
        });
        if (target === "free" && elements.freeResult.innerHTML === "") {
          renderFreeFinder();
        }
        if (target === "teachers" && elements.teacherList.innerHTML === "") {
          renderTeachers();
        }
      });
    });
  }

  function setupTheme() {
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

  function setupListeners() {
    elements.filterSection.addEventListener("change", function () {
      state.section = elements.filterSection.value;
      renderSchedule();
    });
    elements.filterDay.addEventListener("change", function () {
      state.day = elements.filterDay.value;
      renderSchedule();
    });
    elements.filterSearch.addEventListener("input", function () {
      state.query = elements.filterSearch.value;
      renderSchedule();
    });
    elements.scheduleReset.addEventListener("click", resetAllFilters);

    elements.freeFind.addEventListener("click", renderFreeFinder);
    elements.freeDay.addEventListener("change", renderFreeFinder);
    elements.freeTime.addEventListener("change", renderFreeFinder);
    elements.freeReset.addEventListener("click", function () {
      if (elements.freeDay.options.length > 1) {
        elements.freeDay.selectedIndex = 0;
      }
      if (elements.freeTime.options.length > 1) {
        elements.freeTime.selectedIndex = 0;
      }
      renderFreeFinder();
    });

    elements.teacherSearch.addEventListener("input", function () {
      state.teacherQuery = elements.teacherSearch.value;
      renderTeachers();
    });
    elements.teachersReset.addEventListener("click", function () {
      state.teacherQuery = "";
      elements.teacherSearch.value = "";
      elements.teacherStatus.textContent = "";
      renderTeachers();
    });
  }

  function init() {
    bindElements();
    setupTabs();
    setupTheme();
    setupListeners();
    fetchData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();