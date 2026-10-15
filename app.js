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
let roster = [];
let inviteCode = "";

const RPE_NOTE = "RPE: 5 to umiarkowanie, 7 ciężko, 9 bardzo ciężko. RPE-load liczy się jako minuty razy RPE.";

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
  const currentRoster = roster.find((item) => item.id === selectedAthleteId);
  if (currentRoster) Object.assign(currentRoster, snapshotOf(state));
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
  ensureShape(state);
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
    try {
      await loadRoster();
    } catch (_error) {
      roster = [];
    }
  } else {
    selectedAthleteId = null;
    roster = [];
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

function shortDate(iso) {
  const [, month, day] = iso.split("-");
  return `${day}.${month}`;
}

function weekSpan(cycle) {
  const start = dayDate(cycle.startDate, 1);
  const end = dayDate(cycle.startDate, 7);
  const range = start.slice(0, 4) === end.slice(0, 4)
    ? `${shortDate(start)}–${shortDate(end)}`
    : `${prettyDate(start)}–${prettyDate(end)}`;
  return `${range}, mikrocykl ${cycle.microNo}`;
}

const DAY_GENITIVE = {
  niedziela: "niedzieli",
  poniedziałek: "poniedziałku",
  wtorek: "wtorku",
  środa: "środy",
  czwartek: "czwartku",
  piątek: "piątku",
  sobota: "soboty",
};

function joinDays(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} i ${names.at(-1)}`;
}

function screenAfterAthleteSwitch() {
  const parts = location.hash.replace("#", "").split("/");
  const name = parts[0] || "plan";
  if (name === "analiza") {
    const section = ["tydzien", "mikrocykle", "start"].includes(parts[1]) ? parts[1] : "tydzien";
    return `#analiza/${section}`;
  }
  if (name === "dziennik") return "#dziennik";
  if (name === "wiecej") return "#wiecej";
  return "#plan";
}

function dayDate(start, dayIndex) {
  return isoAdd(start, dayIndex - 1);
}

function ensureShape(data) {
  if (!data || typeof data !== "object") return;
  if (!Array.isArray(data.competitions)) data.competitions = [];
  if (!Array.isArray(data.goals)) data.goals = [];
  if (!data.tei || typeof data.tei !== "object") data.tei = {};
  if (data.sex == null) data.sex = "";
}

function optionalNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = num(value);
  return number > 0 ? number : null;
}

function snapshotOf(data) {
  const source = data || {};
  const sessions = [...(source.sessions || [])]
    .filter((session) => session && session.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!sessions.length) {
    return { lastDate: null, tonnage: null, acwr: null, status: "Brak wpisów w dzienniku." };
  }
  const summaries = sessions.map((session) => ({
    ...summarizeSession((session.rows || []).map(diaryRow), session.timeS, session.rpeS, session.timeW, session.rpeW),
    period_no: Number(session.periodNo),
    micro_no: Number(session.microNo),
    session_type: session.sessionType,
  }));
  const latest = summarizeMicrocycles(summaries).at(-1);
  return {
    lastDate: sessions.at(-1).date,
    tonnage: latest ? latest.tonnage : null,
    acwr: latest ? latest.acwr_tonnage : null,
    status: `${prettyDate(sessions.at(-1).date)}. ${acwrSentence(latest && latest.acwr_tonnage, "Tonaż")}`,
  };
}

async function loadRoster() {
  if (role !== "coach" || !athletes.length || !supabaseClient) {
    roster = [];
    return;
  }
  const { data, error } = await supabaseClient
    .from("athlete_data")
    .select("athlete_id, data")
    .in("athlete_id", athletes.map((item) => item.id));
  if (error) throw error;
  const byId = new Map((data || []).map((row) => [row.athlete_id, row.data || {}]));
  roster = athletes.map((athlete) => {
    const source = athlete.id === selectedAthleteId ? state : byId.get(athlete.id) || {};
    return { id: athlete.id, full_name: athlete.full_name, ...snapshotOf(source) };
  });
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

function headerTitle() {
  if (role === "coach" && athletes.length > 1) {
    return `<label class="switch-label">Sprawdzany zawodnik
      <select class="athlete-switch" data-action="pick-athlete" aria-label="Sprawdzany zawodnik">
        ${athletes.map((athlete) => `<option value="${athlete.id}" ${athlete.id === selectedAthleteId ? "selected" : ""}>${esc(athlete.full_name)}</option>`).join("")}
      </select>
    </label>`;
  }
  const name = role === "coach" && selectedAthleteId
    ? athletes.find((item) => item.id === selectedAthleteId)?.full_name || "Dziennik dwuboju"
    : "Dziennik dwuboju";
  return `<strong>${esc(name)}</strong>`;
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
        ${headerTitle()}
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
  const parts = hash.split("/");
  const name = parts[0];
  const arg = parts[1];
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
  else if (name === "analiza") renderAnalysis(parts[1] || "tydzien", parts[2] || "");
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
    <section class="card">
      <h2>Konta testowe</h2>
      <p class="note">Można z nich korzystać od razu, bez potwierdzania e-maila.</p>
      <div class="demo-list">
        <div class="demo-account">
          <b>Trener Testowy</b>
          <code>trener.testowy@example.com</code>
          <span>Hasło: Trener1234</span>
          <button class="block" type="button" data-action="fill-demo" data-email="trener.testowy@example.com" data-password="Trener1234">Zaloguj jako trener</button>
        </div>
        <div class="demo-account">
          <b>Zawodnik Testowy</b>
          <code>zawodnik.testowy@example.com</code>
          <span>Hasło: Zawodnik1234</span>
          <button class="quiet block" type="button" data-action="fill-demo" data-email="zawodnik.testowy@example.com" data-password="Zawodnik1234">Zaloguj jako zawodnik</button>
        </div>
        <div class="demo-account">
          <b>Zawodniczka Testowa</b>
          <code>zawodniczka.testowa@example.com</code>
          <span>Hasło: Testowa1234</span>
          <button class="quiet block" type="button" data-action="fill-demo" data-email="zawodniczka.testowa@example.com" data-password="Testowa1234">Zaloguj jako drugiego zawodnika</button>
        </div>
      </div>
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
    ${inviteCard()}
    <button class="quiet block" type="button" data-action="refresh-account">Odśwież listę po dołączeniu zawodnika</button>
    <button class="quiet block" type="button" data-action="sign-out">Wyloguj</button>
  `, false);
}

function inviteCard() {
  if (!inviteCode) {
    return `<button class="block" type="button" data-action="create-invite">Nowe zaproszenie dla zawodnika</button>
      <p class="note">Kod jest jednorazowy i ważny przez 7 dni.</p>`;
  }
  return `<section class="card">
    <b>Kod zaproszenia</b>
    <p class="invite-code">${esc(inviteCode)}</p>
    <p class="note">Ważny 7 dni i działa jeden raz. Zostaje na tym ekranie, dopóki nie wygenerujesz nowego.</p>
    <button class="block" type="button" data-action="copy-invite">Kopiuj kod</button>
    <button class="quiet block" type="button" data-action="create-invite">Wygeneruj nowy kod</button>
  </section>`;
}

function renderPlanList() {
  const cards = state.microcycles.map((cycle) => `
    <a class="card" href="#plan/${cycle.id}" style="display:block;text-decoration:none;color:inherit">
      <b>${esc(weekSpan(cycle))}</b>
      <span class="note">okres ${cycle.periodNo}</span>
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
  shell("plan", `<h1>Plan</h1><p class="lead">Mikrocykl na siedem dni: serie, podniesienia i intensywność względem rekordu.</p>${cards}${form}`, true);
}

function renderPlan(id) {
  const cycle = state.microcycles.find((item) => item.id === id);
  if (!cycle) {
    shell("plan", `<p>Nie ma takiego mikrocyklu.</p>`, true);
    return;
  }
  const all = summarizePlan(cycle.days.flatMap((day) => day.exercises.map(planExerciseRow)));
  const firstOpen = cycle.days.find((day) => day.exercises.length);
  const missing = cycle.days.filter((day) => {
    const date = dayDate(cycle.startDate, day.dayIndex);
    const logged = state.sessions.some((session) => session.date === date && session.rows.length);
    return day.exercises.length && !logged;
  }).map((day) => DAY_GENITIVE[weekday(dayDate(cycle.startDate, day.dayIndex))]);
  const coverage = !cycle.days.some((day) => day.exercises.length)
    ? "W tym mikrocyklu nie ma jeszcze ćwiczeń w planie."
    : missing.length
      ? `W tym mikrocyklu brakuje ${joinDays(missing)}.`
      : "Wszystkie dni z planu mają wpis w dzienniku.";
  const days = cycle.days.map((day) => {
    const date = dayDate(cycle.startDate, day.dayIndex);
    const summary = summarizePlan(day.exercises.map(planExerciseRow));
    const existingSession = state.sessions.find((session) => session.date === date && session.rows.length)
      || state.sessions.find((session) => session.date === date);
    const realizedRows = state.sessions.filter((session) => session.date === date).flatMap((session) => session.rows);
    const realized = summarizeSession(realizedRows.map(diaryRow), 0, 0, 0, 0);
    const logged = realizedRows.length > 0;
    let realization = "Brak wpisu.";
    if (logged && day.exercises.length) {
      realization = `Wpisane: ${pl(realized.volume, 0)} podniesień zamiast ${pl(summary.volume, 0)} z planu.`;
    } else if (logged) {
      realization = `Wpisane: ${pl(realized.volume, 0)} podniesień.`;
    }
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
    const diaryLink = existingSession
      ? `<a class="button quiet block" href="#dziennik/${existingSession.id}">Otwórz wpis z dziennika</a>`
      : "";
    return `<details class="day" ${open}>
      <summary>${esc(weekday(date))} ${prettyDate(date)}<span>${esc(day.loadLevel || "bez poziomu")} · plan ${pl(summary.volume, 0)} podniesień · ${logged ? `wpisane ${pl(realized.volume, 0)}` : "brak wpisu"}</span></summary>
      <div class="day-body">
        <p class="day-print-title" hidden><b>${esc(weekday(date))} ${prettyDate(date)}</b></p>
        <p>${realization}</p>
        ${role === "coach" ? diaryLink : ""}
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
    </form>
    <form data-action="copy-cycle" class="card">
      <input type="hidden" name="cycleId" value="${cycle.id}">
      <label>Skopiuj ten mikrocykl</label>
      <select name="target">
        <option value="self">temu zawodnikowi, jako kolejny tydzień</option>
        ${athletes.filter((athlete) => athlete.id !== selectedAthleteId).map((athlete) => `<option value="${athlete.id}">do: ${esc(athlete.full_name)}</option>`).join("")}
      </select>
      <p class="note">Kopia dostaje kolejny numer mikrocyklu i start tydzień po ostatnim planie. U innego zawodnika rekordy dopasowują się po nazwie, na przykład „rwanie”.</p>
      <button class="block" type="submit">Skopiuj mikrocykl</button>
    </form>` : "";
  shell("plan", `
    <p><a href="#plan">Wszystkie mikrocykle</a></p>
    <h1>${esc(weekSpan(cycle))}</h1>
    <p class="lead">Okres ${cycle.periodNo}. ${esc(cycle.intensityNote || "")}</p>
    <p>${coverage}</p>
    <p class="no-print"><a class="button block" href="#druk/${cycle.id}">Pokaż plan do druku</a></p>
    <div class="stats">
      <div class="stat"><b>${pl(all.sets, 0)}</b><span>serie</span></div>
      <div class="stat"><b>${pl(all.volume, 0)}</b><span>podniesienia</span></div>
      <div class="stat"><b>${pct(all.avg_intensity)}</b><span>średnia intensywność</span></div>
      <div class="stat"><b>${pl(all.tonnage, 0)}</b><span>planowany tonaż</span></div>
    </div>
    ${notes}
    ${days}
    <datalist id="poziomy"><option value="małe"></option><option value="średnie"></option><option value="duże"></option><option value="regeneracja"></option></datalist>
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
    <p>${esc(weekSpan(cycle))}, okres ${cycle.periodNo}.</p>
    ${days}
    <button class="block no-print" type="button" onclick="window.print()">Drukuj albo zapisz jako PDF</button>
  `, false);
}

function sessionCard(session) {
  const summary = sessionSummary(session);
  return `<a class="card" href="#dziennik/${session.id}" style="display:block;text-decoration:none;color:inherit">
    <b>${prettyDate(session.date)}</b>
    <span class="note">mikrocykl ${session.periodNo}/${session.microNo} · ${esc(session.sessionType)}</span>
    <div>${pl(summary.tonnage, 0)} kg tonażu · ${pct(summary.avg_intensity)} · RPE-load ${pl(summary.srpe_load, 0)}${session.bodyKg ? ` · ${pl(session.bodyKg, 1)} kg` : ""}</div>
  </a>`;
}

function renderDiaryList() {
  const sorted = [...state.sessions].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const latest = sorted[0];
  const current = role === "coach" && latest
    ? sorted.filter((session) => session.periodNo === latest.periodNo && session.microNo === latest.microNo)
    : sorted;
  const older = role === "coach" ? sorted.filter((session) => !current.includes(session)) : [];
  const latestSummary = latest ? sessionSummary(latest) : null;
  const coachLead = latest
    ? `Ostatni wpis ${prettyDate(latest.date)}, tonaż ${pl(latestSummary.tonnage, 0)} kg. Poniżej jest bieżący mikrocykl ${latest.periodNo}/${latest.microNo}.`
    : "Dziennik jest pusty.";
  const cards = current.map(sessionCard).join("");
  const olderBlock = older.length
    ? `<details class="day"><summary>Wcześniejsze mikrocykle</summary><div class="day-body">${older.map(sessionCard).join("")}</div></details>`
    : "";
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
        <p class="note">${RPE_NOTE}</p>
        <label>Masa ciała (kg), jeśli mierzona tego dnia</label><input name="bodyKg" placeholder="np. 61,5">
        <button class="block" type="submit">Utwórz jednostkę</button>
      </form>
    </div></details>` : `<p class="note">Nowe wpisy dodaje zawodnik na swoim koncie.</p>`;
  const lead = role === "coach"
    ? coachLead
    : "Serie, podniesienia i kilogramy. Objętość, tonaż i intensywność liczą się same.";
  shell("dziennik", `<h1>Dziennik</h1><p class="lead">${lead}</p>${cards || "<p>Dziennik jest pusty.</p>"}${olderBlock}${form}`, true);
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
      <p class="note">${RPE_NOTE}</p>
      <label>Masa ciała (kg)</label><input name="bodyKg" value="${session.bodyKg ? pl(session.bodyKg, 1) : ""}" placeholder="zostaw puste, jeśli nie mierzono">
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
  ` : `<p class="note">Część specjalna ${pl(session.timeS, 0)} min, RPE ${pl(session.rpeS, 0)}. Uzupełniająca ${pl(session.timeW, 0)} min, RPE ${pl(session.rpeW, 0)}. ${session.bodyKg ? `Masa ciała ${pl(session.bodyKg, 1)} kg.` : "Masa ciała nie została wpisana."}</p>`;
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

function niceMax(values) {
  const present = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const max = present.length ? Math.max(...present) : 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = max / power;
  const nice = step <= 1 ? 1 : step <= 2 ? 2 : step <= 5 ? 5 : 10;
  return nice * power;
}

function chartAxis(value, mode) {
  if (mode === "pct") return `${Math.round(value * 100)}%`;
  if (mode === "ratio") return pl(value, value >= 10 ? 0 : 1);
  if (value >= 1000) return `${Math.round(value / 100) / 10} tys.`;
  return pl(value, value >= 100 ? 0 : 1);
}

function lineChart(series, mode, ceiling) {
  const labels = series[0]?.points.map((point) => point.label) || [];
  if (!labels.length) return `<p class="note">Brak danych do wykresu.</p>`;
  const left = 46;
  const right = 350;
  const top = 14;
  const bottom = 158;
  const max = ceiling || niceMax(series.flatMap((item) => item.points.map((point) => point.value)));
  const x = (index) => (labels.length === 1 ? (left + right) / 2 : left + ((right - left) * index) / (labels.length - 1));
  const y = (value) => bottom - ((bottom - top) * value) / max;
  const grid = [0, 0.5, 1].map((part) => {
    const yy = y(max * part).toFixed(1);
    return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" class="grid"></line><text x="2" y="${Number(yy) + 4}" class="axis">${esc(chartAxis(max * part, mode))}</text>`;
  }).join("");
  const drawn = series.map((item) => {
    const coords = item.points.map((point, index) => (
      point.value == null || Number.isNaN(Number(point.value)) ? null : [x(index), y(Number(point.value))]
    ));
    let path = "";
    let drawing = false;
    coords.forEach((coord) => {
      if (!coord) {
        drawing = false;
        return;
      }
      path += `${drawing ? "L" : "M"}${coord[0].toFixed(1)},${coord[1].toFixed(1)}`;
      drawing = true;
    });
    const dots = coords.map((coord) => (coord ? `<circle cx="${coord[0].toFixed(1)}" cy="${coord[1].toFixed(1)}" r="3.4" fill="${item.color}"></circle>` : "")).join("");
    return `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="2.4"></path>${dots}`;
  }).join("");
  const labelsSvg = labels.map((label, index) => `<text x="${x(index).toFixed(1)}" y="178" text-anchor="middle" class="axis">${esc(label)}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 360 196" role="img">${grid}${drawn}${labelsSvg}</svg>`;
}

function groupedBarChart(categories, series, mode, ceiling) {
  if (!categories.length) return `<p class="note">Brak danych do wykresu.</p>`;
  const left = 46;
  const right = 350;
  const top = 14;
  const bottom = 158;
  const max = ceiling || niceMax(series.flatMap((item) => item.values));
  const y = (value) => bottom - ((bottom - top) * Number(value || 0)) / max;
  const groupWidth = (right - left) / categories.length;
  const barWidth = Math.min(12, (groupWidth - 6) / series.length);
  const grid = [0, 0.5, 1].map((part) => {
    const yy = y(max * part).toFixed(1);
    return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" class="grid"></line><text x="2" y="${Number(yy) + 4}" class="axis">${esc(chartAxis(max * part, mode))}</text>`;
  }).join("");
  const bars = categories.map((label, index) => {
    const origin = left + groupWidth * index + (groupWidth - barWidth * series.length) / 2;
    const rects = series.map((item, seriesIndex) => {
      const value = Number(item.values[index]);
      if (!Number.isFinite(value) || value <= 0) return "";
      const yy = y(value);
      return `<rect x="${(origin + seriesIndex * barWidth).toFixed(1)}" y="${yy.toFixed(1)}" width="${barWidth - 1}" height="${(bottom - yy).toFixed(1)}" fill="${item.color}" rx="2"></rect>`;
    }).join("");
    return `${rects}<text x="${(left + groupWidth * index + groupWidth / 2).toFixed(1)}" y="176" text-anchor="middle" class="axis">${esc(label)}</text>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 360 192" role="img">${grid}${bars}</svg>`;
}

function chartLegend(items) {
  return `<p class="legend">${items.map((item) => `<span><i style="background:${item.color}"></i>${esc(item.name)}</span>`).join("")}</p>`;
}

function shortWeekday(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return ["nd", "pn", "wt", "śr", "cz", "pt", "sb"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function sideLoad(summary, present) {
  if (!present) return null;
  return {
    sets: summary.sets,
    lifts: summary.volume,
    intensity: summary.avg_intensity,
    tonnage: summary.tonnage,
  };
}

function weekdayLoad(cycle) {
  return cycle.days.map((day) => {
    const date = dayDate(cycle.startDate, day.dayIndex);
    const specialPlan = day.exercises.filter((exercise) => exercise.kind === "specjalne");
    const plannedAll = summarizePlan(day.exercises.map(planExerciseRow));
    const plannedSpecial = summarizePlan(specialPlan.map(planExerciseRow));
    const realized = state.sessions.filter((session) => session.date === date).flatMap((session) => session.rows);
    const realizedSpecial = realized.filter((row) => ["C1", "C2", "C3"].includes(row.complex));
    const all = summarizeSession(realized.map(diaryRow), 0, 0, 0, 0);
    const special = summarizeSession(realizedSpecial.map(diaryRow), 0, 0, 0, 0);
    const planSpecial = sideLoad(plannedSpecial, specialPlan.length > 0);
    const realSpecial = sideLoad(special, realizedSpecial.length > 0);
    return {
      label: shortWeekday(date),
      date,
      planIntensity: planSpecial ? planSpecial.intensity : null,
      realIntensity: realSpecial ? realSpecial.intensity : null,
      planLifts: day.exercises.length ? plannedAll.volume : null,
      realLifts: realized.length ? all.volume : null,
      planAll: sideLoad(plannedAll, day.exercises.length > 0),
      planSpecial,
      realAll: sideLoad(all, realized.length > 0),
      realSpecial,
    };
  });
}

function acwrSentence(value, name) {
  if (value == null || Number.isNaN(Number(value))) {
    return `${name}: potrzeba co najmniej pięciu mikrocykli z dziennika.`;
  }
  let meaning = "jest zbliżony do średniej z czterech poprzednich mikrocykli";
  if (value < 0.8) meaning = "jest wyraźnie lżejszy niż średnia z czterech poprzednich mikrocykli";
  else if (value > 1.3) meaning = "jest wyraźnie cięższy niż średnia z czterech poprzednich mikrocykli";
  return `${name} ${pl(value, 2)} — ${meaning}. Wartość 1 oznacza obciążenie równe tej średniej.`;
}

function changeSentence(current, previous) {
  if (!previous) return "To pierwszy mikrocykl z dziennika, nie ma jeszcze porównania z poprzednim.";
  const lifts = relativeChange(current.volume, previous.volume);
  const nowIntensity = current.overall?.avg_intensity;
  const previousIntensity = previous.overall?.avg_intensity;
  const parts = [];
  if (lifts != null) {
    const percent = Math.abs(Math.round(lifts * 100));
    parts.push(percent === 0
      ? "Liczba podniesień jest taka sama jak w poprzednim mikrocyklu."
      : `Podniesień jest o ${percent}% ${lifts < 0 ? "mniej" : "więcej"} niż w poprzednim mikrocyklu.`);
  }
  if (nowIntensity != null && previousIntensity != null) {
    parts.push(`Intensywność ${nowIntensity >= previousIntensity ? "wzrosła" : "spadła"} z ${pct(previousIntensity)} do ${pct(nowIntensity)}.`);
  }
  return parts.join(" ") || "Brak danych do porównania mikrocykli.";
}

function shareSentence(groups) {
  const total = groups.reduce((sum, group) => sum + (group.tonnage || 0), 0);
  if (!total) return "W tym mikrocyklu nie ma jeszcze tonażu w kompleksach C1–C5.";
  const part = (key) => groups.find((group) => group.key === key)?.tonnage || 0;
  const tech = part("C1-2") / total;
  const power = part("C3") / total;
  const strength = part("C4-5") / total;
  let phase = "Rozkład leży pomiędzy przygotowaniem a fazą startową opisaną w artykule.";
  if (tech >= 0.3) {
    phase = "Udział techniki jest bliższy fazie startowej z artykułu, gdzie C1–2 stanowiło około 31–33% tonażu.";
  } else if (strength >= 0.42) {
    phase = "Udział siły maksymalnej jest bliższy fazie przygotowania z artykułu, gdzie C4–5 stanowiło około 44–45% tonażu.";
  }
  return `Technika i szybkość (C1–2) to ${pct(tech)} tonażu nóg, ciągi (C3) ${pct(power)}, siła maksymalna (C4–5) ${pct(strength)}. ${phase}`;
}

function monotonySentence(value, subject) {
  if (value == null) return `Za mało dni z ${subject}, żeby policzyć monotonię.`;
  const tone = value >= 2
    ? "Dni są do siebie podobne, obciążenie jest rozłożone równo."
    : "Obciążenie skupia się w części dni, tydzień nie jest równy.";
  return `Monotonia ${subject} wynosi ${pl(value, 2)}. ${tone} Liczona jak w planie trenera: średnia z dni podzielona przez ich rozrzut.`;
}

function loadCell(side) {
  if (!side) return "—";
  return `${pl(side.sets, 0)} ser. · ${pl(side.lifts, 0)} podn. · ${pct(side.intensity)}`;
}

function liftShare(part, whole) {
  if (!part || !whole || !whole.lifts) return "—";
  return pct(part.lifts / whole.lifts);
}

function shareNote(part, whole) {
  const share = liftShare(part, whole);
  return share === "—" ? "" : `<div class="note">${share} całości</div>`;
}

function renderRoster() {
  if (role !== "coach" || !roster.length) return "";
  return `<section class="card">
    <b>Zawodnicy</b>
    <p class="note">Skrót z dzienników wszystkich podopiecznych. Wybranie osoby otwiera jej analizę.</p>
    <div class="roster">${roster.map((item) => `
      <button type="button" class="roster-card ${item.id === selectedAthleteId ? "here" : ""}" data-action="open-athlete" data-id="${item.id}">
        <b>${esc(item.full_name)}</b>
        <span>${item.tonnage != null ? `${pl(item.tonnage, 0)} kg tonażu ostatniego mikrocyklu` : "brak tonażu"}${item.acwr != null ? ` · ACWR ${pl(item.acwr, 2)}` : ""}</span>
        <span class="note">${esc(item.status)}</span>
      </button>`).join("")}</div>
  </section>`;
}

function shareText(part, whole) {
  const share = liftShare(part, whole);
  return share === "—" ? "" : ` Specjalne to ${share} podniesień tego dnia.`;
}

function dayCards(days) {
  return days.map((day) => {
    const title = `${weekday(day.date)} ${prettyDate(day.date)}`;
    if (!day.planAll && !day.realAll) {
      return `<section class="card"><b>${esc(title)}</b><p class="note">Brak planu i brak wpisu.</p></section>`;
    }
    return `<section class="card">
      <b>${esc(title)}</b>
      <p><b>Plan, specjalne.</b> ${loadCell(day.planSpecial)}.${shareText(day.planSpecial, day.planAll)}</p>
      <p><b>Plan, całość.</b> ${loadCell(day.planAll)}.</p>
      <p><b>Realizacja, specjalne.</b> ${loadCell(day.realSpecial)}.${shareText(day.realSpecial, day.realAll)}</p>
      <p><b>Realizacja, całość.</b> ${loadCell(day.realAll)}.</p>
    </section>`;
  }).join("");
}

function radarChart(rows) {
  const plotted = rows.filter((row) => row.actual != null);
  if (plotted.length < 3) {
    return `<p class="note">Wpisz przysiad tył i co najmniej dwa inne boje, żeby narysować profil.</p>`;
  }
  const centerX = 160;
  const centerY = 150;
  const radius = 96;
  const ceiling = 1.2;
  const point = (index, value) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / plotted.length;
    const length = radius * Math.min(value, ceiling) / ceiling;
    return [centerX + length * Math.cos(angle), centerY + length * Math.sin(angle)];
  };
  const polygon = (key) => plotted.map((row, index) => point(index, row[key] || 0).map((coord) => coord.toFixed(1)).join(",")).join(" ");
  const rings = [0.5, 0.8, 1].map((level) => `<polygon points="${plotted.map((_, index) => point(index, level).map((coord) => coord.toFixed(1)).join(",")).join(" ")}" fill="none" class="grid"></polygon>`).join("");
  const labels = plotted.map((row, index) => {
    const [x, y] = point(index, 1.32);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" class="axis">${esc(row.short)}</text>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 320 300" role="img">${rings}
    <polygon points="${polygon("ref")}" fill="rgba(208,137,58,0.28)" stroke="#d0893a" stroke-width="2"></polygon>
    <polygon points="${polygon("actual")}" fill="rgba(15,110,110,0.28)" stroke="#0f6e6e" stroke-width="2"></polygon>
    ${labels}</svg>`;
}

function teiSentence(profile) {
  if (!(profile.squat > 0)) {
    return "Wpisz przysiad tył w zakładce Więcej. Pozostałe boje porównują się do niego, tak jak w arkuszu TEI.";
  }
  const gaps = profile.rows.filter((row) => row.key !== "BS" && row.actual != null && row.ref);
  if (!gaps.length) return "Profil liczy się jako procent przysiadu tyłem. Dopisz kolejne boje, żeby zobaczyć odchylenie od wzorca.";
  const widest = gaps.reduce((best, row) => (
    Math.abs(row.actual - row.ref) > Math.abs(best.actual - best.ref) ? row : best
  ));
  const diff = (widest.actual - widest.ref) * 100;
  const direction = diff >= 0 ? "wyżej" : "niżej";
  return `${widest.label} to ${pct(widest.actual)} przysiadu, wzorzec to ${pct(widest.ref)}. Jest o ${pl(Math.abs(diff), 0)} punktów procentowych ${direction} wzorca.`;
}

function meetScore(meet) {
  const total = num(meet.snatch) + num(meet.cleanJerk);
  return {
    total,
    sinclair: sinclairTotal(total, meet.bodyKg, state.sex),
    points: qPoints(total, meet.bodyKg),
  };
}

function competitionSection() {
  const meets = [...(state.competitions || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!meets.length) {
    return `<section class="card"><b>Starty</b><p class="note">Startów jeszcze nie wpisano. Trener dodaje je w zakładce Więcej: data, zawody, masa ciała, rwanie i podrzut. Sinclair i q-points liczą się same.</p></section>`;
  }
  const scored = meets.map((meet) => ({ meet, ...meetScore(meet) }));
  const best = Math.max(...scored.map((item) => item.total));
  const last = scored.at(-1);
  const previous = scored.length > 1 ? scored.at(-2) : null;
  const progress = [];
  if (previous && previous.total) {
    const change = last.total / previous.total - 1;
    progress.push(`Wobec poprzedniego startu dwubój jest ${change >= 0 ? "wyższy" : "niższy"} o ${pct(Math.abs(change))}.`);
  }
  if (best && last.total >= best) progress.push(`Ostatni start, ${pl(last.total, 0)} kg, jest najlepszym wpisanym wynikiem.`);
  else if (best) progress.push(`Do najlepszego wpisanego wyniku (${pl(best, 0)} kg) brakuje ${pl(best - last.total, 0)} kg.`);
  const sexNote = state.sex === "K" || state.sex === "M"
    ? "Sinclair używa współczynników IWF 2025–2028."
    : "Ustaw płeć w zakładce Więcej, żeby policzyć Sinclaira. q-points liczą się wzorem z dziennika trenera.";
  const rows = scored.map((item) => `<tr>
    <td>${prettyDate(item.meet.date)}<div class="note">${esc(item.meet.name || "")}</div></td>
    <td>${pl(item.meet.snatch, 0)} + ${pl(item.meet.cleanJerk, 0)}</td>
    <td>${pl(item.total, 0)} kg</td>
    <td>${item.sinclair != null ? pl(item.sinclair, 1) : "—"}</td>
    <td>${item.points != null ? pl(item.points, 1) : "—"}</td>
  </tr>`).join("");
  const goal = [...(state.goals || [])].sort((a, b) => Number(b.year) - Number(a.year))[0];
  let goalText = "Celu rocznego jeszcze nie wpisano. Trener dodaje go w zakładce Więcej.";
  if (goal) {
    const goalTotal = num(goal.snatch) + num(goal.cleanJerk);
    const gap = goalTotal - best;
    goalText = `Cel na ${esc(goal.year)}: rwanie ${pl(goal.snatch, 0)} kg, podrzut ${pl(goal.cleanJerk, 0)} kg, dwubój ${pl(goalTotal, 0)} kg. ${gap > 0 ? `Do dwuboju brakuje ${pl(gap, 0)} kg.` : "Najlepszy wpisany start osiąga ten dwubój."}`;
  }
  return `<section class="card">
    <b>Starty i cel</b>
    <p class="note">${esc(progress.join(" "))} ${esc(sexNote)}</p>
    <p>${goalText}</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Start</th><th>Boje</th><th>Dwubój</th><th>Sinclair</th><th>q-points</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function cycleLabel(key) {
  const [periodNo, microNo] = String(key).split("-").map(Number);
  const cycle = state.microcycles.find((item) => item.periodNo === periodNo && item.microNo === microNo);
  return cycle ? `${weekSpan(cycle)}, okres ${cycle.periodNo}` : key;
}

function analysisTabs(section, chosen) {
  const items = [
    ["tydzien", "Ten tydzień"],
    ["mikrocykle", "Mikrocykle"],
    ["start", "Start i profil"],
  ];
  return `<nav class="tabs">${items.map(([id, label]) => {
    const suffix = id === "start" || !chosen ? "" : `/${chosen}`;
    return `<a href="#analiza/${id}${suffix}" class="${section === id ? "here" : ""}">${label}</a>`;
  }).join("")}</nav>`;
}

function renderAnalysis(section, microKey) {
  const tabs = ["tydzien", "mikrocykle", "start"];
  if (section && !tabs.includes(section)) {
    microKey = section;
    section = "tydzien";
  }
  if (!tabs.includes(section)) section = "tydzien";
  const { microcycles, article } = analysisModel();
  const keys = microcycles.map((item) => `${item.period_no}-${item.micro_no}`);
  state.microcycles.forEach((cycle) => {
    const key = `${cycle.periodNo}-${cycle.microNo}`;
    if (!keys.includes(key)) keys.push(key);
  });
  keys.sort();
  const chosen = keys.includes(microKey) ? microKey : keys[keys.length - 1];
  const labels = article.map((item) => {
    const cycle = state.microcycles.find((entry) => entry.periodNo === item.period_no && entry.microNo === item.micro_no);
    return cycle ? shortDate(cycle.startDate) : `${item.period_no}.${item.micro_no}`;
  });
  const latest = article[article.length - 1];
  const chosenArticle = article.find((item) => `${item.period_no}-${item.micro_no}` === chosen) || null;
  const previousArticle = chosenArticle ? article[article.indexOf(chosenArticle) - 1] : null;
  const kpis = latest ? `
    <div class="stats">
      <div class="stat"><b>${pl(latest.tonnage, 0)} kg</b><span>tonaż ostatniego mikrocyklu</span></div>
      <div class="stat"><b>${pl(latest.volume, 0)}</b><span>podniesienia</span></div>
      <div class="stat"><b>${pl(latest.avg_load, 1)} kg</b><span>średnie obciążenie</span></div>
      <div class="stat"><b>${pl(latest.acwr_tonnage, 2)}</b><span>ACWR tonażu</span></div>
    </div>
    <p class="note">${esc(changeSentence(chosenArticle || latest, chosenArticle ? previousArticle : article[article.length - 2]))}</p>` : "";
  const tonnageChart = article.length ? `<section class="card chart-card"><b>Tonaż mikrocykli</b><p class="note">Suma kilogramów zrealizowanych w mikrocyklu, jak w arkuszu mikrocykli.</p>${lineChart([{ color: "#0f6e6e", points: article.map((item, index) => ({ label: labels[index], value: item.tonnage })) }], "kg")}</section>` : "";
  const volumeChart = article.length ? `<section class="card chart-card"><b>Liczba podniesień</b><p class="note">Objętość kolejnych mikrocykli.</p>${lineChart([{ color: "#0a4f4f", points: article.map((item, index) => ({ label: labels[index], value: item.volume })) }], "count")}</section>` : "";
  const acwrChart = article.length ? `<section class="card chart-card"><b>ACWR</b><p class="note">Bieżący mikrocykl podzielony przez średnią z czterech poprzednich. Linia pojawia się od piątego mikrocyklu.</p>${lineChart([
    { color: "#0f6e6e", points: article.map((item, index) => ({ label: labels[index], value: item.acwr_tonnage })) },
    { color: "#8d3b3b", points: article.map((item, index) => ({ label: labels[index], value: item.acwr_rpe })) },
  ], "ratio", Math.max(1.5, niceMax(article.flatMap((item) => [item.acwr_tonnage, item.acwr_rpe]))))}${chartLegend([{ color: "#0f6e6e", name: "tonaż" }, { color: "#8d3b3b", name: "RPE-load" }])}
    <p class="note">${esc(acwrSentence((chosenArticle || latest).acwr_tonnage, "Tonaż"))}</p>
    <p class="note">${esc(acwrSentence((chosenArticle || latest).acwr_rpe, "RPE-load"))}</p></section>` : "";
  const complexChart = chosenArticle ? `<section class="card chart-card"><b>Tonaż kompleksów</b><p class="note">Okres ${chosenArticle.period_no}, mikrocykl ${chosenArticle.micro_no}. Grupy jak w monitorowaniu z artykułu: C1–2 technika i szybkość, C3 moc, C4–5 siła maksymalna nóg.</p>${groupedBarChart(
    ["C1–2", "C3", "C4–5"],
    [{ color: "#0f6e6e", values: chosenArticle.groups.map((group) => group.tonnage) }],
    "kg",
  )}<p class="note">${esc(shareSentence(chosenArticle.groups))}</p></section>` : `<section class="card"><b>Tonaż kompleksów</b><p class="note">Dla wybranego mikrocyklu nie ma jeszcze wpisów w dzienniku.</p></section>`;
  let weekCharts = "";
  if (chosen) {
    const [periodNo, microNo] = chosen.split("-").map(Number);
    const cycle = state.microcycles.find((item) => item.periodNo === periodNo && item.microNo === microNo);
    if (cycle) {
      const days = weekdayLoad(cycle);
      const dayLabels = days.map((day) => day.label);
      const realizedTonnage = days.map((day) => (day.realAll ? day.realAll.tonnage : null));
      const plannedLifts = days.map((day) => (day.planSpecial ? day.planSpecial.lifts : null));
      const mono = monotony(realizedTonnage) != null
        ? monotonySentence(monotony(realizedTonnage), "tonaży zrealizowanych dni")
        : monotonySentence(monotony(plannedLifts), "podniesień specjalnych w planie");
      weekCharts = `
        <section class="card chart-card">
          <b>Intensywność środków specjalnych</b>
          <p class="note">Średnia ważona objętością, dzień po dniu. W planie liczone są ćwiczenia specjalne, w realizacji kompleksy C1–C3.</p>
          ${groupedBarChart(dayLabels, [
            { color: "#d0893a", values: days.map((day) => day.planIntensity) },
            { color: "#0f6e6e", values: days.map((day) => day.realIntensity) },
          ], "pct", 1)}
          ${chartLegend([{ color: "#d0893a", name: "plan" }, { color: "#0f6e6e", name: "realizacja" }])}
        </section>
        <section class="card chart-card">
          <b>Liczba podniesień w dniach</b>
          <p class="note">Całe obciążenie dnia, tak jak wykres „analiza obciążenia” w planie tygodnia.</p>
          ${groupedBarChart(dayLabels, [
            { color: "#d0893a", values: days.map((day) => day.planLifts) },
            { color: "#0f6e6e", values: days.map((day) => day.realLifts) },
          ], "count")}
          ${chartLegend([{ color: "#d0893a", name: "plan" }, { color: "#0f6e6e", name: "realizacja" }])}
        </section>
        <section class="card">
          <b>Dni tygodnia</b>
          <p class="note">Każdy dzień osobno: plan i realizacja, część specjalna i całość. Przy części specjalnej widać, jaki procent podniesień dnia ona stanowi.</p>
          <p class="note">${esc(mono)}</p>
        </section>
        ${dayCards(days)}`;
    } else {
      weekCharts = `<p>Dla mikrocyklu ${esc(chosen)} nie ma planu trenera. Tabela dnia powstaje z planu tygodnia.</p>`;
    }
  }
  const masses = [...state.sessions]
    .filter((session) => optionalNumber(session.bodyKg))
    .sort((a, b) => a.date.localeCompare(b.date));
  const bodyChart = `<section class="card chart-card"><b>Masa ciała</b><p class="note">${masses.length
    ? `Ostatni wpis: ${pl(masses.at(-1).bodyKg, 1)} kg w dniu ${prettyDate(masses.at(-1).date)}. W artykule duży spadek masy osłabiał moc i wynik mimo sensownego treningu.`
    : "Zawodnik wpisuje masę ciała przy jednostce treningowej. Linia pokaże, czy masa spada razem z obciążeniem."}</p>${masses.length ? lineChart([{ color: "#0f6e6e", points: masses.map((session) => ({ label: prettyDate(session.date).slice(0, 5), value: session.bodyKg })) }], "kg") : ""}</section>`;
  const profile = teiProfile(state.tei || {});
  const teiBlock = `<section class="card chart-card"><b>Profil techniczny</b><p class="note">${esc(teiSentence(profile))} Pomarańcz to wzorzec z arkusza, zieleń to wynik zawodnika jako procent przysiadu tyłem.</p>${radarChart(profile.rows)}${profile.rows.length >= 3 ? chartLegend([{ color: "#d0893a", name: "wzorzec" }, { color: "#0f6e6e", name: "zawodnik" }]) : ""}</section>`;
  const select = keys.length ? `<label>Tydzień</label><select data-action="pick-micro" data-section="${section}">${keys.map((key) => `<option value="${esc(key)}" ${key === chosen ? "selected" : ""}>${esc(cycleLabel(key))}</option>`).join("")}</select>` : "";
  const leads = {
    tydzien: "Intensywność, podniesienia i dni wybranego tygodnia. Liczone z planu i z dziennika.",
    mikrocykle: "Tonaż, podniesienia, ACWR i udział kompleksów w kolejnych mikrocyklach.",
    start: "Masa ciała, profil techniczny, starty i cel roczny.",
  };
  const body = {
    tydzien: `${select}${weekCharts}`,
    mikrocykle: `${kpis}${tonnageChart}${volumeChart}${acwrChart}${select}${complexChart}`,
    start: `${bodyChart}${teiBlock}${competitionSection()}`,
  }[section];
  shell("analiza", `
    <h1>Analiza</h1>
    <p class="lead">${leads[section]}</p>
    ${renderRoster()}
    ${analysisTabs(section, chosen)}
    ${body}
    ${article.length || state.microcycles.length ? "" : "<p>Brak planu i dziennika.</p>"}
    <button class="block no-print" type="button" data-action="export-excel">Pobierz Excel</button>
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
  const account = role === "coach" ? `
    <label>Otwarty zawodnik</label>
    <select data-action="pick-athlete">
      ${athletes.map((athlete) => `<option value="${athlete.id}" ${athlete.id === selectedAthleteId ? "selected" : ""}>${esc(athlete.full_name)}</option>`).join("")}
    </select>
    ${inviteCard()}
  ` : `
    <h2>Połącz z trenerem</h2>
    <form data-action="claim-invite" class="card">
      <label>Jednorazowy kod od trenera</label>
      <input name="code" required autocapitalize="characters">
      <button class="block" type="submit">Przypisz trenera</button>
    </form>
  `;
  const reset = role === "coach" ? `
    <details class="day"><summary>Przykładowe dane</summary><div class="day-body">
      <p class="note">Przywrócenie przykładu kasuje plan i dziennik tego zawodnika.</p>
      <button class="danger block" type="button" data-action="reset">Przywróć przykład temu zawodnikowi</button>
    </div></details>` : "";
  shell("wiecej", `
    <h1>Więcej</h1>
    <p class="lead">${esc(profile?.full_name || "")} · ${esc(currentUser?.email || "")}</p>
    <h2>Życiówki</h2>
    <p class="note">Rekordy z tej listy liczą procent obciążenia w planie i w dzienniku. Wpis treningu zachowuje rekord z chwili wpisu. Profil techniczny pod spodem jest tylko do radaru i nie zmienia tych procentów.</p>
    ${records}${add}
    ${renderAthleteProfile()}
    <h2>Konto</h2>
    ${account}
    <button class="block" type="button" data-action="export-excel">Pobierz Excel</button>
    <p class="note">Skoroszyt zawiera rekordy, plan, dziennik, mikrocykle, kompleksy, plan i realizację, masę ciała, starty, cele oraz profil.</p>
    <button class="quiet block" type="button" data-action="export">Pobierz kopię danych</button>
    <label>Odtwórz z pliku</label>
    <input id="import-file" type="file" accept="application/json,.json">
    <p class="note">Na co dzień dane synchronizują się automatycznie. Plik jest tylko kopią awaryjną.</p>
    <button class="quiet block" type="button" data-action="reload-cloud">Pobierz najnowsze dane</button>
    <button class="quiet block" type="button" data-action="sign-out">Wyloguj</button>
    ${reset}
  `, true);
}

const RECORD_MATCH = {
  BS: ["przysiad", "przysiad tył", "przysiad tyl"],
  FS: ["przysiad przód", "przysiad przod"],
  SN: ["rwanie"],
  PSN: ["rwanie siłowe", "rwanie silowe"],
  CnJ: ["dwubój", "dwuboj"],
  C: ["zarzut"],
  J: ["podrzut"],
  PC: ["zarzut siłowy", "zarzut silowy"],
};

function matchingRecord(key) {
  const names = RECORD_MATCH[key] || [];
  return state.records.find((record) => names.includes(String(record.name || "").trim().toLowerCase()));
}

function renderAthleteProfile() {
  ensureShape(state);
  const locked = role !== "coach";
  const lifts = TEI_LIFTS.map(([key, label, , ref]) => {
    const record = matchingRecord(key);
    const hint = record
      ? `<p class="note">W planie „${esc(record.name)}” ma ${pl(record.maxKg, 0)} kg i liczy procenty treningu. Radar używa liczby z tego pola.</p>${locked ? "" : `<button class="quiet block" type="button" data-action="use-record" data-key="${key}" data-kg="${record.maxKg}">Użyj ${pl(record.maxKg, 0)} kg z planu</button>`}`
      : `<p class="note">Ta liczba jest tylko do radaru.</p>`;
    return `<label>${esc(label)}${key === "BS" ? " — punkt odniesienia radaru" : `, wzorzec ${pct(ref)}`}</label>
      <input name="${key}" value="${state.tei[key] ? pl(state.tei[key], 1) : ""}" ${locked ? "readonly" : ""} placeholder="kg">${hint}`;
  }).join("");
  const goals = (state.goals || []).map((goal) => `
    <div class="ex"><b>${esc(goal.year)}</b>
      <div>rwanie ${pl(goal.snatch, 0)} kg, podrzut ${pl(goal.cleanJerk, 0)} kg, dwubój ${pl(num(goal.snatch) + num(goal.cleanJerk), 0)} kg</div>
      ${locked ? "" : `<button class="danger" type="button" data-action="delete-goal" data-id="${goal.id}">Usuń</button>`}
    </div>`).join("");
  const meets = [...(state.competitions || [])].sort((a, b) => String(b.date).localeCompare(String(a.date))).map((meet) => `
    <div class="ex"><b>${prettyDate(meet.date)} ${esc(meet.name || "")}</b>
      <div>rwanie ${pl(meet.snatch, 0)} kg, podrzut ${pl(meet.cleanJerk, 0)} kg, masa ${pl(meet.bodyKg, 1)} kg</div>
      ${locked ? "" : `<button class="danger" type="button" data-action="delete-meet" data-id="${meet.id}">Usuń</button>`}
    </div>`).join("");
  const editor = locked ? `
    <p class="note">Te dane uzupełnia trener. Ty wpisujesz dziennik i masę ciała przy treningu.</p>
    <b>Profil techniczny, do radaru</b>
    ${lifts}
    <h2>Starty i cel</h2>
    ${goals || "<p class=\"note\">Brak celu rocznego.</p>"}${meets || "<p class=\"note\">Brak startów.</p>"}` : `
    <form data-action="save-profile" class="card">
      <label>Płeć do Sinclaira</label>
      <select name="sex">
        <option value="" ${state.sex ? "" : "selected"}>nie ustawiono</option>
        <option value="K" ${state.sex === "K" ? "selected" : ""}>kobieta</option>
        <option value="M" ${state.sex === "M" ? "selected" : ""}>mężczyzna</option>
      </select>
      <p class="note">Sinclair używa współczynników IWF na lata 2025–2028. q-points liczą się wzorem z dziennika trenera.</p>
      <b>Profil techniczny, do radaru</b>
      <p class="note">Każdy bój dzieli się przez przysiad tył i porównuje ze wzorcem z arkusza TEI. Te kilogramy nie zmieniają procentów w planie.</p>
      ${lifts}
      <button class="block" type="submit">Zapisz płeć i profil</button>
    </form>
    <h2>Starty i cel</h2>
    <form data-action="add-goal" class="card">
      <label>Cel roczny</label>
      <label>Rok</label><input name="year" type="number" min="2000" value="2026" required>
      <label>Rwanie (kg)</label><input name="snatch" required placeholder="101">
      <label>Podrzut (kg)</label><input name="cleanJerk" required placeholder="121">
      <p class="note">Dwubój to suma rwania i podrzutu.</p>
      <button class="block" type="submit">Dodaj cel</button>
    </form>
    ${goals}
    <form data-action="add-meet" class="card">
      <label>Nowy start</label>
      <label>Data</label><input name="date" type="date" required>
      <label>Zawody</label><input name="name" placeholder="np. MP">
      <label>Masa ciała (kg)</label><input name="bodyKg" required placeholder="61,5">
      <label>Rwanie (kg)</label><input name="snatch" required>
      <label>Podrzut (kg)</label><input name="cleanJerk" required>
      <button class="block" type="submit">Dodaj start</button>
    </form>
    ${meets}`;
  return editor;
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
  } else if (action === "fill-demo") {
    const form = document.querySelector('form[data-action="sign-in"]');
    if (!form) return;
    form.elements.email.value = target.dataset.email;
    form.elements.password.value = target.dataset.password;
    form.requestSubmit();
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
    inviteCode = String(data);
    message = "Kod zostaje na ekranie. Możesz go skopiować.";
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
  } else if (action === "export-excel") {
    exportExcel();
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
  } else if (action === "delete-goal") {
    state.goals = (state.goals || []).filter((item) => item.id !== Number(target.dataset.id));
    save();
    render();
  } else if (action === "delete-meet") {
    state.competitions = (state.competitions || []).filter((item) => item.id !== Number(target.dataset.id));
    save();
    render();
  } else if (action === "copy-invite") {
    try {
      await navigator.clipboard.writeText(inviteCode);
      message = "Kod skopiowany. Możesz go wysłać zawodnikowi.";
    } catch (_error) {
      message = "Zaznacz kod na ekranie i skopiuj go ręcznie.";
    }
    render();
  } else if (action === "use-record") {
    if (role !== "coach") return;
    ensureShape(state);
    state.tei[target.dataset.key] = num(target.dataset.kg);
    save();
    message = "Przeniesiono rekord planu do profilu technicznego.";
    render();
  } else if (action === "open-athlete") {
    try {
      await loadAthleteData(target.dataset.id);
      const current = roster.find((item) => item.id === target.dataset.id);
      if (current) Object.assign(current, snapshotOf(state));
      const section = ["tydzien", "mikrocykle", "start"].includes(location.hash.split("/")[1])
        ? location.hash.split("/")[1]
        : "tydzien";
      location.hash = `#analiza/${section}`;
      render();
    } catch (error) {
      showError(error);
    }
  }
});

document.addEventListener("change", (event) => {
  if (event.target.dataset.action === "pick-micro") {
    const section = event.target.dataset.section || "tydzien";
    location.hash = `#analiza/${section}/${event.target.value}`;
  }
  if (event.target.id === "import-file" && event.target.files[0]) {
    importFile(event.target.files[0]);
  }
  if (event.target.dataset.action === "pick-athlete") {
    const nextHash = screenAfterAthleteSwitch();
    loadAthleteData(event.target.value)
      .then(() => {
        location.hash = nextHash;
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
    if (form.dataset.action === "copy-cycle" && data.target !== "self") {
      await copyCycleToAthlete(Number(data.cycleId), data.target);
      render();
      return;
    }
    handleSubmit(form.dataset.action === "copy-cycle" ? "copy-cycle-self" : form.dataset.action, data);
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
      bodyKg: optionalNumber(data.bodyKg),
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
      bodyKg: optionalNumber(data.bodyKg),
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
  } else if (action === "copy-cycle-self") {
    if (role !== "coach") return;
    const source = state.microcycles.find((item) => item.id === Number(data.cycleId));
    if (!source) throw new Error("Nie ma takiego mikrocyklu.");
    const copy = cloneCycle(source);
    const samePeriod = state.microcycles.filter((item) => item.periodNo === source.periodNo);
    copy.microNo = Math.max(...samePeriod.map((item) => Number(item.microNo) || 0)) + 1;
    const latest = state.microcycles.map((item) => item.startDate).filter(Boolean).sort().at(-1);
    copy.startDate = latest ? isoAdd(latest, 7) : source.startDate;
    state.microcycles.push(copy);
    message = `Dodano kopię jako mikrocykl ${copy.microNo}, od ${prettyDate(copy.startDate)}.`;
    location.hash = `#plan/${copy.id}`;
  } else if (action === "save-profile") {
    if (role !== "coach") return;
    ensureShape(state);
    state.sex = data.sex === "K" || data.sex === "M" ? data.sex : "";
    TEI_LIFTS.forEach(([key]) => {
      const value = optionalNumber(data[key]);
      if (value) state.tei[key] = value;
      else delete state.tei[key];
    });
    message = "Zapisano płeć i profil techniczny.";
  } else if (action === "add-goal") {
    if (role !== "coach") return;
    ensureShape(state);
    state.goals.push({
      id: nextId(),
      year: Number(data.year),
      snatch: num(data.snatch),
      cleanJerk: num(data.cleanJerk),
    });
    message = "Dodano cel roczny.";
  } else if (action === "add-meet") {
    if (role !== "coach") return;
    ensureShape(state);
    state.competitions.push({
      id: nextId(),
      date: data.date,
      name: data.name.trim(),
      bodyKg: num(data.bodyKg),
      snatch: num(data.snatch),
      cleanJerk: num(data.cleanJerk),
    });
    message = "Dodano start.";
  }
}

function cloneCycle(source) {
  return {
    id: nextId(),
    periodNo: source.periodNo,
    microNo: source.microNo,
    startDate: source.startDate,
    intensityNote: source.intensityNote || "",
    volumeNote: source.volumeNote || "",
    days: (source.days || []).map((day) => ({
      id: nextId(),
      dayIndex: day.dayIndex,
      loadLevel: day.loadLevel || "",
      note: day.note || "",
      exercises: (day.exercises || []).map((exercise) => ({
        ...exercise,
        id: nextId(),
      })),
    })),
  };
}

async function copyCycleToAthlete(cycleId, athleteId) {
  const source = state.microcycles.find((item) => item.id === cycleId);
  if (!source) throw new Error("Nie ma takiego mikrocyklu.");
  const { data, error } = await supabaseClient
    .from("athlete_data")
    .select("data, revision")
    .eq("athlete_id", athleteId)
    .single();
  if (error) throw error;
  const target = data.data && Array.isArray(data.data.records)
    ? data.data
    : { seq: 0, records: [], microcycles: [], sessions: [] };
  ensureShape(target);
  if (!Array.isArray(target.microcycles)) target.microcycles = [];
  if (!Array.isArray(target.records)) target.records = [];
  let seq = Number(target.seq) || 0;
  const nid = () => {
    seq += 1;
    return seq;
  };
  const byName = new Map(target.records.map((record) => [String(record.name || "").trim().toLowerCase(), record.id]));
  const samePeriod = target.microcycles.filter((item) => item.periodNo === source.periodNo);
  const microNo = samePeriod.length
    ? Math.max(...samePeriod.map((item) => Number(item.microNo) || 0)) + 1
    : source.microNo;
  const latest = target.microcycles.map((item) => item.startDate).filter(Boolean).sort().at(-1);
  const startDate = latest ? isoAdd(latest, 7) : source.startDate;
  target.microcycles.push({
    id: nid(),
    periodNo: source.periodNo,
    microNo,
    startDate,
    intensityNote: source.intensityNote || "",
    volumeNote: source.volumeNote || "",
    days: (source.days || []).map((day) => ({
      id: nid(),
      dayIndex: day.dayIndex,
      loadLevel: day.loadLevel || "",
      note: day.note || "",
      exercises: (day.exercises || []).map((exercise) => {
        const record = recordById(exercise.recordId);
        return {
          id: nid(),
          name: exercise.name,
          complex: exercise.complex,
          kind: exercise.kind,
          setsText: exercise.setsText,
          repsText: exercise.repsText,
          intensity: exercise.intensity,
          recordId: record ? byName.get(record.name.trim().toLowerCase()) || null : null,
        };
      }),
    })),
  });
  target.seq = seq;
  const updated = await supabaseClient
    .from("athlete_data")
    .update({
      data: target,
      revision: data.revision + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("athlete_id", athleteId)
    .eq("revision", data.revision)
    .select("revision")
    .single();
  if (updated.error) throw new Error("Nie udało się skopiować. Otwórz tego zawodnika i spróbuj ponownie.");
  const name = athletes.find((item) => item.id === athleteId)?.full_name || "zawodnika";
  message = `Skopiowano mikrocykl do ${name}. Rekordy dopasowano po nazwie. Początek ustawiono na ${prettyDate(startDate)}.`;
  await loadRoster();
}

function athleteFileStem() {
  const athlete = role === "coach"
    ? athletes.find((item) => item.id === selectedAthleteId)?.full_name
    : profile?.full_name;
  const safe = String(athlete || "zawodnik").replace(/[\\/:*?"<>|]+/g, "").trim() || "zawodnik";
  return `dziennik-${safe}`;
}

function sheetNumber(value, digits = 2) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return "";
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function safeCount(value) {
  try {
    return parseCount(value);
  } catch (error) {
    return 0;
  }
}

async function downloadBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

function addSheet(workbook, name, rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows.length ? rows : [["Brak danych"]]);
  sheet["!cols"] = (rows[0] || []).map((header) => ({ wch: Math.min(36, Math.max(12, String(header).length + 2)) }));
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function exportExcel() {
  if (!window.XLSX) {
    message = "Biblioteka Excela nie została wczytana. Odśwież stronę.";
    render();
    return;
  }
  const records = [["Ćwiczenie", "Rekord (kg)"]];
  state.records.forEach((record) => {
    records.push([record.name, sheetNumber(record.maxKg, 1)]);
  });

  const plan = [[
    "Okres", "Mikrocykl", "Początek", "Dzień", "Data", "Poziom obciążenia", "Notatka dnia",
    "Ćwiczenie", "Kompleks", "Rodzaj", "Serie", "Podniesienia", "Intensywność",
    "Rekord", "Rekord (kg)", "Planowane kg", "Objętość", "Tonaż (kg)",
  ]];
  state.microcycles.forEach((cycle) => {
    cycle.days.forEach((day) => {
      const date = dayDate(cycle.startDate, day.dayIndex);
      const exercises = day.exercises.length ? day.exercises : [null];
      exercises.forEach((exercise) => {
        const record = exercise ? recordById(exercise.recordId) : null;
        const sets = exercise ? safeCount(exercise.setsText) : "";
        const reps = exercise ? safeCount(exercise.repsText) : "";
        const volume = exercise ? sets * reps : "";
        const plannedKg = exercise && exercise.intensity != null && record ? exercise.intensity * record.maxKg : "";
        const tonnage = plannedKg !== "" && volume !== "" ? volume * plannedKg : "";
        plan.push([
          cycle.periodNo,
          cycle.microNo,
          cycle.startDate,
          weekday(date),
          date,
          day.loadLevel || "",
          day.note || "",
          exercise ? exercise.name : "",
          exercise ? (COMPLEXES[exercise.complex] || exercise.complex) : "",
          exercise ? exercise.kind : "",
          exercise ? exercise.setsText : "",
          exercise ? exercise.repsText : "",
          exercise ? sheetNumber(exercise.intensity, 2) : "",
          record ? record.name : "",
          record ? sheetNumber(record.maxKg, 1) : "",
          sheetNumber(plannedKg, 1),
          volume,
          sheetNumber(tonnage, 1),
        ]);
      });
    });
  });

  const diary = [[
    "Data", "Okres", "Mikrocykl", "Nr treningu", "Rodzaj", "Masa ciała (kg)",
    "Czas specjalny (min)", "RPE specjalne", "Czas uzupełniający (min)", "RPE uzupełniające", "sRPE-load",
    "Ćwiczenie", "Kompleks", "Serie", "Podniesienia", "Obciążenie (kg)", "Rekord", "Rekord (kg)",
    "Objętość", "Tonaż (kg)", "Intensywność",
  ]];
  [...state.sessions].sort((a, b) => a.date.localeCompare(b.date) || a.sessionInMicro - b.sessionInMicro).forEach((session) => {
    const summary = sessionSummary(session);
    const rows = session.rows.length ? session.rows : [null];
    rows.forEach((row) => {
      const load = row ? exerciseLoad(row.setsText, row.repsText, row.loadKg, row.recordKg) : null;
      diary.push([
        session.date,
        session.periodNo,
        session.microNo,
        session.sessionInMicro,
        session.sessionType,
        sheetNumber(session.bodyKg, 1),
        sheetNumber(session.timeS, 0),
        sheetNumber(session.rpeS, 0),
        sheetNumber(session.timeW, 0),
        sheetNumber(session.rpeW, 0),
        sheetNumber(summary.srpe_load, 0),
        row ? row.name : "",
        row ? (COMPLEXES[row.complex] || row.complex) : "",
        row ? row.setsText : "",
        row ? row.repsText : "",
        row ? sheetNumber(row.loadKg, 1) : "",
        row ? (row.recordName || "") : "",
        row ? sheetNumber(row.recordKg, 1) : "",
        load ? load.volume : "",
        load ? sheetNumber(load.tonnage, 1) : "",
        load ? sheetNumber(load.intensity, 2) : "",
      ]);
    });
  });

  const { article } = analysisModel();
  const micros = [[
    "Okres", "Mikrocykl", "Jednostki", "PC", "Siłowe", "Inne", "Serie", "Objętość", "Tonaż (kg)",
    "Średnie obciążenie (kg)", "Średni tonaż na jedn. PC+siłową", "RPE-load specjalny", "RPE-load uzupełniający",
    "sRPE-load", "Wewnętrzne/zewnętrzne", "ACWR tonażu", "ACWR RPE",
  ]];
  const groups = [["Okres", "Mikrocykl", "Grupa", "Objętość", "Tonaż (kg)", "Średnie obciążenie (kg)", "Średnia intensywność"]];
  article.forEach((item) => {
    micros.push([
      item.period_no, item.micro_no, item.sessions, item.pc, item.sil, item.inne,
      sheetNumber(item.sets, 0), sheetNumber(item.volume, 0), sheetNumber(item.tonnage, 1),
      sheetNumber(item.avg_load, 1), sheetNumber(item.avg_tonnage_session, 1),
      sheetNumber(item.rpe_load_s, 0), sheetNumber(item.rpe_load_w, 0), sheetNumber(item.srpe_load, 0),
      sheetNumber(item.internal_external, 3), sheetNumber(item.acwr_tonnage, 2), sheetNumber(item.acwr_rpe, 2),
    ]);
    [...item.groups, item.overall, item.rest].forEach((group) => {
      groups.push([
        item.period_no, item.micro_no, group.label,
        sheetNumber(group.volume, 0), sheetNumber(group.tonnage, 1),
        sheetNumber(group.avg_load, 1), sheetNumber(group.avg_intensity, 2),
      ]);
    });
  });

  const compare = [[
    "Okres", "Mikrocykl", "Data", "Dzień", "Poziom obciążenia",
    "Plan: objętość", "Plan: intensywność", "Plan: tonaż (kg)",
    "Realizacja: objętość", "Realizacja: intensywność", "Realizacja: tonaż (kg)",
  ]];
  state.microcycles.forEach((cycle) => {
    cycle.days.forEach((day) => {
      const date = dayDate(cycle.startDate, day.dayIndex);
      const planned = summarizePlan(day.exercises.map(planExerciseRow));
      const realizedRows = state.sessions
        .filter((session) => session.date === date)
        .flatMap((session) => session.rows.map(diaryRow));
      const realized = summarizeSession(realizedRows, 0, 0, 0, 0);
      compare.push([
        cycle.periodNo, cycle.microNo, date, weekday(date), day.loadLevel || "",
        sheetNumber(planned.volume, 0), sheetNumber(planned.avg_intensity, 2), sheetNumber(planned.tonnage, 1),
        realizedRows.length ? sheetNumber(realized.volume, 0) : "",
        realizedRows.length ? sheetNumber(realized.avg_intensity, 2) : "",
        realizedRows.length ? sheetNumber(realized.tonnage, 1) : "",
      ]);
    });
  });

  const weighs = [["Data", "Masa ciała (kg)"]];
  [...state.sessions].filter((session) => session.bodyKg).sort((a, b) => a.date.localeCompare(b.date)).forEach((session) => {
    weighs.push([session.date, sheetNumber(session.bodyKg, 1)]);
  });
  const meets = [["Data", "Zawody", "Masa ciała (kg)", "Rwanie", "Podrzut", "Dwubój", "Sinclair", "q-points"]];
  [...(state.competitions || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach((meet) => {
    const score = meetScore(meet);
    meets.push([
      meet.date, meet.name || "", sheetNumber(meet.bodyKg, 1), sheetNumber(meet.snatch, 1),
      sheetNumber(meet.cleanJerk, 1), sheetNumber(score.total, 1), sheetNumber(score.sinclair, 1), sheetNumber(score.points, 1),
    ]);
  });
  const goals = [["Rok", "Rwanie", "Podrzut", "Dwubój"]];
  (state.goals || []).forEach((goal) => {
    goals.push([goal.year, sheetNumber(goal.snatch, 1), sheetNumber(goal.cleanJerk, 1), sheetNumber(num(goal.snatch) + num(goal.cleanJerk), 1)]);
  });
  const profileRows = [["Bój", "Wynik (kg)", "Procent przysiadu", "Wzorzec"]];
  teiProfile(state.tei || {}).rows.forEach((row) => {
    profileRows.push([row.label, sheetNumber(row.kg, 1), sheetNumber(row.actual, 3), sheetNumber(row.ref, 3)]);
  });

  const workbook = XLSX.utils.book_new();
  addSheet(workbook, "Rekordy", records);
  addSheet(workbook, "Plan", plan);
  addSheet(workbook, "Dziennik", diary);
  addSheet(workbook, "Mikrocykle", micros);
  addSheet(workbook, "Kompleksy", groups);
  addSheet(workbook, "Plan a realizacja", compare);
  addSheet(workbook, "Masa ciała", weighs);
  addSheet(workbook, "Starty", meets);
  addSheet(workbook, "Cele", goals);
  addSheet(workbook, "Profil", profileRows);
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, `${athleteFileStem()}.xlsx`);
}

async function exportFile() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${athleteFileStem()}.json`);
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
