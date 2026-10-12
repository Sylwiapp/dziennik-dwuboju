const STORAGE_KEY = "dwuboj-v1";
const ROLE_KEY = "dwuboj-role";
const ATHLETE_KEY = "dwuboj-athlete";

const COMPLEXES = {
  C1: "C1 rwaniowe",
  C2: "C2 podrzutowe",
  C3: "C3 ciągi",
  C4: "C4 przysiady",
  C5: "C5 martwe ciągi",
  C6: "C6 wyciskania",
  C7: "C7 siłowe z oporem",
  C8: "C8 masa własna",
  C9: "C9 moc (skoki, rzuty)",
  C10: "C10 rozciąganie",
  C11: "C11 inne",
};
const KINDS = ["specjalne", "uzupełniające", "rozciągające"];
const SESSION_TYPES = [
  ["PC", "PC — podnoszenie ciężarów"],
  ["SIL", "siłowy"],
  ["INNE", "inny"],
];
const DAY_NAMES = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

let state = loadState();
let role = null;
let currentUser = null;
let profile = null;
let athletes = [];
let selectedAthleteId = localStorage.getItem(ATHLETE_KEY);
let cloudRevision = 0;
let syncTimer = null;
let syncStatus = "łączenie…";
let supabaseClient = null;
let recoveryMode = false;
let message = "";

function configured() {
  return Boolean(
    window.APP_CONFIG?.supabaseUrl
    && window.APP_CONFIG?.supabaseAnonKey
    && window.supabase?.createClient
  );
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_error) {
    /* zostawiamy przykład */
  }
  const seeded = seed();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!selectedAthleteId) return;
  syncStatus = "zapisywanie…";
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(saveCloud, 250);
}

async function saveCloud() {
  if (!supabaseClient || !selectedAthleteId) return;
  const { data, error } = await supabaseClient
    .from("athlete_data")
    .update({
      data: state,
      revision: cloudRevision + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("athlete_id", selectedAthleteId)
    .eq("revision", cloudRevision)
    .select("revision")
    .single();
  if (error) {
    syncStatus = "konflikt";
    message = "Dane zmieniły się na innym urządzeniu. Pobierz najnowszą wersję w zakładce Więcej i ponów zmianę.";
    render();
    return;
  }
  cloudRevision = data.revision;
  syncStatus = "zapisano";
  updateSyncBadge();
}

function updateSyncBadge() {
  const badge = document.querySelector(".sync");
  if (badge) badge.textContent = syncStatus;
}

async function loadAthleteData(athleteId) {
  const { data, error } = await supabaseClient
    .from("athlete_data")
    .select("data, revision")
    .eq("athlete_id", athleteId)
    .single();
  if (error) throw error;
  state = data?.data && Array.isArray(data.data.records) ? data.data : seed();
  cloudRevision = data?.revision || 1;
  selectedAthleteId = athleteId;
  localStorage.setItem(ATHLETE_KEY, athleteId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  syncStatus = "zapisano";
}

async function loadAccount() {
  const { data: authData } = await supabaseClient.auth.getUser();
  currentUser = authData.user;
  if (!currentUser) {
    profile = null;
    role = null;
    return;
  }
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", currentUser.id)
    .single();
  if (error) throw error;
  profile = data;
  role = profile.role;
  if (role === "athlete") {
    await loadAthleteData(currentUser.id);
    return;
  }
  const result = await supabaseClient.rpc("list_my_athletes");
  if (result.error) throw result.error;
  athletes = result.data || [];
  if (athletes.length) {
    const picked = athletes.some((item) => item.id === selectedAthleteId)
      ? selectedAthleteId
      : athletes[0].id;
    await loadAthleteData(picked);
  } else {
    selectedAthleteId = null;
    localStorage.removeItem(ATHLETE_KEY);
  }
}

function nextId() {
  state.seq = Number(state.seq) || 0;
  state.seq += 1;
  return state.seq;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function pl(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits).replace(".", ",");
}

function pct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${pl(value * 100, 0)}%`;
}

function isoAdd(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function weekday(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return DAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function prettyDate(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

function dayDate(start, dayIndex) {
  return isoAdd(start, dayIndex - 1);
}

function recordById(id) {
  return state.records.find((record) => record.id === id) || null;
}

function options(pairs, selected) {
  return pairs.map(([value, label]) => (
    `<option value="${esc(value)}" ${String(selected) === String(value) ? "selected" : ""}>${esc(label)}</option>`
  )).join("");
}

function seed() {
  const data = { seq: 0, records: [], microcycles: [], sessions: [] };
  const id = () => {
    data.seq += 1;
    return data.seq;
  };
  const recordNames = {};
  [["rwanie", 95], ["podrzut", 115], ["ciąg", 115], ["przysiad", 153], ["wyciskanie", 55]].forEach(([name, maxKg]) => {
    const record = { id: id(), name, maxKg };
    data.records.push(record);
    recordNames[name] = record.id;
  });
  const levels = ["średnie", "duże", "średnie", "małe", "duże", "średnie", "regeneracja"];
  for (let micro = 1; micro <= 5; micro += 1) {
    const cycle = {
      id: id(),
      periodNo: 1,
      microNo: micro,
      startDate: isoAdd("2024-12-30", 7 * (micro - 1)),
      intensityNote: "70–80% rekordu w środkach specjalnych",
      volumeNote: micro < 5 ? "objętość średnia, niedziela regeneracja" : "objętość niższa przed startem",
      days: levels.map((level, index) => ({
        id: id(),
        dayIndex: index + 1,
        loadLevel: level,
        note: "",
        exercises: [],
      })),
    };
    data.microcycles.push(cycle);
  }
  const fifth = data.microcycles[4];
  const planned = [
    [1, "rwanie na siad", "C1", "specjalne", "4", "3", 0.7, "rwanie"],
    [1, "zarzut na siad + podrzut", "C2", "specjalne", "3", "2+1", 0.75, "podrzut"],
    [1, "przysiady tył", "C4", "specjalne", "3", "6", 0.7, "przysiad"],
    [1, "skoki przez płotki", "C9", "uzupełniające", "4", "5", null, null],
    [3, "ciągi podrzutowe", "C3", "specjalne", "5", "3", 0.8, "ciąg"],
    [3, "rwanie na wysoko", "C1", "specjalne", "5", "2", 0.75, "rwanie"],
    [3, "rozciąganie mm. czworogłowych", "C10", "rozciągające", "2", "8", null, null],
    [5, "wyciskanie stojąc", "C6", "specjalne", "3", "8", 0.6, "wyciskanie"],
    [5, "przysiady przód", "C4", "specjalne", "4", "5", 0.75, "przysiad"],
  ];
  planned.forEach(([dayIndex, name, complex, kind, setsText, repsText, intensity, recordName]) => {
    fifth.days[dayIndex - 1].exercises.push({
      id: id(),
      name,
      complex,
      kind,
      setsText,
      repsText,
      intensity,
      recordId: recordName ? recordNames[recordName] : null,
    });
  });
  const loads = [0.62, 0.7, 0.78, 0.84, 0.72];
  const volumes = [3, 4, 5, 5, 3];
  loads.forEach((fraction, index) => {
    const micro = index + 1;
    const sets = volumes[index];
    const week = isoAdd("2024-12-30", 7 * index);
    [[0, "PC", 1, 50, 5, 15, 4], [2, "PC", 2, 60, 6, 20, 5], [4, "SIL", 3, 45, 6, 15, 4]].forEach(
      ([offset, kind, number, timeS, rpeS, timeW, rpeW]) => {
        const rows = kind === "PC"
          ? [
            ["rwanie", "C1", String(sets), "3", Math.round(95 * fraction), "rwanie"],
            ["zarzut + podrzut", "C2", String(Math.max(sets - 1, 2)), "3", Math.round(115 * fraction), "podrzut"],
            ["ciągi", "C3", String(sets), "3", Math.round(115 * (fraction + 0.05)), "ciąg"],
          ]
          : [
            ["przysiady tył", "C4", String(sets), "5", Math.round(153 * fraction), "przysiad"],
            ["wyciskanie", "C6", "3", "8", Math.round(55 * fraction), "wyciskanie"],
          ];
        data.sessions.push({
          id: id(),
          date: isoAdd(week, offset),
          periodNo: 1,
          microNo: micro,
          sessionInMicro: number,
          sessionType: kind,
          timeS,
          rpeS,
          timeW,
          rpeW,
          rows: rows.map(([name, complex, setsText, repsText, loadKg, recordName], rowIndex) => ({
            id: id(),
            exerciseNo: rowIndex + 1,
            name,
            complex,
            setsText,
            repsText,
            loadKg,
            recordKg: data.records.find((record) => record.name === recordName).maxKg,
            recordName,
          })),
        });
      },
    );
  });
  return data;
}

function planExerciseRow(exercise) {
  const record = recordById(exercise.recordId);
  return {
    sets_text: exercise.setsText,
    reps_text: exercise.repsText,
    intensity: exercise.intensity,
    record_kg: record ? record.maxKg : null,
  };
}

function diaryRow(row) {
  return {
    sets_text: row.setsText,
    reps_text: row.repsText,
    load_kg: row.loadKg,
    record_kg: row.recordKg,
    complex: row.complex,
  };
}

function sessionSummary(session) {
  return summarizeSession(session.rows.map(diaryRow), session.timeS, session.rpeS, session.timeW, session.rpeW);
}

function shell(title, body, dock) {
  const dockHtml = dock ? `
    <nav class="dock">
      <a href="#plan" class="${title === "plan" ? "here" : ""}">Plan</a>
      <a href="#dziennik" class="${title === "dziennik" ? "here" : ""}">Dziennik</a>
      <a href="#analiza" class="${title === "analiza" ? "here" : ""}">Analiza</a>
      <a href="#wiecej" class="${title === "wiecej" ? "here" : ""}">Więcej</a>
    </nav>` : "";
  document.getElementById("app").innerHTML = `
    ${dock ? `<header class="top">
      <div>
        <strong>${role === "coach" && selectedAthleteId ? esc(athletes.find((item) => item.id === selectedAthleteId)?.full_name || "Dziennik dwuboju") : "Dziennik dwuboju"}</strong>
        <small class="sync">${esc(syncStatus)}</small>
      </div>
      <span class="role-pill">${role === "coach" ? "trener" : "zawodnik"}</span>
    </header>` : ""}
    <main>
      ${message ? `<p class="flash">${esc(message)}</p>` : ""}
      ${body}
    </main>
    ${dockHtml}`;
  message = "";
}

function render() {
  const hash = location.hash.replace("#", "") || (role === "athlete" ? "dziennik" : "plan");
  const [name, arg] = hash.split("/");
  if (recoveryMode) {
    renderPasswordRecovery();
    return;
  }
  if (!currentUser) {
    renderGate();
    return;
  }
  if (role === "coach" && !selectedAthleteId) {
    renderCoachStart();
    return;
  }
  if (name === "plan" && arg) renderPlan(Number(arg));
  else if (name === "plan") renderPlanList();
  else if (name === "druk" && arg) renderPrint(Number(arg));
  else if (name === "dziennik" && arg) renderDiary(Number(arg));
  else if (name === "dziennik") renderDiaryList();
  else if (name === "analiza") renderAnalysis(arg || "");
  else renderMore();
}

function renderGate() {
  if (!configured()) {
    shell("gate", `
      <section class="card">
        <h1>Podłącz Supabase</h1>
        <p class="lead">Aplikacja jest gotowa na normalne konta, ale brakuje adresu projektu i publicznego klucza.</p>
        <ol>
          <li>Utwórz darmowy projekt w Supabase.</li>
          <li>Uruchom plik <code>supabase.sql</code> w SQL Editor.</li>
          <li>Wklej Project URL i anon public key do <code>config.js</code>.</li>
        </ol>
      </section>
    `, false);
    return;
  }
  shell("gate", `
    <section class="card gate">
      <h1>Zaloguj się</h1>
      <p class="lead">Każdy trener i zawodnik ma własne konto.</p>
      <form data-action="sign-in">
        <label for="login-email">E-mail</label><input id="login-email" name="email" type="email" autocomplete="email" required>
        <label for="login-password">Hasło</label><input id="login-password" name="password" type="password" autocomplete="current-password" required>
        <button class="block" type="submit">Zaloguj</button>
        <button class="quiet block" type="button" data-action="forgot-password">Nie pamiętam hasła</button>
      </form>
    </section>
    <details class="day">
      <summary>Załóż konto<span>trener albo zawodnik</span></summary>
      <div class="day-body">
        <form data-action="sign-up">
          <label>Imię i nazwisko</label><input name="fullName" autocomplete="name" required minlength="2">
          <label>E-mail</label><input name="email" type="email" autocomplete="email" required>
          <label>Hasło (min. 8 znaków)</label><input name="password" type="password" autocomplete="new-password" required minlength="8">
          <label>Rola</label>
          <select name="role"><option value="athlete">zawodnik</option><option value="coach">trener</option></select>
          <button class="block" type="submit">Utwórz konto</button>
        </form>
      </div>
    </details>
    <p class="note">Supabase przechowuje hasła bezpiecznie. Aplikacja nie widzi ich treści.</p>
  `, false);
}

function renderPasswordRecovery() {
  shell("gate", `
    <section class="card">
      <h1>Ustaw nowe hasło</h1>
      <form data-action="update-password">
        <label for="new-password">Nowe hasło (min. 8 znaków)</label>
        <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <button class="block" type="submit">Zapisz nowe hasło</button>
      </form>
    </section>
  `, false);
}

function renderCoachStart() {
  shell("wiecej", `
    <h1>Dodaj pierwszego zawodnika</h1>
    <p class="lead">Wygeneruj kod i wyślij go zawodnikowi. Zawodnik zakłada własne konto, a następnie wpisuje kod w zakładce Więcej.</p>
    <button class="block" type="button" data-action="create-invite">Wygeneruj kod zaproszenia</button>
    <p class="note">Kod jest jednorazowy i ważny przez 7 dni.</p>
    <button class="quiet block" type="button" data-action="refresh-account">Odśwież listę po dołączeniu zawodnika</button>
    <button class="quiet block" type="button" data-action="sign-out">Wyloguj</button>
  `, false);
}

function renderPlanList() {
  const cards = state.microcycles.map((cycle) => `
    <a class="card" href="#plan/${cycle.id}" style="display:block;text-decoration:none;color:inherit">
      <b>Okres ${cycle.periodNo}, mikrocykl ${cycle.microNo}</b>
      <span class="note">od ${prettyDate(cycle.startDate)}</span>
      <div>${esc(cycle.intensityNote || "")}</div>
    </a>`).join("");
  const form = role === "coach" ? `
    <details class="day"><summary>Nowy mikrocykl</summary><div class="day-body">
      <form data-action="new-cycle">
        <label>Nr okresu</label><input name="periodNo" type="number" min="1" value="1" required>
        <label>Nr mikrocyklu</label><input name="microNo" type="number" min="1" value="${state.microcycles.length + 1}" required>
        <label>Data początku</label><input name="startDate" type="date" required>
        <label>Intensywność</label><input name="intensityNote" placeholder="np. 75%">
        <label>Objętość</label><input name="volumeNote" placeholder="np. 6–8 serii">
        <button class="block" type="submit">Utwórz</button>
      </form>
    </div></details>` : "";
  const athletePicker = role === "coach" && athletes.length > 1 ? `
    <label>Zawodnik</label>
    <select data-action="pick-athlete">
      ${athletes.map((athlete) => `<option value="${athlete.id}" ${athlete.id === selectedAthleteId ? "selected" : ""}>${esc(athlete.full_name)}</option>`).join("")}
    </select>` : "";
  shell("plan", `<h1>Plan</h1><p class="lead">Mikrocykl na siedem dni: serie, podniesienia i intensywność względem rekordu.</p>${athletePicker}${cards}${form}`, true);
}

function renderPlan(id) {
  const cycle = state.microcycles.find((item) => item.id === id);
  if (!cycle) {
    shell("plan", `<p>Nie ma takiego mikrocyklu.</p>`, true);
    return;
  }
  const all = summarizePlan(cycle.days.flatMap((day) => day.exercises.map(planExerciseRow)));
  const firstOpen = cycle.days.find((day) => day.exercises.length);
  const days = cycle.days.map((day) => {
    const date = dayDate(cycle.startDate, day.dayIndex);
    const summary = summarizePlan(day.exercises.map(planExerciseRow));
    const existingSession = state.sessions.find((session) => session.date === date);
    const exercises = day.exercises.map((exercise) => {
      const record = recordById(exercise.recordId);
      return `<div class="ex">
        <b>${esc(exercise.name)}</b>
        <span class="note">${esc(COMPLEXES[exercise.complex] || exercise.complex)} · ${esc(exercise.kind)}</span>
        <div>${esc(exercise.setsText)} ser. × ${esc(exercise.repsText)} ${exercise.intensity != null ? `@ ${pct(exercise.intensity)}` : ""}</div>
        <div class="note">${record ? `${esc(record.name)} ${pl(record.maxKg, 0)} kg` : "bez rekordu"}</div>
        ${role === "coach" ? `<button class="quiet" type="button" data-action="delete-exercise" data-cycle="${cycle.id}" data-day="${day.id}" data-id="${exercise.id}">Usuń</button>` : ""}
      </div>`;
    }).join("");
    const editor = role === "coach" ? `
      <form data-action="save-day">
        <input type="hidden" name="cycleId" value="${cycle.id}">
        <input type="hidden" name="dayId" value="${day.id}">
        <label>Obciążenie dnia</label>
        <input name="loadLevel" value="${esc(day.loadLevel)}" list="poziomy">
        <label>Notatka, np. rozgrzewka</label>
        <input name="note" value="${esc(day.note)}">
        <button class="quiet block" type="submit">Zapisz dzień</button>
      </form>
      <form data-action="add-exercise">
        <input type="hidden" name="cycleId" value="${cycle.id}">
        <input type="hidden" name="dayId" value="${day.id}">
        <label>Nowe ćwiczenie</label><input name="name" required placeholder="np. rwanie na siad">
        <label>Kompleks</label><select name="complex">${options(Object.entries(COMPLEXES), "C1")}</select>
        <label>Rodzaj</label><select name="kind">${options(KINDS.map((kind) => [kind, kind]), "specjalne")}</select>
        <label>Serie</label><input name="setsText" value="3" required>
        <label>Podniesienia</label><input name="repsText" value="3" required>
        <label>Intensywność (0,70 albo 70)</label><input name="intensity" placeholder="0,70">
        <label>Rekord bazowy</label>
        <select name="recordId"><option value="">bez rekordu</option>${state.records.map((record) => `<option value="${record.id}">${esc(record.name)} — ${pl(record.maxKg, 0)} kg</option>`).join("")}</select>
        <button class="block" type="submit">Dodaj do tego dnia</button>
      </form>` : `
        <p class="note">Obciążenie dnia: ${esc(day.loadLevel || "—")}. ${esc(day.note || "")}</p>
        ${existingSession
          ? `<a class="button block" href="#dziennik/${existingSession.id}">Otwórz realizację tego dnia</a>`
          : `<button class="block" type="button" data-action="start-planned-session"
              data-date="${date}" data-period="${cycle.periodNo}" data-micro="${cycle.microNo}">Wpisz realizację tego dnia</button>`}
      `;
    const open = day === firstOpen ? "open" : "";
    return `<details class="day" ${open}>
      <summary>${esc(weekday(date))} ${prettyDate(date)}<span>${esc(day.loadLevel || "bez poziomu")} · ${pl(summary.volume, 0)} podniesień</span></summary>
      <div class="day-body">
        <p class="day-print-title" hidden><b>${esc(weekday(date))} ${prettyDate(date)}</b></p>
        ${editor}
        ${exercises || `<p class="note">Brak ćwiczeń.</p>`}
        <p class="note">Dzień: ${pl(summary.sets, 0)} serii, ${pl(summary.volume, 0)} podniesień, średnio ${pct(summary.avg_intensity)}.</p>
      </div>
    </details>`;
  }).join("");
  const notes = role === "coach" ? `
    <form data-action="save-cycle" class="card">
      <input type="hidden" name="cycleId" value="${cycle.id}">
      <label>Założenie intensywności</label><input name="intensityNote" value="${esc(cycle.intensityNote)}">
      <label>Założenie objętości</label><input name="volumeNote" value="${esc(cycle.volumeNote)}">
      <button class="quiet block" type="submit">Zapisz założenia</button>
    </form>` : "";
  shell("plan", `
    <p><a href="#plan">Wszystkie mikrocykle</a></p>
    <h1>Okres ${cycle.periodNo}, mikrocykl ${cycle.microNo}</h1>
    <p class="lead">Od ${prettyDate(cycle.startDate)}. ${esc(cycle.intensityNote || "")}</p>
    <div class="stats">
      <div class="stat"><b>${pl(all.sets, 0)}</b><span>serie</span></div>
      <div class="stat"><b>${pl(all.volume, 0)}</b><span>podniesienia</span></div>
      <div class="stat"><b>${pct(all.avg_intensity)}</b><span>średnia intensywność</span></div>
      <div class="stat"><b>${pl(all.tonnage, 0)}</b><span>planowany tonaż</span></div>
    </div>
    ${notes}
    ${days}
    <datalist id="poziomy"><option value="małe"></option><option value="średnie"></option><option value="duże"></option><option value="regeneracja"></option></datalist>
    <p class="no-print"><a class="button quiet block" href="#druk/${cycle.id}">Podgląd do wydruku</a></p>
  `, true);
}

function renderPrint(id) {
  const cycle = state.microcycles.find((item) => item.id === id);
  if (!cycle) return;
  const days = cycle.days.map((day) => {
    const date = dayDate(cycle.startDate, day.dayIndex);
    const grouped = KINDS.map((kind) => {
      const items = day.exercises.filter((exercise) => exercise.kind === kind);
      if (!items.length) return "";
      return `<h2>Ćwiczenia ${esc(kind)}</h2><ul>${items.map((exercise) => `<li>${esc(exercise.name)} — ${esc(exercise.setsText)} ser. × ${esc(exercise.repsText)} ${exercise.intensity != null ? `@ ${pct(exercise.intensity)}` : ""}</li>`).join("")}</ul>`;
    }).join("");
    return `<section class="card"><h2>${esc(weekday(date))} ${prettyDate(date)} — ${esc(day.loadLevel || "")}</h2>${day.note ? `<p>${esc(day.note)}</p>` : ""}${grouped || "<p>Brak ćwiczeń.</p>"}</section>`;
  }).join("");
  shell("plan", `
    <p class="no-print"><a href="#plan/${cycle.id}">Wróć</a></p>
    <h1>Plan treningowy</h1>
    <p>Okres ${cycle.periodNo}, mikrocykl ${cycle.microNo}, od ${prettyDate(cycle.startDate)}.</p>
    ${days}
    <button class="block no-print" type="button" onclick="window.print()">Drukuj albo zapisz jako PDF</button>
  `, false);
}

function renderDiaryList() {
  const cards = [...state.sessions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).map((session) => {
    const summary = sessionSummary(session);
    return `<a class="card" href="#dziennik/${session.id}" style="display:block;text-decoration:none;color:inherit">
      <b>${prettyDate(session.date)}</b>
      <span class="note">mikrocykl ${session.periodNo}/${session.microNo} · ${esc(session.sessionType)}</span>
      <div>${pl(summary.tonnage, 0)} kg tonażu · ${pct(summary.avg_intensity)} · RPE-load ${pl(summary.srpe_load, 0)}</div>
    </a>`;
  }).join("");
  const form = role === "athlete" ? `
    <details class="day"><summary>Nowa jednostka</summary><div class="day-body">
      <form data-action="new-session">
        <label>Data</label><input name="date" type="date" required>
        <label>Nr okresu</label><input name="periodNo" type="number" min="1" value="1" required>
        <label>Nr mikrocyklu</label><input name="microNo" type="number" min="1" value="5" required>
        <label>Nr treningu w mikrocyklu</label><input name="sessionInMicro" type="number" min="1" value="1" required>
        <label>Rodzaj</label><select name="sessionType">${options(SESSION_TYPES, "PC")}</select>
        <label>Czas części specjalnej (min)</label><input name="timeS" value="50">
        <label>RPE części specjalnej</label><input name="rpeS" value="5">
        <label>Czas części uzupełniającej (min)</label><input name="timeW" value="15">
        <label>RPE części uzupełniającej</label><input name="rpeW" value="4">
        <button class="block" type="submit">Utwórz jednostkę</button>
      </form>
    </div></details>` : `<p class="note">Nowe wpisy dodaje zawodnik. Rolę zmienisz w zakładce Więcej.</p>`;
  shell("dziennik", `<h1>Dziennik</h1><p class="lead">Serie, podniesienia i kilogramy. Objętość, tonaż i intensywność liczą się same.</p>${cards || "<p>Dziennik jest pusty.</p>"}${form}`, true);
}

function renderDiary(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) {
    shell("dziennik", `<p>Nie ma takiej jednostki.</p>`, true);
    return;
  }
  const summary = sessionSummary(session);
  const rows = session.rows.map((row) => `
    <div class="ex">
      <b>${row.exerciseNo}. ${esc(row.name)}</b>
      <div>${esc(COMPLEXES[row.complex] || row.complex)}</div>
      <div>${esc(row.setsText)} ser. × ${esc(row.repsText)} @ ${pl(row.loadKg, 1)} kg</div>
      <div class="note">${row.recordName ? `${esc(row.recordName)} ${pl(row.recordKg, 0)} kg · ${pct(row.recordKg ? row.loadKg / row.recordKg : null)}` : "bez rekordu"}</div>
      ${role === "athlete" ? `<button class="danger" type="button" data-action="delete-row" data-session="${session.id}" data-id="${row.id}">Usuń</button>` : ""}
    </div>`).join("");
  const header = role === "athlete" ? `
    <form data-action="save-session" class="card">
      <input type="hidden" name="sessionId" value="${session.id}">
      <label>Data</label><input type="date" name="date" value="${esc(session.date)}" required>
      <label>Nr okresu</label><input type="number" name="periodNo" value="${session.periodNo}" required>
      <label>Nr mikrocyklu</label><input type="number" name="microNo" value="${session.microNo}" required>
      <label>Nr treningu w mikrocyklu</label><input type="number" name="sessionInMicro" value="${session.sessionInMicro}" required>
      <label>Rodzaj</label><select name="sessionType">${options(SESSION_TYPES, session.sessionType)}</select>
      <label>Czas części specjalnej (min)</label><input name="timeS" value="${pl(session.timeS, 0)}">
      <label>RPE części specjalnej</label><input name="rpeS" value="${pl(session.rpeS, 0)}">
      <label>Czas części uzupełniającej (min)</label><input name="timeW" value="${pl(session.timeW, 0)}">
      <label>RPE części uzupełniającej</label><input name="rpeW" value="${pl(session.rpeW, 0)}">
      <button class="block" type="submit">Zapisz nagłówek</button>
    </form>
    <form data-action="add-row" class="card">
      <input type="hidden" name="sessionId" value="${session.id}">
      <label>Ćwiczenie</label><input name="name" required>
      <label>Kompleks</label><select name="complex">${options(Object.entries(COMPLEXES), "C1")}</select>
      <label>Serie</label><input name="setsText" value="3" required>
      <label>Podniesienia</label><input name="repsText" value="3" required>
      <label>Obciążenie (kg)</label><input name="loadKg" required placeholder="60">
      <label>Rekord bazowy</label>
      <select name="recordId"><option value="">bez rekordu</option>${state.records.map((record) => `<option value="${record.id}">${esc(record.name)} — ${pl(record.maxKg, 0)} kg</option>`).join("")}</select>
      <button class="block" type="submit">Dodaj wiersz</button>
    </form>
    <button class="quiet block" type="button" data-action="delete-session" data-id="${session.id}">Usuń całą jednostkę</button>
  ` : `<p class="note">Część specjalna ${pl(session.timeS, 0)} min, RPE ${pl(session.rpeS, 0)}. Uzupełniająca ${pl(session.timeW, 0)} min, RPE ${pl(session.rpeW, 0)}.</p>`;
  shell("dziennik", `
    <p><a href="#dziennik">Wszystkie jednostki</a></p>
    <h1>${prettyDate(session.date)}</h1>
    <p class="note">Mikrocykl ${session.periodNo}/${session.microNo}, trening ${session.sessionInMicro}, ${esc(session.sessionType)}</p>
    <div class="stats">
      <div class="stat"><b>${pl(summary.sets, 0)}</b><span>serie</span></div>
      <div class="stat"><b>${pl(summary.volume, 0)}</b><span>podniesienia</span></div>
      <div class="stat"><b>${pl(summary.tonnage, 0)} kg</b><span>tonaż</span></div>
      <div class="stat"><b>${pl(summary.avg_load, 1)} kg</b><span>średnie obciążenie</span></div>
      <div class="stat"><b>${pct(summary.avg_intensity)}</b><span>średnia intensywność</span></div>
      <div class="stat"><b>${pl(summary.srpe_load, 0)}</b><span>sRPE-load</span></div>
    </div>
    ${header}
    ${rows || `<p class="note">Brak ćwiczeń w tej jednostce.</p>`}
  `, true);
}

function analysisModel() {
  const sessions = [...state.sessions].sort((a, b) => a.periodNo - b.periodNo || a.microNo - b.microNo || a.date.localeCompare(b.date));
  const summaries = sessions.map((session) => ({
    ...sessionSummary(session),
    period_no: session.periodNo,
    micro_no: session.microNo,
    session_type: session.sessionType,
  }));
  const microcycles = summarizeMicrocycles(summaries);
  const article = microcycles.map((bucket) => {
    const rows = sessions
      .filter((session) => session.periodNo === bucket.period_no && session.microNo === bucket.micro_no)
      .flatMap((session) => session.rows.map(diaryRow));
    return { ...bucket, ...articleByGroup(rows) };
  });
  return { summaries, microcycles, article };
}

function renderAnalysis(arg) {
  const { microcycles, article } = analysisModel();
  const keys = microcycles.map((item) => `${item.period_no}-${item.micro_no}`);
  state.microcycles.forEach((cycle) => {
    const key = `${cycle.periodNo}-${cycle.microNo}`;
    if (!keys.includes(key)) keys.push(key);
  });
  keys.sort();
  const chosen = keys.includes(arg) ? arg : keys[keys.length - 1];
  const cards = microcycles.map((item) => `
    <article class="card">
      <b>Okres ${item.period_no}, mikrocykl ${item.micro_no}</b>
      <p class="note">${item.sessions} jedn. · PC ${item.pc} · siłowe ${item.sil} · inne ${item.inne}</p>
      <div class="stats">
        <div class="stat"><b>${pl(item.tonnage, 0)} kg</b><span>tonaż</span></div>
        <div class="stat"><b>${pl(item.volume, 0)}</b><span>podniesienia</span></div>
        <div class="stat"><b>${pl(item.avg_load, 1)} kg</b><span>średnie obciążenie</span></div>
        <div class="stat"><b>${pl(item.acwr_tonnage, 2)}</b><span>ACWR tonażu</span></div>
      </div>
    </article>`).join("");
  const last = article[article.length - 1];
  const maxTonnage = last ? Math.max(...last.groups.map((group) => group.tonnage || 0), 1) : 1;
  const bars = last ? last.groups.map((group) => `
    <p>${esc(group.label)} — ${pl(group.tonnage, 0)} kg
      <span class="bar"><i style="width:${Math.round(100 * (group.tonnage || 0) / maxTonnage)}%"></i></span>
    </p>`).join("") : "";
  let comparison = "";
  if (chosen) {
    const [periodNo, microNo] = chosen.split("-").map(Number);
    const cycle = state.microcycles.find((item) => item.periodNo === periodNo && item.microNo === microNo);
    if (cycle) {
      const days = cycle.days.map((day) => {
        const date = dayDate(cycle.startDate, day.dayIndex);
        const planned = summarizePlan(day.exercises.map(planExerciseRow));
        const realizedRows = state.sessions
          .filter((session) => session.date === date)
          .flatMap((session) => session.rows.map(diaryRow));
        const realized = summarizeSession(realizedRows, 0, 0, 0, 0);
        return `<article class="card">
          <b>${esc(weekday(date))} ${prettyDate(date)}</b>
          <p class="note">${esc(day.loadLevel || "")}</p>
          <div>Plan: ${pl(planned.volume, 0)} podniesień, ${pct(planned.avg_intensity)}, tonaż ${pl(planned.tonnage, 0)} kg</div>
          <div>Zrobione: ${realizedRows.length ? `${pl(realized.volume, 0)} podniesień, ${pct(realized.avg_intensity)}, tonaż ${pl(realized.tonnage, 0)} kg` : "brak wpisu"}</div>
        </article>`;
      }).join("");
      comparison = days;
    } else {
      comparison = `<p>Dla mikrocyklu ${esc(chosen)} nie ma planu trenera.</p>`;
    }
  }
  const select = keys.length ? `<label>Mikrocykl do porównania</label><select data-action="pick-micro">${keys.map((key) => `<option value="${esc(key)}" ${key === chosen ? "selected" : ""}>okres ${esc(key.replace("-", ", mikrocykl "))}</option>`).join("")}</select>` : "";
  shell("analiza", `
    <h1>Analiza</h1>
    <p class="lead">Objętość to podniesienia. Tonaż to serie × podniesienia × kg. ACWR to tonaż mikrocyklu podzielony przez średnią z czterech poprzednich. Pojawia się od piątego mikrocyklu.</p>
    ${cards || "<p>Brak jednostek.</p>"}
    <h2>Tonaż ostatniego mikrocyklu wg kompleksów</h2>
    ${bars}
    <h2>Plan wobec realizacji</h2>
    ${select}
    ${comparison}
  `, true);
}

function renderMore() {
  const records = state.records.map((record) => `
    <form data-action="save-record" class="card">
      <input type="hidden" name="id" value="${record.id}">
      <label>Ćwiczenie bazowe</label>
      <input name="name" value="${esc(record.name)}" ${role === "coach" ? "" : "readonly"}>
      <label>Rekord (kg)</label>
      <input name="maxKg" value="${pl(record.maxKg, 1)}" ${role === "coach" ? "" : "readonly"}>
      ${role === "coach" ? `<button class="block" type="submit">Zapisz</button><button class="danger block" type="button" data-action="delete-record" data-id="${record.id}">Usuń</button>` : ""}
    </form>`).join("");
  const add = role === "coach" ? `
    <form data-action="add-record" class="card">
      <label>Nowy rekord</label><input name="name" required placeholder="np. rwanie">
      <label>Kilogramy</label><input name="maxKg" required placeholder="95">
      <button class="block" type="submit">Dodaj rekord</button>
    </form>` : "";
  const coachTools = role === "coach" ? `
    <h2>Zawodnicy</h2>
    <label>Otwarty dziennik</label>
    <select data-action="pick-athlete">
      ${athletes.map((athlete) => `<option value="${athlete.id}" ${athlete.id === selectedAthleteId ? "selected" : ""}>${esc(athlete.full_name)}</option>`).join("")}
    </select>
    <button class="block" type="button" data-action="create-invite">Nowe zaproszenie dla zawodnika</button>
  ` : `
    <h2>Połącz z trenerem</h2>
    <form data-action="claim-invite" class="card">
      <label>Jednorazowy kod od trenera</label>
      <input name="code" required autocapitalize="characters">
      <button class="block" type="submit">Przypisz trenera</button>
    </form>
  `;
  shell("wiecej", `
    <h1>Więcej</h1>
    <p class="lead">${esc(profile?.full_name || "")} · ${esc(currentUser?.email || "")}</p>
    ${coachTools}
    <h2>Kopia zapasowa</h2>
    <button class="quiet block" type="button" data-action="export">Pobierz kopię danych</button>
    <label>Odtwórz z pliku</label>
    <input id="import-file" type="file" accept="application/json,.json">
    <p class="note">Na co dzień dane synchronizują się automatycznie. Plik jest tylko kopią awaryjną.</p>
    <h2>Rekordy bazowe</h2>
    <p class="note">Intensywność to kilogramy z treningu podzielone przez rekord. W dzienniku zostaje rekord z chwili wpisu.</p>
    ${records}${add}
    <h2>Konto</h2>
    <button class="quiet block" type="button" data-action="reload-cloud">Pobierz najnowsze dane</button>
    <button class="quiet block" type="button" data-action="sign-out">Wyloguj</button>
    ${role === "coach" ? `<button class="danger block" type="button" data-action="reset">Przywróć przykład temu zawodnikowi</button>` : ""}
  `, true);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function showError(error) {
  message = error.message || "Nie udało się zapisać.";
  render();
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "sign-out") {
    await supabaseClient.auth.signOut();
    currentUser = null;
    profile = null;
    role = null;
    selectedAthleteId = null;
    localStorage.removeItem(ATHLETE_KEY);
    location.hash = "";
    render();
  } else if (action === "forgot-password") {
    const email = document.querySelector("#login-email")?.value.trim();
    if (!email) {
      message = "Najpierw wpisz adres e-mail.";
      render();
      return;
    }
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}`,
    });
    if (error) {
      showError(error);
      return;
    }
    message = "Wysłano wiadomość z linkiem do zmiany hasła.";
    render();
  } else if (action === "refresh-account") {
    try {
      await loadAccount();
      message = athletes.length ? "Lista zawodników została odświeżona." : "Zawodnik jeszcze nie dołączył.";
      render();
    } catch (error) {
      showError(error);
    }
  } else if (action === "reload-cloud") {
    try {
      await loadAthleteData(selectedAthleteId);
      message = "Pobrano najnowsze dane.";
      render();
    } catch (error) {
      showError(error);
    }
  } else if (action === "create-invite") {
    const { data, error } = await supabaseClient.rpc("create_athlete_invitation");
    if (error) {
      showError(error);
      return;
    }
    message = `Kod zaproszenia: ${data}. Jest ważny 7 dni i działa jeden raz.`;
    render();
  } else if (action === "start-planned-session") {
    if (role !== "athlete") return;
    const sameMicro = state.sessions.filter(
      (session) => session.periodNo === Number(target.dataset.period)
        && session.microNo === Number(target.dataset.micro),
    );
    const session = {
      id: nextId(),
      date: target.dataset.date,
      periodNo: Number(target.dataset.period),
      microNo: Number(target.dataset.micro),
      sessionInMicro: sameMicro.length + 1,
      sessionType: "PC",
      timeS: 0,
      rpeS: 0,
      timeW: 0,
      rpeW: 0,
      rows: [],
    };
    state.sessions.push(session);
    save();
    location.hash = `#dziennik/${session.id}`;
  } else if (action === "reset") {
    if (!window.confirm("Przywrócić przykładowe pięć mikrocykli? Obecne dane na tym telefonie znikną.")) return;
    state = seed();
    save();
    message = "Przywrócono przykład.";
    render();
  } else if (action === "export") {
    exportFile();
  } else if (action === "delete-exercise") {
    const cycle = state.microcycles.find((item) => item.id === Number(target.dataset.cycle));
    const day = cycle.days.find((item) => item.id === Number(target.dataset.day));
    day.exercises = day.exercises.filter((item) => item.id !== Number(target.dataset.id));
    save();
    render();
  } else if (action === "delete-row") {
    const session = state.sessions.find((item) => item.id === Number(target.dataset.session));
    session.rows = session.rows.filter((item) => item.id !== Number(target.dataset.id));
    save();
    render();
  } else if (action === "delete-session") {
    if (!window.confirm("Usunąć tę jednostkę?")) return;
    state.sessions = state.sessions.filter((item) => item.id !== Number(target.dataset.id));
    save();
    location.hash = "#dziennik";
  } else if (action === "delete-record") {
    state.records = state.records.filter((item) => item.id !== Number(target.dataset.id));
    save();
    render();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.dataset.action === "pick-micro") {
    location.hash = `#analiza/${event.target.value}`;
  }
  if (event.target.id === "import-file" && event.target.files[0]) {
    importFile(event.target.files[0]);
  }
  if (event.target.dataset.action === "pick-athlete") {
    loadAthleteData(event.target.value)
      .then(() => {
        location.hash = "#plan";
        render();
      })
      .catch(showError);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.action) return;
  event.preventDefault();
  try {
    const data = formData(form);
    if (form.dataset.action === "sign-in") {
      const result = await supabaseClient.auth.signInWithPassword({
        email: data.email.trim(),
        password: data.password,
      });
      if (result.error) throw result.error;
      await loadAccount();
      location.hash = role === "coach" ? "#plan" : "#dziennik";
      render();
      return;
    }
    if (form.dataset.action === "sign-up") {
      const result = await supabaseClient.auth.signUp({
        email: data.email.trim(),
        password: data.password,
        options: {
          data: { full_name: data.fullName.trim(), role: data.role },
        },
      });
      if (result.error) throw result.error;
      if (!result.data.session) {
        message = "Sprawdź pocztę i potwierdź konto, potem się zaloguj.";
        render();
        return;
      }
      await loadAccount();
      location.hash = role === "coach" ? "#plan" : "#dziennik";
      render();
      return;
    }
    if (form.dataset.action === "claim-invite") {
      const result = await supabaseClient.rpc("claim_athlete_invitation", {
        invitation_code: data.code.trim().toUpperCase(),
      });
      if (result.error) throw result.error;
      message = "Trener został przypisany do Twojego konta.";
      render();
      return;
    }
    if (form.dataset.action === "update-password") {
      const result = await supabaseClient.auth.updateUser({ password: data.password });
      if (result.error) throw result.error;
      recoveryMode = false;
      await loadAccount();
      message = "Hasło zostało zmienione.";
      location.hash = role === "coach" ? "#plan" : "#dziennik";
      render();
      return;
    }
    handleSubmit(form.dataset.action, formData(form));
    save();
    render();
  } catch (error) {
    showError(error);
  }
});

function handleSubmit(action, data) {
  if (action === "new-cycle") {
    if (role !== "coach") return;
    if (state.microcycles.some((cycle) => cycle.periodNo === Number(data.periodNo) && cycle.microNo === Number(data.microNo))) {
      throw new Error("Taki okres i mikrocykl już jest.");
    }
    const levels = ["średnie", "duże", "średnie", "małe", "duże", "średnie", "regeneracja"];
    const cycle = {
      id: nextId(),
      periodNo: Number(data.periodNo),
      microNo: Number(data.microNo),
      startDate: data.startDate,
      intensityNote: data.intensityNote.trim(),
      volumeNote: data.volumeNote.trim(),
      days: levels.map((level, index) => ({ id: nextId(), dayIndex: index + 1, loadLevel: level, note: "", exercises: [] })),
    };
    state.microcycles.push(cycle);
    location.hash = `#plan/${cycle.id}`;
  } else if (action === "save-cycle") {
    const cycle = state.microcycles.find((item) => item.id === Number(data.cycleId));
    cycle.intensityNote = data.intensityNote.trim();
    cycle.volumeNote = data.volumeNote.trim();
    message = "Zapisano założenia.";
  } else if (action === "save-day") {
    const cycle = state.microcycles.find((item) => item.id === Number(data.cycleId));
    const day = cycle.days.find((item) => item.id === Number(data.dayId));
    day.loadLevel = data.loadLevel.trim();
    day.note = data.note.trim();
    message = "Zapisano dzień.";
  } else if (action === "add-exercise") {
    if (!data.name.trim()) throw new Error("Wpisz nazwę ćwiczenia.");
    parseCount(data.setsText);
    parseCount(data.repsText);
    const intensity = asFraction(data.intensity);
    const cycle = state.microcycles.find((item) => item.id === Number(data.cycleId));
    const day = cycle.days.find((item) => item.id === Number(data.dayId));
    day.exercises.push({
      id: nextId(),
      name: data.name.trim(),
      complex: data.complex,
      kind: data.kind,
      setsText: data.setsText,
      repsText: data.repsText,
      intensity,
      recordId: data.recordId ? Number(data.recordId) : null,
    });
  } else if (action === "new-session") {
    if (role !== "athlete") return;
    const session = {
      id: nextId(),
      date: data.date,
      periodNo: Number(data.periodNo),
      microNo: Number(data.microNo),
      sessionInMicro: Number(data.sessionInMicro),
      sessionType: data.sessionType,
      timeS: num(data.timeS),
      rpeS: num(data.rpeS),
      timeW: num(data.timeW),
      rpeW: num(data.rpeW),
      rows: [],
    };
    state.sessions.push(session);
    location.hash = `#dziennik/${session.id}`;
  } else if (action === "save-session") {
    const session = state.sessions.find((item) => item.id === Number(data.sessionId));
    Object.assign(session, {
      date: data.date,
      periodNo: Number(data.periodNo),
      microNo: Number(data.microNo),
      sessionInMicro: Number(data.sessionInMicro),
      sessionType: data.sessionType,
      timeS: num(data.timeS),
      rpeS: num(data.rpeS),
      timeW: num(data.timeW),
      rpeW: num(data.rpeW),
    });
    message = "Zapisano jednostkę.";
  } else if (action === "add-row") {
    if (!data.name.trim()) throw new Error("Wpisz nazwę ćwiczenia.");
    parseCount(data.setsText);
    parseCount(data.repsText);
    const session = state.sessions.find((item) => item.id === Number(data.sessionId));
    const record = data.recordId ? recordById(Number(data.recordId)) : null;
    session.rows.push({
      id: nextId(),
      exerciseNo: session.rows.length + 1,
      name: data.name.trim(),
      complex: data.complex,
      setsText: data.setsText,
      repsText: data.repsText,
      loadKg: num(data.loadKg),
      recordKg: record ? record.maxKg : null,
      recordName: record ? record.name : "",
    });
  } else if (action === "save-record") {
    const record = recordById(Number(data.id));
    record.name = data.name.trim();
    record.maxKg = num(data.maxKg);
    message = "Zapisano rekord.";
  } else if (action === "add-record") {
    if (!data.name.trim()) throw new Error("Wpisz nazwę rekordu.");
    state.records.push({ id: nextId(), name: data.name.trim(), maxKg: num(data.maxKg) });
  }
}

async function exportFile() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const file = new File([blob], "dziennik-dwuboj.json", { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Dziennik dwuboju" });
      return;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "dziennik-dwuboj.json";
  link.click();
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!incoming || !Array.isArray(incoming.records) || !Array.isArray(incoming.microcycles) || !Array.isArray(incoming.sessions)) {
        throw new Error("To nie jest plik dziennika.");
      }
      if (!window.confirm("Zastąpić dane w tym telefonie zawartością pliku?")) return;
      state = incoming;
      save();
      message = "Wgrano plik.";
      render();
    } catch (error) {
      message = error.message || "Nie udało się wgrać pliku.";
      render();
    }
  };
  reader.readAsText(file);
}

window.addEventListener("hashchange", render);

async function bootstrap() {
  if (!configured()) {
    syncStatus = "brak konfiguracji";
    render();
    return;
  }
  supabaseClient = window.supabase.createClient(
    window.APP_CONFIG.supabaseUrl,
    window.APP_CONFIG.supabaseAnonKey,
  );
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryMode = true;
      render();
    }
  });
  try {
    const { data } = await supabaseClient.auth.getSession();
    if (data.session) await loadAccount();
  } catch (error) {
    message = error.message;
  }
  render();
}

bootstrap();
