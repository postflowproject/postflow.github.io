// utils.js
export const STORAGE_KEY = "postflow-system5";
export const DB_NAME = "postflow-media";

export const DEFAULT_SETTINGS = {
  theme: "dark",
  defaultVisibility: "Draft",
  confirmDelete: true,
  autoSave: true,
  facebookAppId: "1470881274913401",
};

export const NAVIGATION = [
  { id: "dashboard", label: "Dashboard", icon: "⌂" },
  { id: "bulk", label: "Bulk Posts", icon: "▤" },
  { id: "scheduler", label: "Scheduler", icon: "◷" },
  { id: "queue", label: "Queue Manager", icon: "☷" },
  { id: "media", label: "Media Library", icon: "▧" },
  { id: "history", label: "History", icon: "↺" },
  { id: "pages", label: "Pages", icon: "▣" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function makeId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("Could not restore PostFlow data:", error);
    return null;
  }
}

export function createInitialState() {
  const saved = loadSavedState();
  return {
    drafts: Array.isArray(saved?.drafts) ? saved.drafts : [],
    queue: Array.isArray(saved?.queue) ? saved.queue : [],
    history: Array.isArray(saved?.history) ? saved.history : [],
    pages: Array.isArray(saved?.pages) ? saved.pages : [],
    settings: { ...DEFAULT_SETTINGS, ...saved?.settings },
  };
}

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid date" : date.toLocaleString();
}

export function fileKind(file) {
  if (file?.type?.startsWith("image/")) return "Image";
  if (file?.type?.startsWith("video/")) return "Video";
  if (file?.type?.startsWith("audio/")) return "Audio";
  return "File";
}

export function normaliseFilename(value = "") {
  return value.trim().replace(/^["']|["']$/g, "").split(/[\\/]/).pop().toLowerCase();
}

export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i], next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.toLowerCase().replace(/[_-]+/g, " ").trim());
  const findColumn = (names) => headers.findIndex((header) => names.includes(header));

  const columns = {
    caption: findColumn(["caption", "text", "description", "message", "post", "content"]),
    media: findColumn(["media", "media filename", "filename", "file", "image", "video", "media file", "media filename(s)"]),
    page: findColumn(["page", "pages", "facebook page", "page name"]),
    date: findColumn(["date", "schedule date", "scheduled date", "publish date"]),
    time: findColumn(["time", "schedule time", "scheduled time", "publish time"]),
  };

  return rows.slice(1).map((values) => {
    const get = (index) => (index < 0 ? "" : values[index] || "");
    return {
      caption: get(columns.caption),
      mediaName: get(columns.media),
      page: get(columns.page),
      date: get(columns.date),
      time: get(columns.time),
    };
  });
}

export function csvDateTime(date, time) {
  if (!date) return "";
  const dateTime = new Date(`${date}T${time || "09:00"}`);
  return Number.isNaN(dateTime.getTime()) ? "" : dateTime.toISOString();
}