// Strażnik biletów: Diuna: Część trzecia, IMAX, Helios Gdynia (Centrum Riviera), 26–30.12.2026.
// Sprawdza API Heliosa i wysyła powiadomienie push przez ntfy.sh, gdy:
//  - pojawi się nowy seans IMAX (ruszyła sprzedaż kolejnych dni),
//  - na seansie, który był (prawie) wyprzedany, zwolnią się miejsca.
// W godzinach ciszy nocnej nic nie wysyła — zbiera zdarzenia i wysyła jedno
// zbiorcze powiadomienie rano.
//
// Uruchomienie: node straznik.js
// Zmienne środowiskowe:
//   NTFY_TOPIC   nazwa kanału ntfy (wymagana, chyba że DRY_RUN=1)
//   DRY_RUN=1    nie wysyła powiadomień, tylko wypisuje je na konsolę
//   CHECKS=4     ile sprawdzeń w jednym uruchomieniu
//   INTERVAL=60  odstęp między sprawdzeniami w sekundach
//   STATE_FILE   plik stanu (domyślnie stan.json obok skryptu)
//
// Wymaga Node.js 18+ (wbudowany fetch). Bez zależności.

const fs = require('fs');
const path = require('path');

const CONFIG = {
  cinemaCmsId: 23,                                        // Helios Gdynia w api.helios.pl
  cinemaId: '0bdb21cd-cf7d-4efb-829f-d1913a666b83',       // Helios Gdynia w restapi.helios.pl
  movie: /diuna.*trzecia|dune.*part three/i,              // tytuł lub tytuł oryginalny
  onlyImax: true,
  dateFrom: '2026-12-26', // interesują nas tylko seanse w tym przedziale dat (włącznie)
  dateTo: '2026-12-30',
  minRow: 7,             // liczymy tylko miejsca od tego rzędu wzwyż (rząd 1 = najbliżej ekranu)
  lowSeats: 10,          // poniżej tylu dobrych wolnych miejsc seans uznajemy za "prawie wyprzedany"
  freedCooldownMin: 30,  // najwyżej jedno powiadomienie "zwolniły się" na seans na tyle minut
  quietFrom: 23,         // cisza nocna od 23:00…
  quietTo: 7,            // …do 7:00 (czas polski)
  timeZone: 'Europe/Warsaw',
  errorAlertMin: 60,     // ostrzeżenie, gdy Helios nie odpowiada / zmienił API dłużej niż tyle minut…
  errorRepeatH: 24,      // …i potem najwyżej raz na tyle godzin
};

const CMS = 'https://api.helios.pl/api/v1';
const REST = 'https://restapi.helios.pl/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (kino-straznik)', 'Accept-Language': 'pl' };

const DRY_RUN = process.env.DRY_RUN === '1';
const TOPIC = process.env.NTFY_TOPIC;
const CHECKS = Number(process.env.CHECKS || 1);
const INTERVAL = Number(process.env.INTERVAL || 60);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'stan.json');

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Lista seansów IMAX szukanego filmu z repertuaru kina.
async function fetchScreenings() {
  const { data } = await getJson(`${CMS}/cinemas/${CONFIG.cinemaCmsId}/screenings`);
  const movieKeys = Object.entries(data.movies || {})
    .filter(([, m]) => CONFIG.movie.test(m.title) || CONFIG.movie.test(m.titleOriginal || ''))
    .map(([key]) => key);
  // Film jest w repertuarze od przedsprzedaży – jego brak to raczej zmiana API niż „nie ma seansów”.
  if (!movieKeys.length) throw new Error('nie znaleziono filmu w repertuarze Heliosa (zmiana API?)');

  const list = [];
  for (const byMovie of Object.values(data.screenings || {})) {
    for (const key of movieKeys) {
      for (const s of byMovie[key]?.screenings || []) {
        const imax = s.cinemaScreen?.feature === 'IMAX';
        if (CONFIG.onlyImax && !imax) continue;
        const day = s.timeFrom.slice(0, 10);
        if (day < CONFIG.dateFrom || day > CONFIG.dateTo) continue;
        list.push({
          id: s.sourceId,
          time: s.timeFrom.slice(0, 16),   // "2026-12-15 19:00"
          version: s.moviePrint?.speakingTypeLabel || '',
        });
      }
    }
  }
  return list.sort((a, b) => a.time.localeCompare(b.time));
}

// Układy sal (dużo danych, nie zmieniają się) — pobieramy raz na uruchomienie.
const layouts = new Map();

async function fetchLayout(screenId) {
  if (!layouts.has(screenId)) {
    const screen = await getJson(`${REST}/cinema/${CONFIG.cinemaId}/screen/${screenId}`);
    const rowLegend = Object.fromEntries(screen.rows.map(r => [r.id, r.legend]));
    // kind "0" = fotel (kind "1" to przejścia/puste pola); pomijamy miejsca dla wózków
    const seats = screen.seats
      .filter(x => x.kind === '0' && !x.wheelchairSeat)
      .map(x => ({ id: x.id, row: rowLegend[x.rowId] }));
    layouts.set(screenId, seats);
  }
  return layouts.get(screenId);
}

// Wolne miejsca w rzędach >= minRow: { good: liczba, rows: { "9": 4, "12": 2 } }
async function fetchSeats(screeningId) {
  const base = `${REST}/cinema/${CONFIG.cinemaId}/screening/${screeningId}`;
  const detail = await getJson(base);
  const occ = await getJson(`${base}/occupancy?cacheBust=${Date.now()}`);
  const taken = new Set(occ.occupiedSeats || []);
  const rows = {};
  let good = 0;
  for (const seat of await fetchLayout(detail.screenId)) {
    const row = Number(seat.row);
    if (taken.has(seat.id) || !(row >= CONFIG.minRow)) continue;
    rows[row] = (rows[row] || 0) + 1;
    good++;
  }
  return { good, rows, total: occ.seatsLeft };
}

function rowsText(rows) {
  const parts = Object.entries(rows || {}).sort((a, b) => a[0] - b[0]).map(([r, n]) => `rz. ${r}: ${n}`);
  return parts.length ? parts.join(', ') : 'brak';
}

function seatsText(x) {
  return `dobrych miejsc (od rz. ${CONFIG.minRow}): ${x.seats}` + (x.seats ? ` [${rowsText(x.rows)}]` : '') + `, wszystkich wolnych: ${x.total}`;
}

function buyLink(screeningId) {
  return `https://bilety.helios.pl/screen/${screeningId}?cinemaId=${CONFIG.cinemaId}`;
}

function warsawHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: CONFIG.timeZone }).format(date));
}

function isQuiet(date = new Date()) {
  const h = warsawHour(date);
  return CONFIG.quietFrom > CONFIG.quietTo
    ? h >= CONFIG.quietFrom || h < CONFIG.quietTo
    : h >= CONFIG.quietFrom && h < CONFIG.quietTo;
}

function label(s) {
  const [d, t] = s.time.split(' ');
  const [, m, day] = d.split('-');
  return `${day}.${m} ${t}${s.version ? ' (' + s.version.toLowerCase() + ')' : ''}`;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function notify({ title, message, click, priority = 4, tags = 'movie_camera' }) {
  if (DRY_RUN || !TOPIC) {
    console.log(`[powiadomienie${DRY_RUN ? ' – próba' : ' – brak NTFY_TOPIC'}] ${title}\n${message}\n${click || ''}`);
    return;
  }
  // Nagłówki HTTP przyjmują tylko ASCII – polskie znaki kodujemy wg RFC 2047 (ntfy to rozumie)
  const headers = { Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`, Priority: String(priority), Tags: tags };
  if (click) headers.Click = click;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}`, {
    method: 'POST', body: message, headers,
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

// Jedno sprawdzenie. Zwraca listę zdarzeń do zgłoszenia.
async function check(state) {
  const screenings = await fetchScreenings();
  const events = [];
  const firstRun = !state.initialized;
  let failed = 0;

  for (const s of screenings) {
    let info;
    try { info = await fetchSeats(s.id); }
    catch (e) { console.warn(`Nie udało się pobrać miejsc dla ${label(s)}: ${e.message}`); failed++; continue; }

    const prev = state.screenings[s.id];
    const entry = { id: s.id, time: s.time, version: s.version, seats: info.good, rows: info.rows, total: info.total, lastFreed: prev?.lastFreed || 0 };
    if (!prev) {
      if (!firstRun) events.push({ kind: 'new', s: entry });
    } else if (prev.seats < CONFIG.lowSeats && info.good > prev.seats
               && Date.now() - entry.lastFreed > CONFIG.freedCooldownMin * 60000) {
      // Seans był (prawie) wyprzedany w dobrych rzędach, a teraz coś się tam zwolniło.
      events.push({ kind: 'freed', s: entry, before: prev.seats });
      entry.lastFreed = Date.now();
    }
    state.screenings[s.id] = entry;
  }
  if (screenings.length && failed === screenings.length) throw new Error('nie udało się pobrać miejsc dla żadnego seansu');

  // Seanse, których już nie ma w repertuarze (minęły / zdjęte) — usuwamy ze stanu.
  const current = new Set(screenings.map(s => s.id));
  for (const id of Object.keys(state.screenings)) if (!current.has(id)) delete state.screenings[id];

  if (firstRun) {
    state.initialized = true;
    const lines = screenings.filter(s => state.screenings[s.id]).map(s => `${label(s)} – ${seatsText(state.screenings[s.id])}`);
    events.push({ kind: 'start', lines });
  }
  return events;
}

function describe(e) {
  if (e.kind === 'new') return `NOWY seans ${label(e.s)} – ${seatsText(e.s)}`;
  if (e.kind === 'freed') return `Zwolniły się miejsca: ${label(e.s)} – ${seatsText(e.s)} (było dobrych: ${e.before})`;
  return '';
}

async function flush(state, events) {
  const now = new Date();
  const real = events.filter(e => e.kind !== 'start');

  for (const e of events.filter(e => e.kind === 'start')) {
    await notify({
      title: 'Strażnik Diuny IMAX działa',
      message: e.lines.length
        ? 'Obecne seanse IMAX w Gdyni:\n' + e.lines.join('\n')
        : `Na razie brak seansów IMAX w dniach ${label({ time: CONFIG.dateFrom + ' ' }).trim()}–${label({ time: CONFIG.dateTo + ' ' }).trim()}. Dam znać, gdy ruszy sprzedaż.`,
      priority: 3,
      tags: 'white_check_mark',
    });
  }

  if (isQuiet(now)) {
    state.pending.push(...real.map(e => ({ text: describe(e), id: e.s.id })));
    if (real.length) console.log(`Cisza nocna – odłożono ${real.length} zdarzeń do rana.`);
    return;
  }

  // Poranny meldunek „żyję” (raz dziennie, cichy). Jego brak rano = padł cron-job.org, GitHub albo strażnik.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: CONFIG.timeZone }).format(now);
  if (state.lastHeartbeat !== today) {
    const lines = Object.values(state.screenings).map(s => `${label(s)} – ${seatsText(s)}`);
    await notify({
      title: 'Strażnik Diuny: żyję',
      message: lines.length ? 'Seanse IMAX 26–30.12:\n' + lines.join('\n') : 'Seansów IMAX 26–30.12 jeszcze nie ma w sprzedaży.',
      priority: 2,
      tags: 'white_check_mark',
    });
    state.lastHeartbeat = today;
  }

  // Rano: jedno zbiorcze powiadomienie z nocy, z aktualną liczbą miejsc.
  if (state.pending.length) {
    const ids = [...new Set(state.pending.map(p => p.id))];
    const current = ids
      .filter(id => state.screenings[id])
      .map(id => `${label(state.screenings[id])} – ${seatsText(state.screenings[id])}`);
    await notify({
      title: 'Diuna IMAX: co się działo w nocy',
      message: state.pending.map(p => p.text).join('\n') + (current.length ? '\n\nStan teraz:\n' + current.join('\n') : ''),
      click: ids.length === 1 ? buyLink(ids[0]) : `https://helios.pl/gdynia/kino-helios`,
      priority: 5,
      tags: 'rotating_light',
    });
    state.pending = [];
  }

  if (real.length === 1) {
    const [e] = real;
    await notify({
      title: e.kind === 'new' ? 'Diuna IMAX: nowy seans w sprzedaży!' : 'Diuna IMAX: zwolniły się miejsca!',
      message: describe(e),
      click: buyLink(e.s.id),
      priority: 5,
      tags: 'rotating_light',
    });
  } else if (real.length > 1) {
    // Np. start sprzedaży kolejnego tygodnia — jedno zbiorcze powiadomienie zamiast kilkunastu.
    await notify({
      title: `Diuna IMAX: zmiany w sprzedaży (${real.length})!`,
      message: real.map(describe).join('\n'),
      click: 'https://helios.pl/gdynia/kino-helios',
      priority: 5,
      tags: 'rotating_light',
    });
  }
}

async function main() {
  const state = loadState() || { initialized: false, screenings: {}, pending: [] };
  for (let i = 0; i < CHECKS; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, INTERVAL * 1000));
    try {
      const events = await check(state);
      await flush(state, events);
      if (state.errorSince && state.lastErrorAlert > state.errorSince) {
        await notify({ title: 'Strażnik Diuny znów działa', message: 'Helios znowu odpowiada, pilnuję dalej.', priority: 3, tags: 'white_check_mark' });
      }
      state.errorSince = 0;
      saveState(state);
      const summary = Object.values(state.screenings).map(s => `${label(s)}: ${s.seats}/${s.total} [${rowsText(s.rows)}]`).join(' | ');
      console.log(`${new Date().toISOString()} OK – ${summary || 'brak seansów IMAX'}`);
    } catch (e) {
      console.error(`${new Date().toISOString()} Błąd: ${e.message}`);
      await alertOnError(state, e).catch(err => console.error(`Nie wysłano ostrzeżenia: ${err.message}`));
      saveState(state);
    }
  }
}

// Błąd trwa dłużej niż errorAlertMin → ostrzeżenie na telefon (poza ciszą nocną, najwyżej co errorRepeatH).
async function alertOnError(state, e) {
  const now = Date.now();
  state.errorSince = state.errorSince || now;
  const minutes = Math.round((now - state.errorSince) / 60000);
  if (minutes < CONFIG.errorAlertMin || isQuiet()) return;
  if (now - (state.lastErrorAlert || 0) < CONFIG.errorRepeatH * 3600000) return;
  await notify({
    title: 'Strażnik Diuny NIE DZIAŁA',
    message: `Od ${minutes} min nie mogę sprawdzić Heliosa: ${e.message}\nDopóki to nie wróci, cisza nie znaczy „brak biletów”. Sprawdzaj ręcznie albo napraw strażnika.`,
    click: 'https://helios.pl/gdynia/kino-helios',
    priority: 4,
    tags: 'warning',
  });
  state.lastErrorAlert = now;
}

if (require.main === module) main();
module.exports = { isQuiet, label, check, flush };
