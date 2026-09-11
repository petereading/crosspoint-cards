// Cloudflare puts no default timeout on a subrequest, so an upstream that
// hangs -- rather than refusing or erroring -- leaves the whole response
// pending indefinitely. A card's own error handling never runs, because
// nothing has thrown yet, and the device sits waiting for a first byte that
// is not being generated. Bound every upstream call so a stalled service
// degrades to a fallback or a prompt 502 instead.
const UPSTREAM_TIMEOUT_MS = 8000;

function upstreamSignal() {
  return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}

// Rendering is synchronous, so these dimensions can be switched safely for
// one card and restored by the next render without request interleaving.
let WIDTH = 528;
let HEIGHT = 792;
let PIXEL_ROW_BYTES = Math.ceil(WIDTH / 8);

function setCanvasDimensions(device, orientation) {
  const landscape = orientation === "landscape";
  const portraitWidth = device === "x4" ? 480 : 528;
  const portraitHeight = device === "x4" ? 800 : 792;
  WIDTH = landscape ? portraitHeight : portraitWidth;
  HEIGHT = landscape ? portraitWidth : portraitHeight;
  PIXEL_ROW_BYTES = Math.ceil(WIDTH / 8);
}

function resolveDevice(url) {
  const requested = (url.searchParams.get("device") || "x3").trim().toLowerCase();
  if (requested === "x3" || requested === "x4") return requested;
  return null;
}

function resolveOrientation(url) {
  const requested = (url.searchParams.get("orientation") || "portrait").trim().toLowerCase();
  if (requested === "portrait" || requested === "p") return "portrait";
  if (requested === "landscape" || requested === "l") return "landscape";
  return null;
}

// Compact 5x7 bitmap font. Each value is one five-pixel-wide row.
const FONT = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  "A": [14, 17, 17, 31, 17, 17, 17],
  "B": [30, 17, 17, 30, 17, 17, 30],
  "C": [14, 17, 16, 16, 16, 17, 14],
  "D": [30, 17, 17, 17, 17, 17, 30],
  "E": [31, 16, 16, 30, 16, 16, 31],
  "F": [31, 16, 16, 30, 16, 16, 16],
  "G": [14, 17, 16, 23, 17, 17, 15],
  "H": [17, 17, 17, 31, 17, 17, 17],
  "I": [14, 4, 4, 4, 4, 4, 14],
  "J": [7, 2, 2, 2, 2, 18, 12],
  "K": [17, 18, 20, 24, 20, 18, 17],
  "L": [16, 16, 16, 16, 16, 16, 31],
  "M": [17, 27, 21, 21, 17, 17, 17],
  "N": [17, 25, 21, 19, 17, 17, 17],
  "O": [14, 17, 17, 17, 17, 17, 14],
  "P": [30, 17, 17, 30, 16, 16, 16],
  "Q": [14, 17, 17, 17, 21, 18, 13],
  "R": [30, 17, 17, 30, 20, 18, 17],
  "S": [15, 16, 16, 14, 1, 1, 30],
  "T": [31, 4, 4, 4, 4, 4, 4],
  "U": [17, 17, 17, 17, 17, 17, 14],
  "V": [17, 17, 17, 17, 17, 10, 4],
  "W": [17, 17, 17, 21, 21, 21, 10],
  "X": [17, 17, 10, 4, 10, 17, 17],
  "Y": [17, 17, 10, 4, 4, 4, 4],
  "Z": [31, 1, 2, 4, 8, 16, 31],
  ":": [0, 4, 4, 0, 4, 4, 0],
  "-": [0, 0, 0, 31, 0, 0, 0],
  "/": [1, 2, 2, 4, 8, 8, 16],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 0, 4, 8],
  "%": [17, 2, 4, 8, 17, 0, 0],
  "'": [4, 4, 8, 0, 0, 0, 0],
  "&": [12, 18, 20, 8, 21, 18, 13],
  "+": [0, 4, 4, 31, 4, 4, 0],
  "=": [0, 0, 31, 0, 31, 0, 0],
  "?": [14, 17, 1, 2, 4, 0, 4],
};

function setPixel(canvas, x, y, black = true) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const index = y * PIXEL_ROW_BYTES + (x >> 3);
  const mask = 1 << (7 - (x & 7));
  if (black) canvas[index] |= mask;
  else canvas[index] &= ~mask;
}

function fillRect(canvas, x, y, w, h, black = true) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) setPixel(canvas, px, py, black);
  }
}

function drawLine(canvas, x0, y0, x1, y1, thickness = 1) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    fillRect(canvas, x0 - Math.floor(thickness / 2), y0 - Math.floor(thickness / 2), thickness, thickness);
    if (x0 === x1 && y0 === y1) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x0 += sx;
    }
    if (twice <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

function drawRect(canvas, x, y, w, h, thickness = 1) {
  fillRect(canvas, x, y, w, thickness);
  fillRect(canvas, x, y + h - thickness, w, thickness);
  fillRect(canvas, x, y, thickness, h);
  fillRect(canvas, x + w - thickness, y, thickness, h);
}

function fillCircle(canvas, cx, cy, radius, black = true) {
  for (let y = -radius; y <= radius; y++) {
    const halfWidth = Math.floor(Math.sqrt(radius * radius - y * y));
    for (let x = -halfWidth; x <= halfWidth; x++) setPixel(canvas, cx + x, cy + y, black);
  }
}

function drawCircle(canvas, cx, cy, radius, thickness = 1) {
  fillCircle(canvas, cx, cy, radius, true);
  if (radius > thickness) fillCircle(canvas, cx, cy, radius - thickness, false);
}

function cleanText(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, " ")
    .replace(/[–—]/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 :\-/.%,'&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textWidth(text, scale) {
  return text.length ? text.length * 5 * scale + (text.length - 1) * scale : 0;
}

function drawChar(canvas, ch, x, y, scale) {
  const glyph = FONT[ch] || FONT["?"];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (!(glyph[row] & (1 << (4 - col)))) continue;
      fillRect(canvas, x + col * scale, y + row * scale, scale, scale);
    }
  }
}

function drawText(canvas, text, x, y, scale) {
  const clean = cleanText(text);
  let cursor = x;
  for (const ch of clean) {
    drawChar(canvas, ch, cursor, y, scale);
    cursor += 6 * scale;
  }
}

function drawTextCentered(canvas, text, y, scale, maxWidth = WIDTH - 24) {
  let clean = cleanText(text);
  while (scale > 1 && textWidth(clean, scale) > maxWidth) scale--;
  while (clean && textWidth(clean, scale) > maxWidth) clean = clean.slice(0, -1).trim();
  drawText(canvas, clean, Math.floor((WIDTH - textWidth(clean, scale)) / 2), y, scale);
}

function wrapText(text, scale, maxWidth, maxLines) {
  const words = cleanText(text).split(" ").filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, scale) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (line && textWidth(line, scale) > maxWidth) line = line.slice(0, -1).trim();
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  if (lines.length === maxLines) {
    const consumed = lines.join(" ").split(" ").length;
    if (consumed < words.length) {
      let last = lines[maxLines - 1];
      while (last && textWidth(`${last}.`, scale) > maxWidth) last = last.slice(0, -1).trim();
      lines[maxLines - 1] = `${last}.`;
    }
  }
  return lines;
}

function drawWrappedText(canvas, text, x, y, scale, maxWidth, maxLines, lineHeight = 9 * scale) {
  const lines = wrapText(text, scale, maxWidth, maxLines);
  lines.forEach((line, index) => drawText(canvas, line, x, y + index * lineHeight, scale));
  return lines.length;
}

function drawWrappedTextCentered(canvas, text, x, y, scale, width, maxLines, lineHeight = 9 * scale) {
  const lines = wrapText(text, scale, width, maxLines);
  lines.forEach((line, index) => {
    drawText(canvas, line, x + Math.floor((width - textWidth(line, scale)) / 2), y + index * lineHeight, scale);
  });
  return lines.length;
}

// Wikiquote stores song lyrics and poems as <br>-separated lines. Flowed into
// a paragraph they read as one breathless run-on, so lay the lines out as
// written whenever they fit the space and only fall back to flowing when they
// do not. A blank entry is a stanza break and costs one line.
function verseLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => cleanText(line));
}

function layoutVerse(lines, scale, width, maxLines) {
  const out = [];
  for (const line of lines) {
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (textWidth(line, scale) <= width) {
      out.push(line);
      continue;
    }
    for (const wrapped of wrapText(line, scale, width, maxLines)) out.push(wrapped);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.length > 1 && out.length <= maxLines ? out : null;
}

// A stanza break reads clearly at a little over half a line, and buys back the
// room a full blank line would cost on a card this size.
function verseGap(lineHeight) {
  return Math.round(lineHeight * 0.55);
}

// Walks the block once, returning each drawable line with its y offset. A
// blank entry is a stanza break and advances by the smaller gap.
function verseRows(lines, lineHeight) {
  const gap = verseGap(lineHeight);
  const rows = [];
  let offset = 0;
  for (const line of lines) {
    if (!line) {
      offset += gap;
      continue;
    }
    rows.push({ line, offset });
    offset += lineHeight;
  }
  return rows;
}

// Glyphs are 7 rows tall before scaling, so the last line adds ink but no advance.
function verseHeight(lines, scale, lineHeight) {
  const rows = verseRows(lines, lineHeight);
  return rows.length ? rows[rows.length - 1].offset + 7 * scale : 0;
}

function drawVerseCentered(canvas, lines, x, y, scale, width, lineHeight) {
  for (const row of verseRows(lines, lineHeight)) {
    drawText(canvas, row.line, x + Math.floor((width - textWidth(row.line, scale)) / 2), y + row.offset, scale);
  }
}

// Picks the largest scale whose verse block fits the span, or null to flow.
// The margin keeps the last line clear of the rule beneath it.
function fitVerse(text, width, span, scales) {
  const lines = verseLines(text);
  if (lines.filter(Boolean).length < 2) return null;
  for (const [scale, lineHeight] of scales) {
    const laid = layoutVerse(lines, scale, width, Math.ceil(span / lineHeight) + 4);
    if (!laid) continue;
    const height = verseHeight(laid, scale, lineHeight);
    if (height <= span - 16) return { lines: laid, scale, lineHeight, height };
  }
  return null;
}

function makeBmp(canvas) {
  const rowStride = (PIXEL_ROW_BYTES + 3) & ~3;
  const pixelBytes = rowStride * HEIGHT;
  const pixelOffset = 14 + 40 + 8;
  const fileSize = pixelOffset + pixelBytes;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, fileSize, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, WIDTH, true);
  view.setInt32(22, HEIGHT, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 1, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(46, 2, true);
  view.setUint32(50, 2, true);
  out.set([255, 255, 255, 0, 0, 0, 0, 0], 54);

  for (let y = 0; y < HEIGHT; y++) {
    const source = y * PIXEL_ROW_BYTES;
    const destination = pixelOffset + (HEIGHT - 1 - y) * rowStride;
    out.set(canvas.subarray(source, source + PIXEL_ROW_BYTES), destination);
  }
  return out;
}

function getClockParts(now, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
  } catch {
    return null;
  }

  const parts = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  return {
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday.toUpperCase(),
    date: `${parts.day} ${parts.month.toUpperCase()} ${parts.year}`,
    zoneName: (parts.timeZoneName || "").toUpperCase(),
  };
}

function shortLocationLabel(timeZone) {
  const tail = timeZone.split("/").pop() || timeZone;
  return tail.replace(/_/g, " ").toUpperCase();
}

// Short codes for the clock card, so a card URL can say ?location=HKG rather
// than ?tz=Asia/Hong_Kong. Each entry is [IANA zone, display label]; several
// codes share a zone deliberately, because the label is what the card shows.
// Latitude and longitude are carried too, so the astro card can place houses
// from a code alone without a geocoding lookup.
// A full IANA zone is still accepted in `location`, and `tz` keeps working.
const CLOCK_LOCATIONS = {
  LON: ["Europe/London", "LONDON", 51.51, -0.13],
  DUB: ["Europe/Dublin", "DUBLIN", 53.35, -6.26],
  LIS: ["Europe/Lisbon", "LISBON", 38.72, -9.14],
  MAD: ["Europe/Madrid", "MADRID", 40.42, -3.7],
  BCN: ["Europe/Madrid", "BARCELONA", 41.39, 2.17],
  PAR: ["Europe/Paris", "PARIS", 48.86, 2.35],
  AMS: ["Europe/Amsterdam", "AMSTERDAM", 52.37, 4.9],
  BRU: ["Europe/Brussels", "BRUSSELS", 50.85, 4.35],
  FRA: ["Europe/Berlin", "FRANKFURT", 50.11, 8.68],
  BER: ["Europe/Berlin", "BERLIN", 52.52, 13.4],
  MUC: ["Europe/Berlin", "MUNICH", 48.14, 11.58],
  ZRH: ["Europe/Zurich", "ZURICH", 47.38, 8.54],
  MIL: ["Europe/Rome", "MILAN", 45.46, 9.19],
  ROM: ["Europe/Rome", "ROME", 41.9, 12.5],
  VIE: ["Europe/Vienna", "VIENNA", 48.21, 16.37],
  PRG: ["Europe/Prague", "PRAGUE", 50.08, 14.44],
  WAW: ["Europe/Warsaw", "WARSAW", 52.23, 21.01],
  STO: ["Europe/Stockholm", "STOCKHOLM", 59.33, 18.07],
  OSL: ["Europe/Oslo", "OSLO", 59.91, 10.75],
  CPH: ["Europe/Copenhagen", "COPENHAGEN", 55.68, 12.57],
  HEL: ["Europe/Helsinki", "HELSINKI", 60.17, 24.94],
  ATH: ["Europe/Athens", "ATHENS", 37.98, 23.73],
  MOW: ["Europe/Moscow", "MOSCOW", 55.76, 37.62],
  IST: ["Europe/Istanbul", "ISTANBUL", 41.01, 28.98],
  NYC: ["America/New_York", "NEW YORK", 40.71, -74.01],
  BOS: ["America/New_York", "BOSTON", 42.36, -71.06],
  WAS: ["America/New_York", "WASHINGTON", 38.91, -77.04],
  MIA: ["America/New_York", "MIAMI", 25.76, -80.19],
  TOR: ["America/Toronto", "TORONTO", 43.65, -79.38],
  CHI: ["America/Chicago", "CHICAGO", 41.88, -87.63],
  DEN: ["America/Denver", "DENVER", 39.74, -104.99],
  LAX: ["America/Los_Angeles", "LOS ANGELES", 34.05, -118.24],
  SFO: ["America/Los_Angeles", "SAN FRANCISCO", 37.77, -122.42],
  SEA: ["America/Los_Angeles", "SEATTLE", 47.61, -122.33],
  YVR: ["America/Vancouver", "VANCOUVER", 49.28, -123.12],
  ANC: ["America/Anchorage", "ANCHORAGE", 61.22, -149.9],
  HNL: ["Pacific/Honolulu", "HONOLULU", 21.31, -157.86],
  MEX: ["America/Mexico_City", "MEXICO CITY", 19.43, -99.13],
  BOG: ["America/Bogota", "BOGOTA", 4.71, -74.07],
  LIM: ["America/Lima", "LIMA", -12.05, -77.04],
  SCL: ["America/Santiago", "SANTIAGO", -33.45, -70.67],
  BUE: ["America/Argentina/Buenos_Aires", "BUENOS AIRES", -34.6, -58.38],
  GRU: ["America/Sao_Paulo", "SAO PAULO", -23.55, -46.63],
  DXB: ["Asia/Dubai", "DUBAI", 25.2, 55.27],
  DOH: ["Asia/Qatar", "DOHA", 25.29, 51.53],
  RUH: ["Asia/Riyadh", "RIYADH", 24.71, 46.68],
  TLV: ["Asia/Jerusalem", "TEL AVIV", 32.08, 34.78],
  CAI: ["Africa/Cairo", "CAIRO", 30.04, 31.24],
  JNB: ["Africa/Johannesburg", "JOHANNESBURG", -26.2, 28.05],
  LOS: ["Africa/Lagos", "LAGOS", 6.52, 3.38],
  NBO: ["Africa/Nairobi", "NAIROBI", -1.29, 36.82],
  CAS: ["Africa/Casablanca", "CASABLANCA", 33.57, -7.59],
  KHI: ["Asia/Karachi", "KARACHI", 24.86, 67.01],
  DEL: ["Asia/Kolkata", "DELHI", 28.61, 77.21],
  BOM: ["Asia/Kolkata", "MUMBAI", 19.08, 72.88],
  BLR: ["Asia/Kolkata", "BANGALORE", 12.97, 77.59],
  KTM: ["Asia/Kathmandu", "KATHMANDU", 27.72, 85.32],
  DAC: ["Asia/Dhaka", "DHAKA", 23.81, 90.41],
  BKK: ["Asia/Bangkok", "BANGKOK", 13.76, 100.5],
  SGN: ["Asia/Ho_Chi_Minh", "HO CHI MINH", 10.82, 106.63],
  SIN: ["Asia/Singapore", "SINGAPORE", 1.35, 103.82],
  KUL: ["Asia/Kuala_Lumpur", "KUALA LUMPUR", 3.14, 101.69],
  JKT: ["Asia/Jakarta", "JAKARTA", -6.21, 106.85],
  MNL: ["Asia/Manila", "MANILA", 14.6, 120.98],
  HKG: ["Asia/Hong_Kong", "HONG KONG", 22.32, 114.17],
  MFM: ["Asia/Macau", "MACAU", 22.2, 113.54],
  TPE: ["Asia/Taipei", "TAIPEI", 25.03, 121.57],
  PEK: ["Asia/Shanghai", "BEIJING", 39.9, 116.41],
  SHA: ["Asia/Shanghai", "SHANGHAI", 31.23, 121.47],
  CAN: ["Asia/Shanghai", "GUANGZHOU", 23.13, 113.26],
  SEL: ["Asia/Seoul", "SEOUL", 37.57, 126.98],
  TYO: ["Asia/Tokyo", "TOKYO", 35.68, 139.65],
  OSA: ["Asia/Tokyo", "OSAKA", 34.69, 135.5],
  PER: ["Australia/Perth", "PERTH", -31.95, 115.86],
  ADL: ["Australia/Adelaide", "ADELAIDE", -34.93, 138.6],
  BNE: ["Australia/Brisbane", "BRISBANE", -27.47, 153.03],
  MEL: ["Australia/Melbourne", "MELBOURNE", -37.81, 144.96],
  SYD: ["Australia/Sydney", "SYDNEY", -33.87, 151.21],
  AKL: ["Pacific/Auckland", "AUCKLAND", -36.85, 174.76],
  SUV: ["Pacific/Fiji", "SUVA", -18.14, 178.44],
  UTC: ["UTC", "UTC", 0.0, 0.0]
};

function locationsListing() {
  return Object.keys(CLOCK_LOCATIONS)
    .sort()
    .map((code) => `${code.padEnd(5)}${CLOCK_LOCATIONS[code][1].padEnd(15)}${CLOCK_LOCATIONS[code][0]}`)
    .join("\n");
}

// Resolves the clock's zone and the label drawn on the card. Returns null for
// a code that is neither known nor a usable IANA zone, so the caller can point
// the user at /locations.txt instead of silently showing the wrong city.
function resolveClockLocation(url, request) {
  const requested = url.searchParams.get("location")?.trim();
  if (!requested || requested.toLowerCase() === "auto") {
    const timeZone = resolveClockTimeZone(url, request);
    return { timeZone, label: shortLocationLabel(timeZone) };
  }
  const known = CLOCK_LOCATIONS[requested.toUpperCase()];
  if (known) return { timeZone: known[0], label: known[1] };
  if (requested.includes("/") || requested.toUpperCase() === "UTC") {
    return { timeZone: requested, label: shortLocationLabel(requested) };
  }
  return null;
}

// The device renders what the worker generated some seconds earlier, so a
// to-the-minute clock is always behind by the length of the fetch. `lead`
// moves the rendered time forward by that much, and `round` snaps it to a
// coarser mark. Every real UTC offset is a whole number of 15 minutes, so
// rounding against UTC lands on the same marks in every zone.
function clockInstant(url) {
  const lead = Math.min(600, Math.max(0, Math.floor(Number(url.searchParams.get("lead") || 0)) || 0));
  const round = Math.min(60, Math.max(0, Math.floor(Number(url.searchParams.get("round") || 0)) || 0));
  let ms = Date.now() + lead * 1000;
  if (round > 0) {
    const step = round * 60000;
    ms = Math.round(ms / step) * step;
  }
  return new Date(ms);
}

function renderClockBmp(timeZone, orientation, device, label, now) {
  setCanvasDimensions(device, orientation);
  const clock = getClockParts(now || new Date(), timeZone);
  if (!clock) return null;

  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, clock.time, compact ? 76 : 105, 18);
    drawTextCentered(canvas, clock.weekday, compact ? 245 : 280, 7);
    drawTextCentered(canvas, clock.date, compact ? 315 : 355, 6);
    drawTextCentered(canvas, label || shortLocationLabel(timeZone), compact ? 385 : 435, 4);
    if (clock.zoneName) drawTextCentered(canvas, clock.zoneName, compact ? 432 : 480, 3);
  } else {
    drawTextCentered(canvas, clock.time, 220, 16);
    drawTextCentered(canvas, clock.weekday, 390, 7);
    drawTextCentered(canvas, clock.date, 470, 6);
    drawTextCentered(canvas, label || shortLocationLabel(timeZone), 585, 4);
    if (clock.zoneName) drawTextCentered(canvas, clock.zoneName, 635, 4);
  }
  return makeBmp(canvas);
}

function resolveClockTimeZone(url, request) {
  const requested = url.searchParams.get("tz")?.trim();
  if (!requested || requested.toLowerCase() === "auto") {
    return request.cf?.timezone || "Europe/London";
  }
  return requested;
}

function weatherCategory(code) {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}

function conditionLabel(code) {
  const labels = {
    0: "CLEAR",
    1: "MAINLY CLEAR",
    2: "PARTLY CLOUDY",
    3: "OVERCAST",
    45: "FOG",
    48: "RIME FOG",
    51: "LIGHT DRIZZLE",
    53: "DRIZZLE",
    55: "HEAVY DRIZZLE",
    56: "FREEZING DRIZZLE",
    57: "FREEZING DRIZZLE",
    61: "LIGHT RAIN",
    63: "RAIN",
    65: "HEAVY RAIN",
    66: "FREEZING RAIN",
    67: "FREEZING RAIN",
    71: "LIGHT SNOW",
    73: "SNOW",
    75: "HEAVY SNOW",
    77: "SNOW GRAINS",
    80: "RAIN SHOWERS",
    81: "RAIN SHOWERS",
    82: "HEAVY SHOWERS",
    85: "SNOW SHOWERS",
    86: "HEAVY SNOW",
    95: "THUNDERSTORM",
    96: "STORM WITH HAIL",
    99: "STORM WITH HAIL",
  };
  return labels[code] || "CLOUDY";
}

function currentConditionLabel(code, isDay) {
  if (code === 0) return isDay === 0 ? "CLEAR" : "SUNNY";
  if (code === 1) return isDay === 0 ? "MOSTLY CLEAR" : "MOSTLY SUNNY";
  return conditionLabel(code);
}

function drawCloud(canvas, cx, cy, size) {
  const s = size / 100;
  fillCircle(canvas, cx - 24 * s, cy + 2 * s, Math.round(19 * s));
  fillCircle(canvas, cx, cy - 13 * s, Math.round(28 * s));
  fillCircle(canvas, cx + 29 * s, cy + 3 * s, Math.round(22 * s));
  fillRect(canvas, cx - 43 * s, cy, 88 * s, 25 * s);
}

function drawSun(canvas, cx, cy, size) {
  const radius = Math.max(5, Math.round(size * 0.2));
  drawCircle(canvas, cx, cy, radius, Math.max(2, Math.round(size / 30)));
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * i) / 4;
    const inner = radius + size * 0.1;
    const outer = radius + size * 0.25;
    drawLine(
      canvas,
      cx + Math.cos(angle) * inner,
      cy + Math.sin(angle) * inner,
      cx + Math.cos(angle) * outer,
      cy + Math.sin(angle) * outer,
      Math.max(1, Math.round(size / 35))
    );
  }
}

function drawSunEventIcon(canvas, cx, cy, size, rising) {
  const radius = Math.max(5, Math.round(size * 0.18));
  const horizonY = cy + Math.round(size * 0.11);
  drawCircle(canvas, cx, horizonY, radius, Math.max(2, Math.round(size / 20)));
  fillRect(canvas, cx - radius - 3, horizonY, radius * 2 + 7, radius + 4, false);
  drawLine(canvas, cx - size * 0.42, horizonY, cx + size * 0.42, horizonY, Math.max(2, Math.round(size / 18)));
  drawLine(canvas, cx, cy - size * 0.34, cx, cy - size * 0.18, 2);
  drawLine(canvas, cx - size * 0.29, cy - size * 0.2, cx - size * 0.18, cy - size * 0.1, 2);
  drawLine(canvas, cx + size * 0.29, cy - size * 0.2, cx + size * 0.18, cy - size * 0.1, 2);
  const arrowX = cx + size * 0.31;
  const arrowTipY = rising ? cy - size * 0.12 : cy + size * 0.34;
  const arrowTailY = rising ? cy + size * 0.34 : cy - size * 0.12;
  const headY = arrowTipY + (rising ? size * 0.09 : -size * 0.09);
  drawLine(canvas, arrowX, arrowTailY, arrowX, arrowTipY, 2);
  drawLine(canvas, arrowX, arrowTipY, arrowX - size * 0.08, headY, 2);
  drawLine(canvas, arrowX, arrowTipY, arrowX + size * 0.08, headY, 2);
}

function drawSunEventGroup(canvas, centerX, cy, label, time, size, rising, timeScale) {
  const labelScale = 2;
  const iconWidth = Math.round(size * 0.84);
  const gap = Math.max(10, Math.round(size * 0.22));
  const textBlockWidth = Math.max(textWidth(label, labelScale), textWidth(time, timeScale));
  const groupWidth = iconWidth + gap + textBlockWidth;
  const startX = Math.round(centerX - groupWidth / 2);
  const textX = startX + iconWidth + gap;
  drawSunEventIcon(canvas, startX + iconWidth / 2, cy, size, rising);
  drawText(canvas, label, textX + Math.floor((textBlockWidth - textWidth(label, labelScale)) / 2), cy - 25, labelScale);
  drawText(canvas, time, textX + Math.floor((textBlockWidth - textWidth(time, timeScale)) / 2), cy + 5, timeScale);
}

function drawWeatherIcon(canvas, code, cx, cy, size) {
  const category = weatherCategory(code);
  const scale = size / 100;

  if (category === "clear") {
    drawSun(canvas, cx, cy, size);
    return;
  }

  if (category === "partly") {
    drawSun(canvas, cx - 22 * scale, cy - 22 * scale, size * 0.65);
    drawCloud(canvas, cx + 8 * scale, cy + 10 * scale, size * 0.78);
    return;
  }

  if (category === "fog") {
    for (let i = -2; i <= 2; i++) {
      drawLine(canvas, cx - size * 0.38, cy + i * size * 0.14, cx + size * 0.38, cy + i * size * 0.14, 3);
    }
    return;
  }

  drawCloud(canvas, cx, cy - 10 * scale, size * 0.78);

  if (category === "rain" || category === "drizzle") {
    const count = category === "drizzle" ? 3 : 4;
    for (let i = 0; i < count; i++) {
      const x = cx + (i - (count - 1) / 2) * 20 * scale;
      drawLine(canvas, x + 5 * scale, cy + 24 * scale, x - 5 * scale, cy + 44 * scale, Math.max(2, Math.round(3 * scale)));
    }
  } else if (category === "snow") {
    for (const offset of [-25, 0, 25]) {
      const x = cx + offset * scale;
      const y = cy + 35 * scale;
      drawLine(canvas, x - 7 * scale, y, x + 7 * scale, y, 2);
      drawLine(canvas, x, y - 7 * scale, x, y + 7 * scale, 2);
      drawLine(canvas, x - 5 * scale, y - 5 * scale, x + 5 * scale, y + 5 * scale, 2);
      drawLine(canvas, x + 5 * scale, y - 5 * scale, x - 5 * scale, y + 5 * scale, 2);
    }
  } else if (category === "storm") {
    drawLine(canvas, cx + 5 * scale, cy + 18 * scale, cx - 8 * scale, cy + 39 * scale, Math.max(3, Math.round(5 * scale)));
    drawLine(canvas, cx - 8 * scale, cy + 39 * scale, cx + 7 * scale, cy + 36 * scale, Math.max(3, Math.round(5 * scale)));
    drawLine(canvas, cx + 7 * scale, cy + 36 * scale, cx - 8 * scale, cy + 58 * scale, Math.max(3, Math.round(5 * scale)));
  }
}

function dayLabel(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getUTCDay()];
}

function updatedLabel(localIsoTime) {
  const match = String(localIsoTime || "").match(/T(\d{2}:\d{2})/);
  return match ? match[1] : "--:--";
}

function renderWeatherBmp(place, weather, imperial, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  const current = weather.current;
  const daily = weather.daily;
  const tempUnit = imperial ? "F" : "C";
  const windUnit = imperial ? "MPH" : "KM/H";
  const sunrise = updatedLabel(daily.sunrise?.[0]);
  const sunset = updatedLabel(daily.sunset?.[0]);
  const condition = currentConditionLabel(current.weather_code, current.is_day);

  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, place.label, compact ? 10 : 14, 5, WIDTH - 30);
    drawTextCentered(canvas, condition, compact ? 50 : 54, 3, WIDTH - 36);
    fillRect(canvas, 20, compact ? 78 : 84, WIDTH - 40, 3);

    drawWeatherIcon(canvas, current.weather_code, 118, compact ? 157 : 170, 108);
    drawTextCenteredInBox(canvas, `${Math.round(current.temperature_2m)}${tempUnit}`, 205, 280, compact ? 109 : 118, 13);

    const sunY = compact ? 231 : 246;
    drawSunEventGroup(canvas, 137, sunY, "SUNRISE", sunrise, 42, true, 3);
    drawSunEventGroup(canvas, 368, sunY, "SUNSET", sunset, 42, false, 3);

    const detailsX = 505;
    const detailsWidth = WIDTH - detailsX - 20;
    const detailsY = compact ? 101 : 107;
    drawRect(canvas, detailsX, detailsY, detailsWidth, compact ? 166 : 174, 2);
    drawTextCenteredInBox(
      canvas,
      `FEELS ${Math.round(current.apparent_temperature)}${tempUnit}`,
      detailsX,
      detailsWidth,
      compact ? 120 : 128,
      3
    );
    drawTextCenteredInBox(
      canvas,
      `HUM ${Math.round(current.relative_humidity_2m)}%`,
      detailsX,
      detailsWidth,
      compact ? 157 : 167,
      3
    );
    drawTextCenteredInBox(
      canvas,
      `WIND ${Math.round(current.wind_speed_10m)} ${windUnit}`,
      detailsX,
      detailsWidth,
      compact ? 194 : 206,
      3
    );
    drawTextCenteredInBox(
      canvas,
      `RAIN ${Math.round(daily.precipitation_probability_max[0] || 0)}%`,
      detailsX,
      detailsWidth,
      compact ? 231 : 245,
      3
    );

    const days = Math.min(5, daily.time.length);
    const gap = 12;
    const cardWidth = Math.floor((WIDTH - 36 - gap * (days - 1)) / days);
    const startX = Math.floor((WIDTH - (cardWidth * days + gap * (days - 1))) / 2);
    const cardsY = compact ? 285 : 301;
    const cardsHeight = compact ? 145 : 176;
    for (let i = 0; i < days; i++) {
      const x = startX + i * (cardWidth + gap);
      drawRect(canvas, x, cardsY, cardWidth, cardsHeight, 2);
      drawTextCenteredInBox(canvas, dayLabel(daily.time[i]), x, cardWidth, cardsY + 12, 3);
      drawWeatherIcon(canvas, daily.weather_code[i], x + cardWidth / 2, cardsY + (compact ? 67 : 74), 48);
      drawTextCenteredInBox(
        canvas,
        `${Math.round(daily.temperature_2m_max[i])}${tempUnit}`,
        x,
        cardWidth,
        cardsY + (compact ? 101 : 115),
        3
      );
      drawTextCenteredInBox(
        canvas,
        `${Math.round(daily.temperature_2m_min[i])}${tempUnit}`,
        x,
        cardWidth,
        cardsY + (compact ? 124 : 144),
        2
      );
    }

    drawTextCentered(canvas, `UPDATED ${updatedLabel(current.time)} LOCAL`, HEIGHT - 31, 2);
    drawTextCentered(canvas, "DATA OPEN-METEO", HEIGHT - 14, 1);
    return makeBmp(canvas);
  }

  drawTextCentered(canvas, place.label, 24, 6, WIDTH - 30);
  drawTextCentered(canvas, condition, 78, 4, WIDTH - 30);
  fillRect(canvas, 24, 114, WIDTH - 48, 3);

  const iconX = Math.round(WIDTH * 0.269);
  const temperatureX = Math.round(WIDTH * 0.483);
  drawWeatherIcon(canvas, current.weather_code, iconX, 216, 128);
  drawTextCenteredInBox(canvas, `${Math.round(current.temperature_2m)}${tempUnit}`, temperatureX, WIDTH - temperatureX - 18, 166, 13);

  drawSunEventGroup(canvas, WIDTH / 4, 327, "SUNRISE", sunrise, 48, true, 4);
  drawSunEventGroup(canvas, (WIDTH * 3) / 4, 327, "SUNSET", sunset, 48, false, 4);

  drawRect(canvas, 25, 394, WIDTH - 50, 72, 2);
  drawTextCentered(
    canvas,
    `FEELS ${Math.round(current.apparent_temperature)}${tempUnit}   HUM ${Math.round(current.relative_humidity_2m)}%`,
    408,
    3,
    WIDTH - 70
  );
  drawTextCentered(
    canvas,
    `WIND ${Math.round(current.wind_speed_10m)} ${windUnit}   RAIN ${Math.round(daily.precipitation_probability_max[0] || 0)}%`,
    438,
    3,
    WIDTH - 70
  );

  const days = Math.min(5, daily.time.length);
  const gap = 10;
  const cardWidth = Math.floor((WIDTH - 36 - gap * (days - 1)) / days);
  const startX = Math.floor((WIDTH - (cardWidth * days + gap * (days - 1))) / 2);
  for (let i = 0; i < days; i++) {
    const x = startX + i * (cardWidth + gap);
    drawRect(canvas, x, 491, cardWidth, 184, 2);
    drawTextCenteredInBox(canvas, dayLabel(daily.time[i]), x, cardWidth, 506, 3);
    drawWeatherIcon(canvas, daily.weather_code[i], x + cardWidth / 2, 571, 53);
    drawTextCenteredInBox(
      canvas,
      `${Math.round(daily.temperature_2m_max[i])}${tempUnit}`,
      x,
      cardWidth,
      616,
      3
    );
    drawTextCenteredInBox(
      canvas,
      `${Math.round(daily.temperature_2m_min[i])}${tempUnit}`,
      x,
      cardWidth,
      646,
      2
    );
  }

  drawTextCentered(canvas, `UPDATED ${updatedLabel(current.time)} LOCAL`, HEIGHT - 49, 2);
  drawTextCentered(canvas, "DATA OPEN-METEO", HEIGHT - 22, 1);
  return makeBmp(canvas);
}

function drawTextCenteredInBox(canvas, text, x, width, y, scale) {
  let clean = cleanText(text);
  while (scale > 1 && textWidth(clean, scale) > width - 8) scale--;
  while (clean && textWidth(clean, scale) > width - 8) clean = clean.slice(0, -1).trim();
  drawText(canvas, clean, x + Math.floor((width - textWidth(clean, scale)) / 2), y, scale);
}

function validCoordinate(value, minimum, maximum) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

async function resolvePlace(url, request) {
  const latitude = validCoordinate(url.searchParams.get("lat"), -90, 90);
  const longitude = validCoordinate(url.searchParams.get("lon"), -180, 180);
  const requestedLabel = cleanText(url.searchParams.get("label") || "");

  if (latitude !== null && longitude !== null) {
    return { latitude, longitude, label: requestedLabel || "SELECTED LOCATION" };
  }

  const requestedLocation = (url.searchParams.get("location") || "").trim();
  const automatic = !requestedLocation || requestedLocation.toLowerCase() === "auto";
  if (!automatic) {
    const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocodeUrl.searchParams.set("name", requestedLocation);
    geocodeUrl.searchParams.set("count", "1");
    geocodeUrl.searchParams.set("language", "en");
    geocodeUrl.searchParams.set("format", "json");
    const country = (url.searchParams.get("country") || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) geocodeUrl.searchParams.set("countryCode", country);

    const response = await fetch(geocodeUrl, { headers: { accept: "application/json" }, signal: upstreamSignal() });
    if (!response.ok) throw new Error("Location search failed");
    const data = await response.json();
    const result = data.results?.[0];
    if (!result) throw new Error("Location not found");
    const suffix = result.admin1 && result.admin1 !== result.name ? result.admin1 : result.country_code;
    return {
      latitude: result.latitude,
      longitude: result.longitude,
      label: cleanText(`${result.name}${suffix ? ` ${suffix}` : ""}`),
    };
  }

  const cfLatitude = validCoordinate(request.cf?.latitude, -90, 90);
  const cfLongitude = validCoordinate(request.cf?.longitude, -180, 180);
  if (cfLatitude !== null && cfLongitude !== null) {
    return {
      latitude: cfLatitude,
      longitude: cfLongitude,
      label: cleanText(request.cf?.city || request.cf?.region || request.cf?.country || "LOCAL WEATHER"),
    };
  }

  return { latitude: 51.5072, longitude: -0.1276, label: "LONDON" };
}

async function fetchWeather(place, imperial) {
  const apiUrl = new URL("https://api.open-meteo.com/v1/forecast");
  apiUrl.searchParams.set("latitude", String(place.latitude));
  apiUrl.searchParams.set("longitude", String(place.longitude));
  apiUrl.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
  );
  apiUrl.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"
  );
  apiUrl.searchParams.set("temperature_unit", imperial ? "fahrenheit" : "celsius");
  apiUrl.searchParams.set("wind_speed_unit", imperial ? "mph" : "kmh");
  apiUrl.searchParams.set("timezone", "auto");
  apiUrl.searchParams.set("forecast_days", "5");

  const response = await fetch(apiUrl, { headers: { accept: "application/json" }, signal: upstreamSignal() });
  if (!response.ok) throw new Error("Weather service failed");
  const data = await response.json();
  if (!data.current || !data.daily?.time?.length) throw new Error("Incomplete weather response");
  return data;
}

const SYNODIC_MONTH_MS = 29.530588853 * 86400000;
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14);

function moonState(now) {
  const cycles = (now.getTime() - NEW_MOON_EPOCH_MS) / SYNODIC_MONTH_MS;
  const phase = ((cycles % 1) + 1) % 1;
  const illumination = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  const names = [
    "NEW MOON",
    "WAXING CRESCENT",
    "FIRST QUARTER",
    "WAXING GIBBOUS",
    "FULL MOON",
    "WANING GIBBOUS",
    "LAST QUARTER",
    "WANING CRESCENT",
  ];
  return { phase, illumination, label: names[Math.round(phase * 8) % 8] };
}

function drawMoonDisk(canvas, cx, cy, radius, phase) {
  fillCircle(canvas, cx, cy, radius, true);
  const cosine = Math.cos(phase * Math.PI * 2);
  for (let y = -radius + 3; y <= radius - 3; y++) {
    const halfWidth = Math.floor(Math.sqrt((radius - 3) ** 2 - y * y));
    if (phase <= 0.5) {
      const start = Math.ceil(cosine * halfWidth);
      for (let x = start; x <= halfWidth; x++) setPixel(canvas, cx + x, cy + y, false);
    } else {
      const end = Math.floor(-cosine * halfWidth);
      for (let x = -halfWidth; x <= end; x++) setPixel(canvas, cx + x, cy + y, false);
    }
  }
  const innerRadiusSquared = (radius - 3) ** 2;
  const outerRadiusSquared = radius ** 2;
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const distanceSquared = x * x + y * y;
      if (distanceSquared >= innerRadiusSquared && distanceSquared <= outerRadiusSquared) {
        setPixel(canvas, cx + x, cy + y, true);
      }
    }
  }
}

function datePartsInZone(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return {
      date: `${parts.day} ${parts.month.toUpperCase()} ${parts.year}`,
      short: `${parts.day} ${parts.month.toUpperCase()} ${parts.hour}:${parts.minute}`,
      time: `${parts.hour}:${parts.minute}`,
    };
  } catch {
    return null;
  }
}

function approximateMoonPhases(now) {
  const phaseNames = ["NEW MOON", "FIRST QUARTER", "FULL MOON", "LAST QUARTER"];
  const cycle = (now.getTime() - NEW_MOON_EPOCH_MS) / SYNODIC_MONTH_MS;
  const currentCycle = Math.floor(cycle);
  const moments = [];
  for (let offset = 0; offset < 2; offset++) {
    for (let quarter = 0; quarter < 4; quarter++) {
      const time = NEW_MOON_EPOCH_MS + (currentCycle + offset + quarter / 4) * SYNODIC_MONTH_MS;
      if (time > now.getTime()) moments.push({ phase: phaseNames[quarter], date: new Date(time) });
    }
  }
  return moments.sort((a, b) => a.date - b.date).slice(0, 4);
}

async function fetchMoonPhases(now) {
  const date = now.toISOString().slice(0, 10);
  try {
    const response = await fetch(`https://aa.usno.navy.mil/api/moon/phases/date?date=${date}&nump=4`, {
      headers: { accept: "application/json", "user-agent": "CrossPointDashboard/1.0" },
      signal: upstreamSignal(),
    });
    if (!response.ok) throw new Error("Moon service failed");
    const data = await response.json();
    if (!Array.isArray(data.phasedata) || data.phasedata.length < 4) throw new Error("Incomplete moon response");
    const phases = data.phasedata.slice(0, 4).map((entry) => {
      const [hour, minute] = String(entry.time || "00:00").split(":").map(Number);
      return {
        phase: cleanText(entry.phase),
        date: new Date(Date.UTC(Number(entry.year), Number(entry.month) - 1, Number(entry.day), hour, minute)),
      };
    });
    return { phases, source: "PHASE DATA USNO" };
  } catch {
    return { phases: approximateMoonPhases(now), source: "PHASES APPROXIMATE" };
  }
}

function renderMoonBmp(now, timeZone, phaseData, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  const state = moonState(now);
  const local = datePartsInZone(now, timeZone);
  if (!local) return null;

  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, "MOON", compact ? 12 : 16, 6);
    drawTextCentered(canvas, local.date, compact ? 60 : 68, 3);
    fillRect(canvas, 20, compact ? 88 : 98, WIDTH - 40, 3);
    drawMoonDisk(canvas, 145, compact ? 202 : 218, compact ? 92 : 100, state.phase);
    drawTextCenteredInBox(canvas, state.label, 285, WIDTH - 305, compact ? 137 : 151, 5);
    drawTextCenteredInBox(
      canvas,
      `${Math.round(state.illumination * 100)}% ILLUMINATED`,
      285,
      WIDTH - 305,
      compact ? 198 : 216,
      3
    );
    drawTextCenteredInBox(canvas, shortLocationLabel(timeZone), 285, WIDTH - 305, compact ? 244 : 267, 2);

    const startY = compact ? 307 : 335;
    const gap = 10;
    const width = Math.floor((WIDTH - 36 - gap * 3) / 4);
    phaseData.phases.forEach((item, index) => {
      const x = 18 + index * (width + gap);
      drawRect(canvas, x, startY, width, compact ? 116 : 132, 2);
      drawTextCenteredInBox(canvas, item.phase, x, width, startY + 14, 2);
      const parts = datePartsInZone(item.date, timeZone);
      drawTextCenteredInBox(canvas, parts?.short || "--", x, width, startY + 55, 2);
    });
    drawTextCentered(canvas, phaseData.source, HEIGHT - 17, 1);
    return makeBmp(canvas);
  }

  drawTextCentered(canvas, "MOON", 24, 7);
  drawTextCentered(canvas, local.date, 86, 3);
  fillRect(canvas, 24, 120, WIDTH - 48, 3);
  drawMoonDisk(canvas, Math.floor(WIDTH / 2), 275, 112, state.phase);
  drawTextCentered(canvas, state.label, 412, 5, WIDTH - 24);
  drawTextCentered(canvas, `${Math.round(state.illumination * 100)}% ILLUMINATED`, 463, 3);
  drawTextCentered(canvas, "NEXT PHASES", 516, 3);
  phaseData.phases.forEach((item, index) => {
    const y = 555 + index * 42;
    drawText(canvas, item.phase, 28, y, 2);
    const parts = datePartsInZone(item.date, timeZone);
    const value = parts?.short || "--";
    drawText(canvas, value, WIDTH - 28 - textWidth(value, 2), y, 2);
    if (index < 3) fillRect(canvas, 28, y + 27, WIDTH - 56, 1);
  });
  drawTextCentered(canvas, phaseData.source, HEIGHT - 19, 1);
  return makeBmp(canvas);
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function renderListBmp(kind, title, items, footer, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);

  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, title, compact ? 10 : 14, 5, WIDTH - 30);
    drawTextCentered(canvas, kind, compact ? 53 : 58, 2);
    fillRect(canvas, 20, compact ? 79 : 86, WIDTH - 40, 3);
    const count = Math.min(items.length, 4);
    const columns = 2;
    const rows = Math.ceil(count / columns);
    const areaTop = compact ? 100 : 108;
    const areaBottom = HEIGHT - 38;
    const cellWidth = Math.floor((WIDTH - 50) / 2);
    const cellHeight = Math.floor((areaBottom - areaTop - 10) / rows);
    for (let index = 0; index < count; index++) {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = 20 + column * (cellWidth + 10);
      const y = areaTop + row * cellHeight;
      drawRect(canvas, x, y, cellWidth, cellHeight - 10, 2);
      const kicker = cleanText(items[index].kicker || String(index + 1));
      drawText(canvas, kicker, x + 13, y + 13, 3);
      drawWrappedText(canvas, items[index].text, x + 13, y + 53, 2, cellWidth - 26, compact ? 3 : 4, 22);
    }
    drawTextCentered(canvas, footer, HEIGHT - 17, 1);
    return makeBmp(canvas);
  }

  drawTextCentered(canvas, title, 24, 5, WIDTH - 30);
  drawTextCentered(canvas, kind, 75, 2);
  fillRect(canvas, 24, 108, WIDTH - 48, 3);
  const count = Math.min(items.length, 4);
  const areaTop = 126;
  const areaBottom = HEIGHT - 42;
  const cellHeight = Math.floor((areaBottom - areaTop) / count);
  for (let index = 0; index < count; index++) {
    const y = areaTop + index * cellHeight;
    const kicker = cleanText(items[index].kicker || String(index + 1));
    drawText(canvas, kicker, 24, y + 14, kicker.length > 3 ? 3 : 4);
    // Wide enough for the four-digit year kickers of the only caller.
    const textX = 112;
    drawWrappedText(canvas, items[index].text, textX, y + 12, 2, WIDTH - textX - 22, 3, 23);
    if (index < count - 1) fillRect(canvas, 24, y + cellHeight - 2, WIDTH - 48, 1);
  }
  drawTextCentered(canvas, footer, HEIGHT - 19, 1);
  return makeBmp(canvas);
}

async function fetchWikipediaToday(language, now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const month = parts.find((part) => part.type === "month")?.value || String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = parts.find((part) => part.type === "day")?.value || String(now.getUTCDate()).padStart(2, "0");
  const endpoint = `https://api.wikimedia.org/feed/v1/wikipedia/${language}/onthisday/events/${month}/${day}`;
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      "user-agent": "CrossPointDashboard/1.0 (https://github.com/petereading/crosspoint-cards)",
    },
    signal: upstreamSignal(),
  });
  if (!response.ok) throw new Error("Wikipedia Today service failed");
  const data = await response.json();
  const events = (data.events || [])
    .filter((event) => event?.text && Number.isFinite(Number(event.year)))
    .slice(0, 6)
    .map((event) => ({ kicker: String(event.year), text: event.text }));
  if (!events.length) throw new Error("No Wikipedia events found");
  return events;
}

function stripWikiMarkup(value) {
  let text = String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<ref\b[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
    .replace(/'{2,}/g, "");
  for (let pass = 0; pass < 3; pass++) text = text.replace(/\{\{[^{}]*\}\}/g, " ");
  // decodeXmlText collapses every run of whitespace, newlines included, which is
  // right for the prose cards that share it. Decode each verse line on its own
  // so the line structure survives.
  return text
    .split("\n")
    .map((line) => decodeXmlText(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchWikiquote(now, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const pageDate = formatter.format(now);
  const apiUrl = new URL("https://en.wikiquote.org/w/api.php");
  apiUrl.searchParams.set("action", "parse");
  apiUrl.searchParams.set("page", `Wikiquote:Quote of the day/${pageDate}`);
  apiUrl.searchParams.set("prop", "wikitext");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/json",
      "user-agent": "CrossPointDashboard/1.0 (https://github.com/petereading/crosspoint-cards)",
    },
    signal: upstreamSignal(),
  });
  if (!response.ok) throw new Error("Wikiquote service failed");
  const data = await response.json();
  const source = data.parse?.wikitext || "";
  const quoteMatch = source.match(/\|\s*quote\s*=\s*([\s\S]*?)\n\s*\|\s*author\s*=/i);
  const authorMatch = source.match(/\|\s*author\s*=\s*([^\n}]*)/i);
  const quote = stripWikiMarkup(quoteMatch?.[1] || "");
  const author = stripWikiMarkup(authorMatch?.[1] || "");
  if (!quote || !author) throw new Error("Quote of the day is unavailable");
  return { quote, author, date: pageDate.toUpperCase() };
}

function renderQuoteBmp(data, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, "QUOTE", compact ? 12 : 16, 6);
    drawTextCentered(canvas, data.date, compact ? 60 : 67, 2);
    fillRect(canvas, 20, compact ? 87 : 95, WIDTH - 40, 3);
    const top = compact ? 122 : 132;
    const span = (compact ? 375 : 414) - top;
    // Landscape has about two thirds of portrait's vertical room above the
    // author line, so a long verse flows as a paragraph rather than being
    // squeezed into an unreadable one.
    const verse = fitVerse(data.quote, WIDTH - 84, span, [
      [3, 31],
      [2, 23],
    ]);
    if (verse) {
      drawVerseCentered(canvas, verse.lines, 42, top + Math.floor((span - verse.height) / 2), verse.scale, WIDTH - 84,
                        verse.lineHeight);
    } else {
      const scale = cleanText(data.quote).length > 190 ? 2 : 3;
      const lineHeight = scale === 3 ? 31 : 23;
      drawWrappedTextCentered(canvas, data.quote, 42, top, scale, WIDTH - 84, compact ? 7 : 8, lineHeight);
    }
    drawTextCentered(canvas, data.author, compact ? 375 : 414, 4, WIDTH - 60);
    drawTextCentered(canvas, "WIKIQUOTE  CC BY-SA", HEIGHT - 18, 1);
    return makeBmp(canvas);
  }

  drawTextCentered(canvas, "QUOTE", 25, 7);
  drawTextCentered(canvas, data.date, 88, 2);
  fillRect(canvas, 24, 120, WIDTH - 48, 3);
  // The quote hangs from just under the rule rather than floating in the middle
  // of the space above the author: a short quote should leave its room at the
  // bottom, not as a gap under the rule.
  const top = 152;
  const span = 620 - top;
  const verse = fitVerse(data.quote, WIDTH - 60, span, [
    [4, 40],
    [3, 31],
    [2, 23],
  ]);
  if (verse) {
    drawVerseCentered(canvas, verse.lines, 30, top, verse.scale, WIDTH - 60, verse.lineHeight);
  } else {
    const scale = cleanText(data.quote).length > 150 ? 3 : 4;
    const lineHeight = scale === 4 ? 40 : 31;
    drawWrappedTextCentered(canvas, data.quote, 30, top, scale, WIDTH - 60, 10, lineHeight);
  }
  fillRect(canvas, 80, 620, WIDTH - 160, 2);
  drawTextCentered(canvas, data.author, 653, 4, WIDTH - 40);
  drawTextCentered(canvas, "WIKIQUOTE  CC BY-SA", HEIGHT - 19, 1);
  return makeBmp(canvas);
}

async function fetchBitcoin() {
  const product = "BTC-USD";
  const headers = { accept: "application/json", "user-agent": "CrossPointDashboard/1.0" };
  const [tickerResponse, candlesResponse] = await Promise.all([
    fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, { headers, signal: upstreamSignal() }),
    fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`, {
      headers,
      signal: upstreamSignal(),
    }),
  ]);
  if (!tickerResponse.ok || !candlesResponse.ok) throw new Error("Bitcoin price service failed");
  const ticker = await tickerResponse.json();
  const rawCandles = await candlesResponse.json();
  const price = Number(ticker.price);
  const candles = (Array.isArray(rawCandles) ? rawCandles : [])
    .filter((row) => Array.isArray(row) && row.length >= 5 && Number.isFinite(Number(row[4])))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .slice(-8);
  if (!Number.isFinite(price) || candles.length < 2) throw new Error("Incomplete Bitcoin price response");
  const previousClose = Number(candles[candles.length - 2][4]);
  const change = ((price - previousClose) / previousClose) * 100;
  const prices = candles.slice(-7).map((row) => Number(row[4]));
  prices[prices.length - 1] = price;
  return {
    price,
    change,
    prices,
    high: Math.max(...prices),
    low: Math.min(...prices),
    updated: new Date(ticker.time || Date.now()),
  };
}

function formatWholePrice(value) {
  return Math.round(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function drawPriceChart(canvas, prices, x, y, width, height) {
  drawRect(canvas, x, y, width, height, 2);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const range = Math.max(1, maximum - minimum);
  const left = x + 12;
  const right = x + width - 12;
  const top = y + 12;
  const bottom = y + height - 12;
  for (let index = 1; index < prices.length; index++) {
    const x0 = left + ((index - 1) * (right - left)) / (prices.length - 1);
    const x1 = left + (index * (right - left)) / (prices.length - 1);
    const y0 = bottom - ((prices[index - 1] - minimum) / range) * (bottom - top);
    const y1 = bottom - ((prices[index] - minimum) / range) * (bottom - top);
    drawLine(canvas, x0, y0, x1, y1, 3);
    fillCircle(canvas, Math.round(x1), Math.round(y1), 4);
  }
  fillCircle(canvas, left, bottom - ((prices[0] - minimum) / range) * (bottom - top), 4);
}

function renderBitcoinBmp(data, timeZone, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  const local = datePartsInZone(data.updated, timeZone);
  const direction = data.change >= 0 ? "+" : "";
  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, "BITCOIN", compact ? 10 : 14, 6);
    drawTextCentered(canvas, "BTC / USD", compact ? 57 : 64, 2);
    fillRect(canvas, 20, compact ? 83 : 91, WIDTH - 40, 3);
    drawTextCenteredInBox(canvas, `USD ${formatWholePrice(data.price)}`, 20, 300, compact ? 132 : 146, 7);
    drawTextCenteredInBox(canvas, `${direction}${data.change.toFixed(1)}% 24H`, 20, 300, compact ? 211 : 231, 4);
    drawTextCenteredInBox(canvas, `HIGH ${formatWholePrice(data.high)}`, 20, 300, compact ? 276 : 303, 2);
    drawTextCenteredInBox(canvas, `LOW ${formatWholePrice(data.low)}`, 20, 300, compact ? 306 : 335, 2);
    drawTextCenteredInBox(canvas, "7 DAY PRICE", 326, WIDTH - 346, compact ? 103 : 112, 3);
    drawPriceChart(canvas, data.prices, 326, compact ? 139 : 151, WIDTH - 346, compact ? 249 : 278);
    drawTextCentered(canvas, `UPDATED ${local?.time || "--:--"}  DATA COINBASE`, HEIGHT - 18, 1);
    return makeBmp(canvas);
  }

  drawTextCentered(canvas, "BITCOIN", 24, 7);
  drawTextCentered(canvas, "BTC / USD", 88, 3);
  fillRect(canvas, 24, 124, WIDTH - 48, 3);
  drawTextCentered(canvas, `USD ${formatWholePrice(data.price)}`, 166, 8, WIDTH - 30);
  drawTextCentered(canvas, `${direction}${data.change.toFixed(1)}% 24H`, 247, 4);
  drawTextCentered(canvas, "7 DAY PRICE", 306, 3);
  drawPriceChart(canvas, data.prices, 30, 348, WIDTH - 60, 240);
  drawTextCentered(canvas, `HIGH ${formatWholePrice(data.high)}   LOW ${formatWholePrice(data.low)}`, 620, 2);
  drawTextCentered(canvas, `UPDATED ${local?.time || "--:--"}  DATA COINBASE`, HEIGHT - 19, 1);
  return makeBmp(canvas);
}

const PLANET_ELEMENTS = [
  ["ME", 0.38709843, 0.00000000, 0.20563661, 0.00002123, 7.00559432, -0.00590158, 252.25166724, 149472.67486623, 77.45771895, 0.15940013, 48.33961819, -0.12214182, 0, 0, 0, 0],
  ["VE", 0.72332102, -0.00000026, 0.00676399, -0.00005107, 3.39777545, 0.00043494, 181.97970850, 58517.81560260, 131.76755713, 0.05679648, 76.67261496, -0.27274174, 0, 0, 0, 0],
  ["EA", 1.00000018, -0.00000003, 0.01673163, -0.00003661, -0.00054346, -0.01337178, 100.46691572, 35999.37306329, 102.93005885, 0.31795260, -5.11260389, -0.24123856, 0, 0, 0, 0],
  ["MA", 1.52371243, 0.00000097, 0.09336511, 0.00009149, 1.85181869, -0.00724757, -4.56813164, 19140.29934243, -23.91744784, 0.45223625, 49.71320984, -0.26852431, 0, 0, 0, 0],
  ["JU", 5.20248019, -0.00002864, 0.04853590, 0.00018026, 1.29861416, -0.00322699, 34.33479152, 3034.90371757, 14.27495244, 0.18199196, 100.29282654, 0.13024619, -0.00012452, 0.06064060, -0.35635438, 38.35125],
  ["SA", 9.54149883, -0.00003065, 0.05550825, -0.00032044, 2.49424102, 0.00451969, 50.07571329, 1222.11494724, 92.86136063, 0.54179478, 113.63998702, -0.25015002, 0.00025899, -0.13434469, 0.87320147, 38.35125],
  ["UR", 19.18797948, -0.00020455, 0.04685740, -0.00001550, 0.77298127, -0.00180155, 314.20276625, 428.49512595, 172.43404441, 0.09266985, 73.96250215, 0.05739699, 0.00058331, -0.97731848, 0.17689245, 7.67025],
  ["NE", 30.06952752, 0.00006447, 0.00895439, 0.00000818, 1.77005520, 0.00022400, 304.22289287, 218.46515314, 46.68158724, 0.01009938, 131.78635853, -0.00606302, -0.00041348, 0.68346318, -0.10162547, 7.67025],
  // Pluto is not a planet for the solar card's purposes but a chart is expected
  // to carry it. Same JPL approximate-element set, valid 1800-2050.
  ["PL", 39.48686035, 0.00449751, 0.24885238, 0.00006016, 17.14104260, 0.00000501, 238.96535011, 145.18042903, 224.09702598, -0.00968827, 110.30167986, -0.00809981, -0.01262724, 0, 0, 0],
];

function planetPositions(now) {
  const centuries = (2440587.5 + now.getTime() / 86400000 - 2451545.0) / 36525;
  const radians = Math.PI / 180;
  return PLANET_ELEMENTS.map((entry) => {
    const [name, a0, aRate, e0, eRate, i0, iRate, l0, lRate, p0, pRate, node0, nodeRate, b, c, s, f] = entry;
    const a = a0 + aRate * centuries;
    const e = e0 + eRate * centuries;
    const inclination = (i0 + iRate * centuries) * radians;
    const longitude = l0 + lRate * centuries;
    const perihelion = p0 + pRate * centuries;
    const node = (node0 + nodeRate * centuries) * radians;
    let meanAnomaly = longitude - perihelion + b * centuries * centuries;
    meanAnomaly += c * Math.cos(f * centuries * radians) + s * Math.sin(f * centuries * radians);
    meanAnomaly = ((((meanAnomaly + 180) % 360) + 360) % 360 - 180) * radians;
    let eccentricAnomaly = meanAnomaly;
    for (let iteration = 0; iteration < 8; iteration++) {
      eccentricAnomaly -=
        (eccentricAnomaly - e * Math.sin(eccentricAnomaly) - meanAnomaly) / (1 - e * Math.cos(eccentricAnomaly));
    }
    const orbitalX = a * (Math.cos(eccentricAnomaly) - e);
    const orbitalY = a * Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly);
    const omega = perihelion * radians - node;
    const x =
      (Math.cos(omega) * Math.cos(node) - Math.sin(omega) * Math.sin(node) * Math.cos(inclination)) * orbitalX +
      (-Math.sin(omega) * Math.cos(node) - Math.cos(omega) * Math.sin(node) * Math.cos(inclination)) * orbitalY;
    const y =
      (Math.cos(omega) * Math.sin(node) + Math.sin(omega) * Math.cos(node) * Math.cos(inclination)) * orbitalX +
      (-Math.sin(omega) * Math.sin(node) + Math.cos(omega) * Math.cos(node) * Math.cos(inclination)) * orbitalY;
    return { name, a, x, y, distance: Math.sqrt(x * x + y * y) };
  });
}

function drawCircleOutline(canvas, cx, cy, radius) {
  for (let offset = -radius; offset <= radius; offset++) {
    const edge = Math.round(Math.sqrt(Math.max(0, radius * radius - offset * offset)));
    setPixel(canvas, cx + edge, cy + offset);
    setPixel(canvas, cx - edge, cy + offset);
    setPixel(canvas, cx + offset, cy + edge);
    setPixel(canvas, cx + offset, cy - edge);
  }
}

function drawSolarChart(canvas, planets, cx, cy, radius) {
  // Scale to whatever is actually outermost, orbit and current distance alike,
  // so the chart fills the radius the caller reserved and never exceeds it.
  // A constant tuned for Neptune put Pluto's orbit a seventh of the way past
  // it, across the rule above the chart and the caption below.
  const outermost = planets.reduce((furthest, planet) => Math.max(furthest, planet.a, planet.distance), 1);
  for (const planet of planets) {
    drawCircleOutline(canvas, cx, cy, Math.max(8, Math.round(radius * Math.sqrt(planet.a / outermost))));
  }
  fillCircle(canvas, cx, cy, 8);
  for (const planet of planets) {
    const angle = Math.atan2(planet.y, planet.x);
    const distance = radius * Math.sqrt(planet.distance / outermost);
    const x = Math.round(cx + Math.cos(angle) * distance);
    const y = Math.round(cy - Math.sin(angle) * distance);
    fillCircle(canvas, x, y, planet.name === "EA" ? 6 : 4);
    const labelX = Math.max(2, Math.min(WIDTH - textWidth(planet.name, 1) - 2, x + 7));
    drawText(canvas, planet.name, labelX, y - 4, 1);
  }
}

function renderSolarBmp(now, timeZone, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  const local = datePartsInZone(now, timeZone);
  const planets = planetPositions(now);
  if (orientation === "landscape") {
    const compact = HEIGHT < 500;
    drawTextCentered(canvas, "SOLAR SYSTEM", compact ? 9 : 13, 6);
    drawTextCentered(canvas, local?.date || "", compact ? 56 : 63, 2);
    fillRect(canvas, 20, compact ? 82 : 90, WIDTH - 40, 3);
    drawSolarChart(canvas, planets, 255, compact ? 266 : 288, compact ? 166 : 188);
    drawTextCenteredInBox(canvas, "HELIOCENTRIC", 500, WIDTH - 520, compact ? 132 : 146, 4);
    drawTextCenteredInBox(canvas, "ME MERCURY", 500, WIDTH - 520, compact ? 198 : 218, 2);
    drawTextCenteredInBox(canvas, "VE VENUS", 500, WIDTH - 520, compact ? 228 : 251, 2);
    drawTextCenteredInBox(canvas, "EA EARTH", 500, WIDTH - 520, compact ? 258 : 284, 2);
    drawTextCenteredInBox(canvas, "MA MARS", 500, WIDTH - 520, compact ? 288 : 317, 2);
    drawTextCenteredInBox(canvas, "JU SA UR NE", 500, WIDTH - 520, compact ? 330 : 359, 2);
    drawTextCentered(canvas, "POSITIONS JPL APPROXIMATION", HEIGHT - 18, 1);
    return makeBmp(canvas);
  }

  drawTextCentered(canvas, "SOLAR SYSTEM", 24, 6);
  drawTextCentered(canvas, local?.date || "", 82, 2);
  fillRect(canvas, 24, 115, WIDTH - 48, 3);
  drawSolarChart(canvas, planets, Math.floor(WIDTH / 2), 350, 210);
  drawTextCentered(canvas, "HELIOCENTRIC PLANET POSITIONS", 590, 3, WIDTH - 24);
  drawTextCentered(canvas, "ME MERCURY  VE VENUS  EA EARTH  MA MARS", 640, 1);
  drawTextCentered(canvas, "JU JUPITER  SA SATURN  UR URANUS  NE NEPTUNE", 664, 1);
  drawTextCentered(canvas, "POSITIONS JPL APPROXIMATION", HEIGHT - 19, 1);
  return makeBmp(canvas);
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function bmpResponse(request, bmp, filename) {
  return new Response(request.method === "HEAD" ? null : bmp, {
    headers: {
      "content-type": "image/bmp",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "cloudflare-cdn-cache-control": "no-store",
      pragma: "no-cache",
      expires: "0",
    },
  });
}

// ---------------------------------------------------------------------------
// Astro chart. Everything here is computed from first principles: the planets
// reuse the JPL Keplerian elements the solar card already carries, the Moon
// uses a truncated ELP series, and the houses come from local sidereal time.
// No upstream service is involved, which is deliberate -- a chart that depends
// on someone else's API is a card that fails when their API does.
// ---------------------------------------------------------------------------

const ZODIAC = ["AR", "TA", "GE", "CN", "LE", "VI", "LI", "SC", "SG", "CP", "AQ", "PI"];
const DEG = Math.PI / 180;

function norm360(d) {
  return ((d % 360) + 360) % 360;
}

function julianCenturies(date) {
  return (2440587.5 + date.getTime() / 86400000 - 2451545.0) / 36525;
}

function obliquity(T) {
  return 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T;
}

// Meeus, Astronomical Algorithms ch. 47, main longitude terms. Truncated to the
// terms above ~0.001 degrees, which is far finer than a chart can show.
const MOON_TERMS = [
  [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314], [0, 0, 2, 0, 213618],
  [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332], [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066],
  [2, 0, 1, 0, 53322], [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383], [2, 0, 0, -2, 15327], [0, 0, 1, 2, -12528], [0, 0, 1, -2, 10980],
  [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034], [4, 0, -2, 0, 8548], [2, 1, -1, 0, -7888],
  [2, 1, 0, 0, -6766], [1, 0, -1, 0, -5163], [1, 1, 0, 0, 4987], [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994], [4, 0, 0, 0, 3861], [2, 0, -3, 0, 3665],
];

function moonLongitude(T) {
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + (T * T * T) / 538841;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + (T * T * T) / 545868;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + (T * T * T) / 69699;
  const F = 93.272095 + 483202.0175233 * T - 0.0036539 * T * T;
  // Terms involving the Sun's anomaly shrink as Earth's eccentricity does.
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  let sum = 0;
  for (const [cd, cm, cmp, cf, coeff] of MOON_TERMS) {
    const arg = (cd * D + cm * M + cmp * Mp + cf * F) * DEG;
    const scale = cm === 0 ? 1 : Math.abs(cm) === 1 ? E : E * E;
    sum += coeff * scale * Math.sin(arg);
  }
  return norm360(Lp + sum / 1000000);
}

// Geocentric ecliptic longitude of each body. Longitude needs only the x and y
// of the difference vector, so the ecliptic-plane coordinates planetPositions()
// already returns are sufficient; the dropped z affects latitude alone.
function chartBodies(now) {
  const T = julianCenturies(now);
  const planets = planetPositions(now);
  const earth = planets.find((p) => p.name === "EA");
  // The JPL elements are referred to the J2000 equinox, but a tropical chart is
  // measured from the equinox of date, so the planets need general precession
  // added: about 0.36 degrees by 2026, which is a third of a zodiac degree and
  // plainly visible on a chart. The Moon series above already gives longitude
  // of date, so it must not be corrected again.
  const precession = (5029.0966 * T + 1.11113 * T * T) / 3600;
  const bodies = [
    { name: "SU", longitude: norm360((Math.atan2(-earth.y, -earth.x) * 180) / Math.PI + precession) },
    { name: "MO", longitude: moonLongitude(T) },
  ];
  for (const p of planets) {
    if (p.name === "EA") continue;
    bodies.push({
      name: p.name,
      longitude: norm360((Math.atan2(p.y - earth.y, p.x - earth.x) * 180) / Math.PI + precession),
    });
  }
  return bodies;
}

function localSiderealTime(now, longitudeEast) {
  const jd = 2440587.5 + now.getTime() / 86400000;
  const T = (jd - 2451545.0) / 36525;
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T;
  return norm360(gmst + longitudeEast);
}

function eclipticFromRightAscension(ra, eps) {
  return norm360((Math.atan2(Math.sin(ra * DEG), Math.cos(ra * DEG) * Math.cos(eps * DEG)) * 180) / Math.PI);
}

function ascendantLongitude(ramc, eps, lat) {
  const asc =
    (Math.atan2(
      Math.cos(ramc * DEG),
      -(Math.sin(ramc * DEG) * Math.cos(eps * DEG) + Math.tan(lat * DEG) * Math.sin(eps * DEG))
    ) *
      180) /
    Math.PI;
  return norm360(asc);
}

// Placidus divides each body's diurnal semi-arc into three. The cusp longitude
// appears on both sides of the equation, so it is solved by iteration. Above
// the polar circle the semi-arc does not exist and the system is genuinely
// undefined -- return null rather than a plausible-looking wrong number.
function placidusCusp(ramc, eps, lat, offset, fraction) {
  let lon = eclipticFromRightAscension(ramc + offset, eps);
  for (let i = 0; i < 40; i++) {
    const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lon * DEG));
    const t = Math.tan(lat * DEG) * Math.tan(decl);
    if (Math.abs(t) >= 1) return null;
    const ad = (Math.asin(t) * 180) / Math.PI;
    const ra = offset < 180 ? ramc + offset + fraction * ad : ramc + offset - fraction * ad;
    const next = eclipticFromRightAscension(ra, eps);
    if (Math.abs(next - lon) < 1e-9) return next;
    lon = next;
  }
  return lon;
}

function houseCusps(system, ramc, eps, lat, asc, mc) {
  const cusps = new Array(12);
  if (system === "whole") {
    const start = Math.floor(asc / 30) * 30;
    for (let i = 0; i < 12; i++) cusps[i] = norm360(start + i * 30);
    return { cusps, system: "WHOLE SIGN" };
  }
  if (system === "equal") {
    for (let i = 0; i < 12; i++) cusps[i] = norm360(asc + i * 30);
    return { cusps, system: "EQUAL" };
  }

  const c11 = placidusCusp(ramc, eps, lat, 30, 1 / 3);
  const c12 = placidusCusp(ramc, eps, lat, 60, 2 / 3);
  const c2 = placidusCusp(ramc, eps, lat, 120, 2 / 3);
  const c3 = placidusCusp(ramc, eps, lat, 150, 1 / 3);
  if (c11 === null || c12 === null || c2 === null || c3 === null) {
    // Inside the polar circle: fall back rather than fail the whole card.
    for (let i = 0; i < 12; i++) cusps[i] = norm360(asc + i * 30);
    return { cusps, system: "EQUAL (PLACIDUS UNDEFINED HERE)" };
  }
  cusps[0] = asc;
  cusps[1] = c2;
  cusps[2] = c3;
  cusps[3] = norm360(mc + 180);
  cusps[4] = norm360(c11 + 180);
  cusps[5] = norm360(c12 + 180);
  cusps[6] = norm360(asc + 180);
  cusps[7] = norm360(c2 + 180);
  cusps[8] = norm360(c3 + 180);
  cusps[9] = mc;
  cusps[10] = c11;
  cusps[11] = c12;
  return { cusps, system: "PLACIDUS" };
}

function houseOf(longitude, cusps) {
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    const span = norm360(end - start);
    if (norm360(longitude - start) < span) return i + 1;
  }
  return 1;
}

const ASPECTS = [
  ["CON", 0], ["SEX", 60], ["SQR", 90], ["TRI", 120], ["OPP", 180],
];

function chartAspects(bodies, orb) {
  const found = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      let sep = norm360(bodies[i].longitude - bodies[j].longitude);
      if (sep > 180) sep = 360 - sep;
      for (const [name, angle] of ASPECTS) {
        const delta = Math.abs(sep - angle);
        if (delta <= orb) {
          found.push({ a: i, b: j, name, delta });
          break;
        }
      }
    }
  }
  return found;
}

function formatPosition(longitude) {
  const sign = Math.floor(norm360(longitude) / 30);
  const within = norm360(longitude) - sign * 30;
  const degrees = Math.floor(within);
  const minutes = Math.floor((within - degrees) * 60);
  return `${String(degrees).padStart(2, "0")}${ZODIAC[sign]}${String(minutes).padStart(2, "0")}`;
}

function renderAstroBmp(chart, orientation, device) {
  setCanvasDimensions(device, orientation);
  const canvas = new Uint8Array(PIXEL_ROW_BYTES * HEIGHT);
  const landscape = orientation === "landscape";

  const cx = landscape ? Math.floor(HEIGHT / 2) + 10 : Math.floor(WIDTH / 2);
  const cy = landscape ? Math.floor(HEIGHT / 2) + 20 : 372;
  const outer = landscape ? Math.floor(HEIGHT / 2) - 40 : 232;
  const signInner = Math.round(outer * 0.84);
  const houseInner = Math.round(outer * 0.62);
  const bodyRadius = Math.round(outer * 0.73);

  drawTextCentered(canvas, "ASTRO CHART", landscape ? 10 : 20, landscape ? 3 : 4);
  drawTextCentered(canvas, chart.label, landscape ? 44 : 62, landscape ? 3 : 4);
  drawTextCentered(canvas, chart.stamp, landscape ? 72 : 92, 2);

  // Ascendant on the left with longitude increasing counter-clockwise, which
  // puts the IC at the bottom and the MC at the top -- the conventional
  // layout. Screen y grows downwards, hence the subtraction in py().
  const screenAngle = (longitude) => (180 + norm360(longitude - chart.asc)) * DEG;
  const px = (longitude, r) => Math.round(cx + r * Math.cos(screenAngle(longitude)));
  const py = (longitude, r) => Math.round(cy - r * Math.sin(screenAngle(longitude)));

  drawCircleOutline(canvas, cx, cy, outer);
  drawCircleOutline(canvas, cx, cy, signInner);
  drawCircleOutline(canvas, cx, cy, houseInner);

  // Sign ring: 12 spokes on the 30 degree boundaries, each segment labelled.
  for (let s = 0; s < 12; s++) {
    const boundary = s * 30;
    drawLine(canvas, px(boundary, signInner), py(boundary, signInner), px(boundary, outer), py(boundary, outer));
    const mid = boundary + 15;
    const r = Math.round((signInner + outer) / 2);
    drawText(canvas, ZODIAC[s], px(mid, r) - 5, py(mid, r) - 3, 2);
  }

  // House cusps, numbered just inside the ring.
  for (let h = 0; h < 12; h++) {
    const cusp = chart.cusps[h];
    const thickness = h === 0 || h === 9 ? 2 : 1;
    drawLine(canvas, px(cusp, houseInner), py(cusp, houseInner), px(cusp, signInner), py(cusp, signInner), thickness);
    const mid = cusp + norm360(chart.cusps[(h + 1) % 12] - cusp) / 2;
    const r = houseInner + 12;
    drawText(canvas, String(h + 1), px(mid, r) - 3, py(mid, r) - 3, 1);
  }

  // Angles.
  drawText(canvas, "ASC", px(chart.asc, outer - 12) - 2, py(chart.asc, outer - 12) - 3, 1);
  drawText(canvas, "MC", px(chart.mc, outer - 12) - 6, py(chart.mc, outer - 12) - 2, 1);

  // Aspect lines inside the inner circle.
  for (const aspect of chart.aspects) {
    const a = chart.bodies[aspect.a].longitude;
    const b = chart.bodies[aspect.b].longitude;
    drawLine(canvas, px(a, houseInner), py(a, houseInner), px(b, houseInner), py(b, houseInner));
  }

  // Bodies. Two planets a few degrees apart would otherwise be drawn on the
  // same pixels, so step each crowded one further in than the last.
  const ordered = [...chart.bodies].sort((a, b) => a.longitude - b.longitude);
  let previous = null;
  let ring = 0;
  for (const body of ordered) {
    if (previous !== null && norm360(body.longitude - previous) < 13) {
      ring = (ring + 1) % 3;
    } else {
      ring = 0;
    }
    previous = body.longitude;
    const r = bodyRadius - ring * 24;
    const x = px(body.longitude, r);
    const y = py(body.longitude, r);
    fillRect(canvas, x - 10, y - 6, 20, 12, false);
    drawText(canvas, body.name, x - 9, y - 5, 2);
  }

  // Positions table.
  const rows = chart.bodies.map((b) => `${b.name} ${formatPosition(b.longitude)} H${chart.houses[b.name]}`);
  if (landscape) {
    let y = 100;
    for (const row of rows) {
      drawText(canvas, row, WIDTH - 150, y, 2);
      y += 26;
    }
    drawText(canvas, chart.system, WIDTH - 150, y + 8, 1);
  } else {
    const top = cy + outer + 20;
    for (let i = 0; i < rows.length; i++) {
      const column = i % 2;
      const row = Math.floor(i / 2);
      drawText(canvas, rows[i], 40 + column * 250, top + row * 26, 2);
    }
    drawTextCentered(canvas, `${chart.system}  ORB ${chart.orb} DEG`, HEIGHT - 24, 1);
  }
  return makeBmp(canvas);
}

// Wall-clock time in an arbitrary zone, without a date library: format the
// guess in that zone, see how far off it lands, and correct. Two passes settle
// it either side of a DST boundary.
function zoneOffsetMs(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

function instantFromLocal(y, mo, d, h, mi, timeZone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let ms = naive;
  for (let i = 0; i < 2; i++) ms = naive - zoneOffsetMs(ms, timeZone);
  return new Date(ms);
}

function buildChart(url, place) {
  const timeZone = place.timeZone;
  let when = new Date();
  const dateArg = url.searchParams.get("date");
  const timeArg = url.searchParams.get("time");
  if (dateArg) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateArg.trim());
    if (!dm) return { error: "date must be YYYY-MM-DD" };
    const tm = /^(\d{1,2}):(\d{2})$/.exec((timeArg || "12:00").trim());
    if (!tm) return { error: "time must be HH:MM" };
    when = instantFromLocal(+dm[1], +dm[2], +dm[3], +tm[1], +tm[2], timeZone);
    if (Number.isNaN(when.getTime())) return { error: "Invalid date or time" };
  }

  const system = (url.searchParams.get("houses") || "placidus").trim().toLowerCase();
  if (!["placidus", "whole", "equal"].includes(system)) {
    return { error: "houses must be placidus, whole, or equal" };
  }
  const orb = Math.min(12, Math.max(1, Math.floor(Number(url.searchParams.get("orb") || 6)) || 6));

  const T = julianCenturies(when);
  const eps = obliquity(T);
  const ramc = localSiderealTime(when, place.lon);
  const mc = eclipticFromRightAscension(ramc, eps);
  const asc = ascendantLongitude(ramc, eps, place.lat);
  const { cusps, system: systemLabel } = houseCusps(system, ramc, eps, place.lat, asc, mc);

  const bodies = chartBodies(when);
  const houses = {};
  for (const b of bodies) houses[b.name] = houseOf(b.longitude, cusps);

  const local = datePartsInZone(when, timeZone);
  return {
    label: place.label,
    stamp: local ? `${local.date || ""} ${local.time}`.trim() : when.toISOString().slice(0, 16).replace("T", " "),
    asc, mc, cusps, bodies, houses, orb,
    system: systemLabel,
    aspects: chartAspects(bodies, orb),
  };
}

// The chart needs a position, not just a zone. A code brings its own; explicit
// lat/lon overrides it, so anywhere can be charted without adding a code.
function resolveChartPlace(url, request) {
  const latArg = url.searchParams.get("lat");
  const lonArg = url.searchParams.get("lon");
  if (latArg !== null || lonArg !== null) {
    const lat = Number(latArg);
    const lon = Number(lonArg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const timeZone = url.searchParams.get("tz")?.trim() || request.cf?.timezone || "UTC";
    const label = cleanText(url.searchParams.get("label") || "") || shortLocationLabel(timeZone);
    return { timeZone, label, lat, lon };
  }
  const requested = url.searchParams.get("location")?.trim();
  if (!requested || requested.toLowerCase() === "auto") {
    const lat = Number(request.cf?.latitude);
    const lon = Number(request.cf?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const timeZone = request.cf?.timezone || "UTC";
    return { timeZone, label: cleanText(request.cf?.city || shortLocationLabel(timeZone)), lat, lon };
  }
  const known = CLOCK_LOCATIONS[requested.toUpperCase()];
  if (!known) return null;
  return { timeZone: known[0], label: known[1], lat: known[2], lon: known[3] };
}


export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return textResponse(
        "CrossPoint Dashboard Worker\n\n" +
          "Clock:\n/clock.bmp\n/clock.bmp?location=HKG\n/clock.bmp?location=NYC\n" +
          "/clock.bmp?tz=Australia/Sydney&device=x4&orientation=landscape\n" +
          "Location codes: /locations.txt (a full IANA zone also works)\n\n" +
          "Clock, corrected for fetch time:\n" +
          "/clock.bmp?location=LON&lead=90        render 90 s ahead\n" +
          "/clock.bmp?location=LON&round=5        snap to the nearest 5 min\n" +
          "/clock.bmp?location=LON&lead=90&round=5\n\n" +
          "Weather, automatic location:\n/weather.bmp\n/weather.bmp?location=auto\n\n" +
          "Weather, place name:\n/weather.bmp?location=London,GB\n" +
          "/weather.bmp?location=Sydney,AU&orientation=landscape\n\n" +
          "Weather, exact coordinates:\n/weather.bmp?lat=51.5072&lon=-0.1276&label=London\n\n" +
          "Weather, imperial units:\n/weather.bmp?location=New York,US&units=imperial\n\n" +
          "Moon phases:\n/moon.bmp\n/moon.bmp?tz=Australia/Sydney&orientation=landscape\n\n" +
          "Wikipedia Today:\n/today.bmp\n/today.bmp?lang=en&orientation=landscape\n\n" +
          "Quote of the day:\n/quote.bmp\n/quote.bmp?tz=Europe/London\n\n" +
          "Bitcoin price and seven-day chart, in USD:\n/bitcoin.bmp\n\n" +
          "Heliocentric solar system:\n/solar.bmp\n/solar.bmp?orientation=landscape\n\n" +
          "Astro chart, now:\n/astro.bmp?location=HKG\n/astro.bmp?lat=22.32&lon=114.17&tz=Asia/Hong_Kong\n" +
          "  houses=placidus (default) | whole | equal\n" +
          "  orb=6 (1-12, aspect orb in degrees)\n" +
          "Astro chart, a given moment:\n/astro.bmp?location=LON&date=1985-07-13&time=14:20\n\n" +
          "Device defaults to X3. Use device=x3 or device=x4.\n" +
          "Orientation defaults to portrait. Use orientation=portrait or orientation=landscape.\n"
      );
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const orientation = resolveOrientation(url);
    if (!orientation) return textResponse("orientation must be portrait or landscape", 400);
    const device = resolveDevice(url);
    if (!device) return textResponse("device must be x3 or x4", 400);

    if (url.pathname === "/locations.txt") {
      return textResponse("Clock location codes for /clock.bmp?location=CODE\n\n" + locationsListing() + "\n");
    }

    if (url.pathname === "/clock.bmp") {
      const place = resolveClockLocation(url, request);
      if (!place) return textResponse("Unknown location. See /locations.txt, or pass a full IANA zone.", 400);
      const bmp = renderClockBmp(place.timeZone, orientation, device, place.label, clockInstant(url));
      if (!bmp) return textResponse("Invalid IANA time zone. Example: Europe/London", 400);
      return bmpResponse(request, bmp, "clock.bmp");
    }

    if (url.pathname === "/moon.bmp") {
      const timeZone = resolveClockTimeZone(url, request);
      if (!getClockParts(new Date(), timeZone)) {
        return textResponse("Invalid IANA time zone. Example: Europe/London", 400);
      }
      const now = new Date();
      const phaseData = await fetchMoonPhases(now);
      const bmp = renderMoonBmp(now, timeZone, phaseData, orientation, device);
      return bmpResponse(request, bmp, "moon.bmp");
    }

    if (url.pathname === "/today.bmp") {
      const language = (url.searchParams.get("lang") || "en").trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,11}$/.test(language)) return textResponse("lang must be a Wikipedia language code", 400);
      const timeZone = resolveClockTimeZone(url, request);
      const now = new Date();
      const local = datePartsInZone(now, timeZone);
      if (!local) return textResponse("Invalid IANA time zone. Example: Europe/London", 400);
      try {
        const events = await fetchWikipediaToday(language, now, timeZone);
        const title = local.date.replace(/ \d{4}$/, "");
        const bmp = renderListBmp(
          "TODAY IN HISTORY",
          title,
          events,
          `DATA WIKIPEDIA ${language.toUpperCase()}  CC BY-SA`,
          orientation,
          device
        );
        return bmpResponse(request, bmp, "today.bmp");
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Wikipedia Today generation failed", 502);
      }
    }

    if (url.pathname === "/quote.bmp") {
      const timeZone = resolveClockTimeZone(url, request);
      if (!datePartsInZone(new Date(), timeZone)) {
        return textResponse("Invalid IANA time zone. Example: Europe/London", 400);
      }
      try {
        const data = await fetchWikiquote(new Date(), timeZone);
        return bmpResponse(request, renderQuoteBmp(data, orientation, device), "quote.bmp");
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Quote generation failed", 502);
      }
    }

    if (url.pathname === "/bitcoin.bmp") {
      const timeZone = resolveClockTimeZone(url, request);
      if (!datePartsInZone(new Date(), timeZone)) {
        return textResponse("Invalid IANA time zone. Example: Europe/London", 400);
      }
      try {
        const data = await fetchBitcoin();
        return bmpResponse(request, renderBitcoinBmp(data, timeZone, orientation, device), "bitcoin.bmp");
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : "Bitcoin generation failed", 502);
      }
    }

    if (url.pathname === "/astro.bmp") {
      const place = resolveChartPlace(url, request);
      if (!place) {
        return textResponse("Pass ?location=CODE (see /locations.txt) or ?lat=..&lon=..&tz=..", 400);
      }
      const chart = buildChart(url, place);
      if (chart.error) return textResponse(chart.error, 400);
      return bmpResponse(request, renderAstroBmp(chart, orientation, device), "astro.bmp");
    }

    if (url.pathname === "/solar.bmp") {
      const timeZone = resolveClockTimeZone(url, request);
      if (!datePartsInZone(new Date(), timeZone)) {
        return textResponse("Invalid IANA time zone. Example: Europe/London", 400);
      }
      return bmpResponse(request, renderSolarBmp(new Date(), timeZone, orientation, device), "solar.bmp");
    }

    if (url.pathname !== "/weather.bmp") return textResponse("Not found", 404);

    try {
      const units = (url.searchParams.get("units") || "metric").toLowerCase();
      if (units !== "metric" && units !== "imperial") {
        return textResponse("units must be metric or imperial", 400);
      }

      const imperial = units === "imperial";
      const place = await resolvePlace(url, request);
      const weather = await fetchWeather(place, imperial);
      const bmp = renderWeatherBmp(place, weather, imperial, orientation, device);
      return bmpResponse(request, bmp, "weather.bmp");
    } catch (error) {
      return textResponse(error instanceof Error ? error.message : "Weather generation failed", 502);
    }
  },
};
