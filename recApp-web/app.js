/* recApp – Oberfläche, Datenzugriff und Offline-Betrieb */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const L = window.Logik;

  const RUNDE = 20;                         // Karten pro Runde
  const KLAUSUR_FRAGEN = 20;                // Fragen im Klausur-Modus
  const CACHE_DATEN = "recapp-daten";       // zuletzt geladener Stand (für offline)
  const CACHE_SCHLANGE = "recapp-schlange"; // Änderungen, die noch zu Supabase müssen

  const zustand = {
    db: null,
    heute: "",
    stapel: new Map(),        // id → {id, modul, titel, reihenfolge}
    karten: [],               // aktive Karten
    kartenNachId: new Map(),
    fortschritt: new Map(),   // karte_id → {fach, faellig, richtig, falsch}
    lerntage: new Map(),      // tag → {gelernt, richtig, neue, sekunden, geschafft}
    module: new Map(),        // Modulname → Klausurtermin (JJJJ-MM-TT) oder null
    pruefungen: [],           // Ergebnisse des Klausur-Modus, neueste zuerst
    neueProTag: 20,
    tagesziel: L.STANDARD_TAGESZIEL,
    abstaende: L.STANDARD_ABSTAENDE,
    offenModule: new Set(),
    sitzung: null,
    offline: false,
  };

  // ==========================================
  // START
  // ==========================================

  window.addEventListener("DOMContentLoaded", start);

  async function start() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    if (!window.supabase || !window.supabase.createClient) {
      // Ohne Bibliothek (erster Start offline) geht es nicht
      return fehlerSeite("Die Supabase-Bibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen und neu laden.");
    }
    const cfg = window.RECAPP_CONFIG || {};
    if (!cfg.url || !cfg.key || cfg.url.includes("DEIN-PROJEKT")) {
      return fehlerSeite("In config.js fehlen Projekt-URL und öffentlicher Schlüssel von Supabase.");
    }
    // Nur die Projekt-URL verwenden – ein angehängtes /rest/v1 (Data-API-Adresse) würde alle Anfragen verdoppeln
    const url = cfg.url.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
    zustand.db = window.supabase.createClient(url, cfg.key.trim());
    verbindeKnoepfe();
    window.addEventListener("online", () => abarbeiten());
    document.addEventListener("visibilitychange", () => {
      // App kommt aus dem Hintergrund: neuer Tag? Dann Startseite neu aufbauen
      if (document.visibilityState === "visible" && !zustand.sitzung && zustand.heute && zustand.heute !== L.datum(new Date())) {
        ladeUndZeigeStart();
      }
    });

    let angemeldet = false;
    try {
      const { data } = await zustand.db.auth.getSession();
      angemeldet = Boolean(data && data.session);
    } catch (e) {
      angemeldet = false;
    }
    // Offline: gespeicherte Anmeldung + gespeicherter Stand reichen zum Lernen
    if (!angemeldet && hatGespeicherteAnmeldung() && ladeCache()) angemeldet = true;
    if (angemeldet) {
      await ladeUndZeigeStart();
    } else {
      zeige("login");
    }
  }

  function verbindeKnoepfe() {
    $("login-form").addEventListener("submit", anmelden);
    $("abmelden").addEventListener("click", abmelden);
    $("lernen-start").addEventListener("click", () => starteLernen(zustand.karten, "Alles", { ohnePoolNeu: true, klausurZuerst: true }));
    $("schwierig-start").addEventListener("click", starteSchwierige);
    $("lernen-zurueck").addEventListener("click", () => beendeSitzung(false));
    $("pruefen").addEventListener("click", pruefe);
    $("weiss-nicht").addEventListener("click", weissNicht);
    $("aufdecken").addEventListener("click", aufdecken);
    $("weiter").addEventListener("click", () => bewerte(zustand.sitzung.ergebnis));
    $("doch-richtig").addEventListener("click", dochRichtig);
    $("gewusst").addEventListener("click", () => bewerte(true));
    $("unsicher").addEventListener("click", () => bewerte(L.UNSICHER));
    $("nicht-gewusst").addEventListener("click", () => bewerte(false));
    $("melden").addEventListener("click", melden);
    $("fertig-weiter").addEventListener("click", naechsteRunde);
    $("fertig-zurueck").addEventListener("click", () => ladeUndZeigeStart());
    $("ergebnis-ueben").addEventListener("click", uebeFalscheAusKlausur);
    $("ergebnis-zurueck").addEventListener("click", () => ladeUndZeigeStart());
    $("antwort-eingabe").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) pruefe();
    });
  }

  // ==========================================
  // ANMELDEN
  // ==========================================

  async function anmelden(e) {
    e.preventDefault();
    $("login-fehler").hidden = true;
    const { error } = await zustand.db.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-passwort").value,
    });
    if (error) {
      $("login-fehler").textContent = "Anmeldung fehlgeschlagen: " + error.message;
      $("login-fehler").hidden = false;
      return;
    }
    await ladeUndZeigeStart();
  }

  async function abmelden() {
    if (schlange().length > 0 && !confirm("Es sind noch Lernergebnisse nicht übertragen (offline). Trotzdem abmelden? Sie gehen dann verloren.")) return;
    await zustand.db.auth.signOut();
    try {
      localStorage.removeItem(CACHE_DATEN);
      localStorage.removeItem(CACHE_SCHLANGE);
    } catch (e) { /* egal */ }
    zeige("login");
  }

  function hatGespeicherteAnmeldung() {
    try {
      return Object.keys(localStorage).some((k) => /^sb-.+-auth-token$/.test(k));
    } catch (e) {
      return false;
    }
  }

  // ==========================================
  // DATEN
  // ==========================================

  async function ladeUndZeigeStart() {
    $("laden").hidden = false;
    try {
      await abarbeiten();                       // erst Offline-Ergebnisse hochladen, dann frisch laden
      try {
        await ladeDaten();
        setzeOffline(false);
        merkeCache();
      } catch (err) {
        if (!istNetzfehler(err) || !ladeCache()) throw err;
        setzeOffline(true);
      }
      zustand.heute = L.datum(new Date());
      await markiereTag();
      zeigeStart();
    } catch (err) {
      meldung("Laden fehlgeschlagen: " + (err.message || err));
      zeige("login");
    } finally {
      $("laden").hidden = true;
    }
  }

  async function ladeDaten() {
    const db = zustand.db;
    const [st, ka, fo, le, ei, mo, pr] = await Promise.all([
      db.from("stapel").select("id, modul, titel, reihenfolge"),
      db.from("karten").select("id, stapel_id, frage, antwort, typ, schluesselwoerter").eq("aktiv", true).range(0, 9999),
      db.from("fortschritt").select("karte_id, fach, faellig, richtig, falsch").range(0, 9999),
      db.from("lerntage").select("*").order("tag", { ascending: false }).limit(400),
      db.from("einstellungen").select("schluessel, wert"),
      db.from("module").select("name, klausur"),
      db.from("pruefungen").select("*").order("zeit", { ascending: false }).limit(50),
    ]);
    for (const r of [st, ka, fo, le, ei]) {
      if (r.error) throw r.error;
    }
    zustand.stapel = new Map(st.data.map((s) => [s.id, s]));
    zustand.karten = ka.data;
    zustand.fortschritt = new Map(fo.data.map((f) => [f.karte_id, f]));
    zustand.lerntage = new Map(le.data.map((t) => [t.tag, t]));
    // module und pruefungen gibt es erst mit Ergänzung 2 – ohne sie läuft die App trotzdem
    zustand.module = new Map(mo.error ? [] : mo.data.map((m) => [m.name, m.klausur]));
    zustand.pruefungen = pr.error ? [] : pr.data;
    zustand.einstellungen = ei.data;
    uebernimmEinstellungen(ei.data);
    zustand.kartenNachId = new Map(zustand.karten.map((k) => [k.id, k]));
  }

  function uebernimmEinstellungen(liste) {
    for (const { schluessel, wert } of liste || []) {
      if (schluessel === "neue_pro_tag") zustand.neueProTag = parseInt(wert, 10) || 20;
      if (schluessel === "tagesziel") zustand.tagesziel = parseInt(wert, 10) || L.STANDARD_TAGESZIEL;
      if (schluessel === "abstaende_tage") {
        const a = wert.split(",").map((x) => parseInt(x, 10));
        if (a.length === 6 && a.every((x) => x > 0)) zustand.abstaende = a;
      }
    }
  }

  // ---------- Offline: Stand merken und wiederherstellen ----------

  let cacheTimer = null;
  function merkeCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      try {
        localStorage.setItem(CACHE_DATEN, JSON.stringify({
          stapel: [...zustand.stapel.values()],
          karten: zustand.karten,
          fortschritt: [...zustand.fortschritt.values()],
          lerntage: [...zustand.lerntage.values()],
          module: [...zustand.module.entries()],
          pruefungen: zustand.pruefungen,
          einstellungen: zustand.einstellungen || [],
        }));
      } catch (e) { /* Speicher voll oder privat – dann eben ohne Offline-Stand */ }
    }, 400);
  }

  function ladeCache() {
    try {
      const d = JSON.parse(localStorage.getItem(CACHE_DATEN) || "null");
      if (!d || !Array.isArray(d.karten) || d.karten.length === 0) return false;
      zustand.stapel = new Map(d.stapel.map((s) => [s.id, s]));
      zustand.karten = d.karten;
      zustand.kartenNachId = new Map(d.karten.map((k) => [k.id, k]));
      zustand.fortschritt = new Map(d.fortschritt.map((f) => [f.karte_id, f]));
      zustand.lerntage = new Map(d.lerntage.map((t) => [t.tag, t]));
      zustand.module = new Map(d.module || []);
      zustand.pruefungen = d.pruefungen || [];
      zustand.einstellungen = d.einstellungen || [];
      uebernimmEinstellungen(zustand.einstellungen);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- Offline: Änderungen in einer Warteschlange ----------

  function schlange() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_SCHLANGE) || "[]");
    } catch (e) {
      return [];
    }
  }

  function speichereSchlange(s) {
    try {
      localStorage.setItem(CACHE_SCHLANGE, JSON.stringify(s));
    } catch (e) { /* egal */ }
  }

  /** Jede Änderung geht über die Warteschlange – online sofort weiter, offline später. */
  function schreibe(tabelle, art, zeile) {
    const s = schlange();
    s.push({ nr: Date.now() + Math.random(), tabelle, art, zeile });
    speichereSchlange(s);
    merkeCache();
    abarbeiten();
  }

  let laeuft = null;
  /** Arbeitet die Warteschlange der Reihe nach ab; läuft höchstens einmal gleichzeitig. */
  function abarbeiten() {
    if (!laeuft) laeuft = arbeiteSchlangeAb().finally(() => { laeuft = null; });
    return laeuft;
  }

  async function arbeiteSchlangeAb() {
    for (;;) {
      const e = schlange()[0];
      if (!e) {
        setzeOffline(false);
        return;
      }
      let res;
      try {
        const t = zustand.db.from(e.tabelle);
        res = await (e.art === "upsert" ? t.upsert(e.zeile) : t.insert(e.zeile));
      } catch (err) {
        res = { error: err };
      }
      if (res.error && istNetzfehler(res.error)) {
        setzeOffline(true);
        return;                              // später noch einmal (online-Ereignis oder nächster Start)
      }
      if (res.error) meldung(`Nicht gespeichert (${e.tabelle}): ${res.error.message}`);
      speichereSchlange(schlange().filter((x) => x.nr !== e.nr));
    }
  }

  function istNetzfehler(err) {
    const text = String((err && (err.message || err.details)) || err || "");
    return !navigator.onLine || /fetch|load failed|network|netzwerk|timeout|abort/i.test(text);
  }

  function setzeOffline(ja) {
    zustand.offline = ja;
    const n = schlange().length;
    $("offline").hidden = !ja && n === 0;
    $("offline").textContent = ja
      ? `OFFLINE · ${n > 0 ? n + " Änderungen warten" : "lernen geht trotzdem"}`
      : `${n} Änderungen werden übertragen …`;
  }

  // ---------- Hilfen für heute ----------

  function heuteEintrag() {
    return zustand.lerntage.get(zustand.heute) || { tag: zustand.heute, gelernt: 0, richtig: 0, neue: 0, sekunden: 0, geschafft: false };
  }

  function neueFrei() {
    return Math.max(0, zustand.neueProTag - (heuteEintrag().neue || 0));
  }

  function reihenfolge() {
    return new Map([...zustand.stapel.values()].map((s) => [s.id, s.reihenfolge]));
  }

  /** Fällige + heutige neue Karten innerhalb einer Auswahl (poolNeu: neue Klausur-Pool-Karten ohne Limit). */
  function heuteIn(karten) {
    return L.heutigeKarten(karten, zustand.fortschritt, zustand.heute, neueFrei(), reihenfolge());
  }

  function offenGesamt() {
    const h = heuteIn(zustand.karten);
    return h.faellig.length + h.neu.length;
  }

  function modulVon(k) {
    return zustand.stapel.get(k.stapel_id)?.modul || "";
  }

  function klausurVon(modul) {
    const direkt = zustand.module.get(modul);
    if (direkt) return direkt;
    return zustand.module.get(modul.replace(/^Klausur-Pool\s*/, "")) || null;
  }

  /** Ist heute geschafft (Tagesziel oder nichts offen), wird das gespeichert. */
  async function markiereTag() {
    const e = heuteEintrag();
    if (!e.geschafft && zustand.karten.length > 0 && L.tagGeschafft(e, offenGesamt(), zustand.tagesziel)) {
      speichereLerntag({ ...e, geschafft: true });
    }
  }

  function speichereLerntag(eintrag) {
    const zeile = {
      tag: zustand.heute,
      gelernt: eintrag.gelernt || 0,
      richtig: eintrag.richtig || 0,
      neue: eintrag.neue || 0,
      sekunden: eintrag.sekunden || 0,
      geschafft: Boolean(eintrag.geschafft),
    };
    zustand.lerntage.set(zustand.heute, zeile);
    schreibe("lerntage", "upsert", zeile);
  }

  // ==========================================
  // STARTSEITE
  // ==========================================

  function zeigeStart() {
    const info = L.serienInfo(zustand.lerntage, zustand.heute);
    const h = heuteIn(zustand.karten);
    const offen = h.faellig.length + h.neu.length;
    const e = heuteEintrag();
    const geschafft = e.geschafft;
    const ziel = zustand.tagesziel;
    const gelernt = e.gelernt || 0;

    // Serie
    $("serie-zahl").textContent = info.serie;
    $("serie-text").textContent = geschafft
      ? "Tage – heute geschafft"
      : info.serie > 0 ? "Tage – heute noch offen" : "Tage am Stück";

    // Tagesziel
    $("ziel-zahl").textContent = Math.min(gelernt, ziel);
    $("ziel-von").textContent = `/${ziel}`;
    $("ziel-balken").style.width = `${Math.min(100, (gelernt / ziel) * 100)}%`;
    $("ziel-text").textContent = geschafft
      ? (gelernt >= ziel ? "Ziel erreicht" : "Nichts mehr offen")
      : `Noch ${ziel - gelernt} ${ziel - gelernt === 1 ? "Karte" : "Karten"}`;

    // Klausur-Countdown (nächste Klausur in den kommenden 60 Tagen)
    const naechste = [...zustand.module.entries()]
      .filter(([name, t]) => t && !name.startsWith("Klausur-Pool") && L.tageBis(zustand.heute, t) >= 0 && L.tageBis(zustand.heute, t) <= 60)
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))[0];
    $("klausur-hinweis").hidden = !naechste;
    if (naechste) {
      const d = L.tageBis(zustand.heute, naechste[1]);
      $("klausur-hinweis").innerHTML = "";
      const t = document.createElement("span");
      t.className = "kachel-titel";
      t.textContent = d === 0 ? "KLAUSUR HEUTE" : `KLAUSUR IN ${d} ${d === 1 ? "TAG" : "TAGEN"}`;
      const n = document.createElement("span");
      n.textContent = naechste[0] + (d <= L.KLAUSUR_VORLAUF ? " · kommt beim Lernen zuerst" : "");
      $("klausur-hinweis").append(t, n);
    }

    // Lernen
    const runde = Math.min(RUNDE, offen);
    $("lernen-start").textContent = offen > 0 ? `RUNDE STARTEN · ${runde} KARTEN` : "ALLES GESCHAFFT – TROTZDEM ÜBEN";
    $("offen-text").textContent = offen > 0
      ? `${offen} offen · ${h.faellig.length} fällig${h.ueberfaellig ? ` (${h.ueberfaellig} überfällig)` : ""} · ${h.neu.length} neu`
      : "Heute ist nichts mehr fällig.";

    const schwierig = zustand.karten.filter((k) => L.istSchwierig(zustand.fortschritt.get(k.id)));
    $("schwierig-start").hidden = schwierig.length === 0;
    $("schwierig-start").textContent = `SCHWIERIGE KARTEN · ${schwierig.length}`;

    zeigeKalender(info.pausen);
    zeigeSchwaechen();
    zeigeModule();

    const w = L.woche(zustand.lerntage, zustand.heute);
    $("bestand").textContent = `Woche: ${w.karten} Karten · ${Math.round(w.sekunden / 60)} min · `
      + `${zustand.karten.length} Karten gesamt · ${L.sicherProzent(zustand.karten.filter((k) => !L.istPool(k)), zustand.fortschritt)} % sicher · längste Serie ${info.laengste}`;
    zeige("start");
  }

  function zeigeKalender(pausen) {
    const box = $("kalender");
    box.innerHTML = "";
    for (let i = 27; i >= 0; i--) {
      const tag = L.plusTage(zustand.heute, -i);
      const e = zustand.lerntage.get(tag);
      const d = document.createElement("div");
      d.className = "tag" + (e?.geschafft ? " geschafft" : pausen.has(tag) ? " pause" : e?.gelernt ? " gelernt" : "") + (i === 0 ? " heute" : "");
      d.title = tag + (e?.gelernt ? ` · ${e.gelernt} Karten` : "");
      box.appendChild(d);
    }
    const leg = document.createElement("div");
    leg.className = "legende";
    leg.textContent = "Letzte 4 Wochen · rot = geschafft · Rahmen = Pause-Tag · grau = gelernt";
    box.appendChild(leg);
  }

  function zeigeSchwaechen() {
    const liste = L.schwaechen(zustand.karten, zustand.fortschritt, 3, 6);
    $("schwaechen-titel").hidden = liste.length === 0;
    const box = $("schwaechen");
    box.innerHTML = "";
    box.hidden = liste.length === 0;
    for (const s of liste) {
      const st = zustand.stapel.get(s.stapel_id);
      if (!st) continue;
      const ks = zustand.karten.filter((k) => k.stapel_id === s.stapel_id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stapel-zeile";
      b.innerHTML = `<span><span class="klein-text block"></span><span class="titel"></span></span><span class="anzahl"></span>`;
      b.querySelector(".block").textContent = st.modul.replace(/^Klausur-Pool\s*/, "Klausur-Pool · ");
      b.querySelector(".titel").textContent = st.titel;
      b.querySelector(".anzahl").textContent = `${Math.round(s.quote * 100)} % richtig`;
      b.addEventListener("click", () => starteLernen(ks, st.titel, { alleUeben: true }));
      box.appendChild(b);
    }
  }

  const MODULFARBEN = ["pink", "cyan", "lime", "orange", "violett", "gelb"];
  const istPoolModul = (modul) => [...zustand.stapel.values()].some((s) => s.modul === modul && s.id.startsWith(L.POOL_PRAEFIX));

  function zeigeModule() {
    const box = $("module");
    box.innerHTML = "";
    const alle = [...new Set([...zustand.stapel.values()].map((s) => s.modul))].sort((a, b) => a.localeCompare(b, "de"));
    // Klausur-Pools zuerst, dann Module mit naher Klausur
    const tage = (m) => {
      const t = klausurVon(m);
      const d = t ? L.tageBis(zustand.heute, t) : -1;
      return d >= 0 ? d : Infinity;
    };
    const normal = alle.filter((m) => !istPoolModul(m)).sort((a, b) => tage(a) - tage(b) || a.localeCompare(b, "de"));
    const module = [...alle.filter(istPoolModul), ...normal];
    let farbIndex = 0;

    module.forEach((modul) => {
      const pool = istPoolModul(modul);
      const stapelListe = [...zustand.stapel.values()]
        .filter((s) => s.modul === modul)
        .sort((a, b) => a.reihenfolge - b.reihenfolge || a.titel.localeCompare(b.titel, "de"));
      const kartenModul = zustand.karten.filter((k) => modulVon(k) === modul);
      const hm = heuteIn(kartenModul);

      const wrap = document.createElement("div");
      wrap.className = "modul";
      const kopf = document.createElement("button");
      kopf.type = "button";
      kopf.className = `knopf modul-kopf kachel ${pool ? "rot pool" : MODULFARBEN[farbIndex++ % MODULFARBEN.length]}`;
      kopf.innerHTML = `<span class="name"></span><span class="anzahl"></span>`;
      const anzeige = pool ? modul.replace(/^Klausur-Pool\s*/, "") : modul;
      const name = kopf.querySelector(".name");
      name.textContent = (zustand.offenModule.has(modul) ? "▾ " : "▸ ") + anzeige;
      const unter = document.createElement("small");
      const t = klausurVon(modul);
      const d = t ? L.tageBis(zustand.heute, t) : null;
      unter.textContent = `${L.sicherProzent(kartenModul, zustand.fortschritt)} % sicher`
        + (d !== null && d >= 0 ? ` · Klausur in ${d} ${d === 1 ? "Tag" : "Tagen"}` : "");
      name.appendChild(unter);
      setzeAnzahl(kopf.querySelector(".anzahl"), hm.faellig.length + hm.neu.length + hm.poolNeu.length, pool ? kartenModul.length : undefined);
      kopf.addEventListener("click", () => {
        zustand.offenModule.has(modul) ? zustand.offenModule.delete(modul) : zustand.offenModule.add(modul);
        zeigeModule();
      });
      wrap.appendChild(kopf);

      if (zustand.offenModule.has(modul)) {
        const liste = document.createElement("div");
        liste.className = "stapel-liste";
        if (pool) liste.appendChild(klausurZeile(modul, kartenModul));
        liste.appendChild(stapelZeile(pool ? `Alle ${kartenModul.length} zusammen` : "Ganzes Modul", kartenModul, modul));
        for (const s of stapelListe) {
          const ks = zustand.karten.filter((k) => k.stapel_id === s.id);
          liste.appendChild(stapelZeile(s.titel, ks, s.titel));
        }
        wrap.appendChild(liste);
      }
      box.appendChild(wrap);
    });
  }

  function stapelZeile(titel, karten, sitzungsTitel) {
    const h = heuteIn(karten);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stapel-zeile";
    b.innerHTML = `<span><span class="titel"></span><span class="klein-text block"></span></span><span class="anzahl"></span>`;
    b.querySelector(".titel").textContent = titel;
    b.querySelector(".block").textContent = `${L.sicherProzent(karten, zustand.fortschritt)} % sicher`;
    setzeAnzahl(b.querySelector(".anzahl"), h.faellig.length + h.neu.length + h.poolNeu.length, karten.length);
    b.addEventListener("click", () => starteLernen(karten, sitzungsTitel));
    return b;
  }

  /** Zeile „Klausur simulieren“ mit den letzten Ergebnissen. */
  function klausurZeile(modul, karten) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stapel-zeile klausur-zeile";
    const letzte = zustand.pruefungen.filter((p) => p.modul === modul).slice(0, 4).reverse();
    const verlauf = letzte.map((p) => L.pruefungsProzent(p.gewusst, p.unsicher, p.fragen) + " %").join(" → ");
    b.innerHTML = `<span><span class="titel"></span><span class="klein-text block"></span></span><span class="anzahl">START</span>`;
    b.querySelector(".titel").textContent = `Klausur simulieren · ${Math.min(KLAUSUR_FRAGEN, karten.length)} Fragen`;
    b.querySelector(".block").textContent = verlauf ? `Bisher: ${verlauf}` : "Zufällige Fragen, Ergebnis am Ende";
    b.addEventListener("click", () => starteKlausur(modul, karten));
    return b;
  }

  function setzeAnzahl(el, offen, gesamt) {
    el.textContent = gesamt === undefined ? `${offen} offen` : `${offen} / ${gesamt}`;
    el.classList.toggle("null", offen === 0);
  }

  // ==========================================
  // LERNEN
  // ==========================================

  /**
   * Stellt eine Runde zusammen: fällige (älteste zuerst) + neue Karten, höchstens 20.
   * optionen: ohnePoolNeu (bei „Alles“), klausurZuerst (Module mit naher Klausur vorn),
   * alleUeben (alle Karten der Auswahl – nicht Fällige zählen nur als Übung)
   */
  function stelleRundeZusammen(karten, optionen) {
    const o = optionen || {};
    let h = heuteIn(karten);
    if (o.klausurZuerst) {
      // Erst ALLE neuen Karten nach Klausurnähe sortieren, dann aufs Tageslimit kürzen
      const sortiere = (liste) => L.nachKlausurSortieren(liste, (k) => klausurVon(modulVon(k)), zustand.heute);
      const alle = L.heutigeKarten(karten, zustand.fortschritt, zustand.heute, Infinity, reihenfolge());
      h = { ...h, faellig: sortiere(h.faellig), neu: sortiere(alle.neu).slice(0, neueFrei()) };
    }
    const poolNeu = o.ohnePoolNeu ? [] : mische([...h.poolNeu]);
    const plan = [...h.faellig, ...h.neu, ...poolNeu];
    let uebung = [];
    if (o.alleUeben) {
      const imPlan = new Set(plan.map((k) => k.id));
      uebung = mische(karten.filter((k) => !imPlan.has(k.id)));
    }
    return { plan, uebung };
  }

  function starteLernen(karten, titel, optionen) {
    let { plan, uebung } = stelleRundeZusammen(karten, optionen);
    if (plan.length === 0 && uebung.length === 0) {
      if (karten.length === 0) return meldung("Hier gibt es keine Karten.");
      if (!confirm(`In „${titel}“ ist heute nichts fällig. Trotzdem üben? (Zählt fürs Tagesziel, nicht für den Wiederholungsplan.)`)) return;
      uebung = mische([...karten]);
    }
    const auswahl = [...plan, ...uebung].slice(0, RUNDE);
    zustand.sitzung = neueSitzung(titel, auswahl, new Set(plan.map((k) => k.id)), { karten, titel, optionen });
    zeige("lernen");
    zeigeKarte();
  }

  function starteSchwierige() {
    const ks = zustand.karten.filter((k) => L.istSchwierig(zustand.fortschritt.get(k.id)));
    if (!ks.length) return;
    // schwierigste zuerst: niedriges Fach, viele Fehler
    const f = (k) => zustand.fortschritt.get(k.id);
    ks.sort((a, b) => f(a).fach - f(b).fach || (f(b).falsch || 0) - (f(a).falsch || 0));
    starteLernen(ks, "Schwierige Karten", { alleUeben: true });
  }

  function starteKlausur(modul, karten) {
    const auswahl = mische([...karten]).slice(0, KLAUSUR_FRAGEN);
    if (!auswahl.length) return meldung("Hier gibt es keine Fragen.");
    // Fällige und neue Pool-Karten zählen auch für den Wiederholungsplan
    const h = heuteIn(auswahl);
    const plan = new Set([...h.faellig, ...h.poolNeu, ...h.neu].map((k) => k.id));
    zustand.sitzung = neueSitzung("Klausur · " + modul.replace(/^Klausur-Pool\s*/, ""), auswahl, plan, null);
    zustand.sitzung.klausur = { modul, gewusst: 0, unsicher: 0, falsch: [], start: Date.now() };
    zeige("lernen");
    zeigeKarte();
  }

  function neueSitzung(titel, karten, planIds, quelle) {
    return {
      titel,
      schlange: karten.map((k) => k.id),
      planIds,                 // Karten, die für den Wiederholungsplan zählen (Rest: Übung)
      quelle,                  // für „nächste Runde“
      pos: 0,
      gewertet: new Set(),     // Karten, die in dieser Runde schon zählten
      richtig: 0, gelernt: 0, sekunden: 0,
      ergebnis: false,
      antwort: "",
      kartenStart: 0,
      klausur: null,
    };
  }

  function aktuelleKarte() {
    const s = zustand.sitzung;
    return zustand.kartenNachId.get(s.schlange[s.pos]);
  }

  function zeigeKarte() {
    const s = zustand.sitzung;
    const k = aktuelleKarte();
    if (!k) return beendeSitzung(true);
    s.kartenStart = Date.now();

    $("fortschritt-text").textContent = `${s.pos + 1} / ${s.schlange.length}`;
    $("fortschritt-balken").style.width = `${(s.pos / s.schlange.length) * 100}%`;
    const uebung = !s.planIds.has(k.id);
    $("karte-stapel").textContent = (zustand.stapel.get(k.stapel_id)?.titel || "")
      + (s.klausur ? " · Klausur" : uebung ? " · Übung" : "");
    schreibeMarkdown($("karte-frage"), k.frage);
    $("karte-frage").classList.toggle("lang", k.frage.length > 160);   // Fallstudien: Lesegröße statt Fragengröße

    const getippt = L.wirdGetippt(k) && !s.klausur;
    $("block-tippen").hidden = !getippt;
    $("block-aufdecken").hidden = getippt;
    $("block-ergebnis").hidden = true;
    $("antwort-eingabe").value = "";
    $("pruefen").disabled = false;
    window.scrollTo(0, 0);
    if (getippt) setTimeout(() => $("antwort-eingabe").focus(), 50);
  }

  function pruefe() {
    const k = aktuelleKarte();
    const antwort = $("antwort-eingabe").value;
    if (!antwort.trim()) return meldung("Erst eine Antwort eintippen – oder „WEISS NICHT“.");
    const r = L.pruefeAntwort(antwort, k.schluesselwoerter);
    zustand.sitzung.ergebnis = r.richtig;
    zustand.sitzung.antwort = antwort;
    zeigeErgebnis(k, r.richtig ? "richtig" : "falsch", r.treffer);
  }

  function weissNicht() {
    zustand.sitzung.ergebnis = false;
    zustand.sitzung.antwort = "";
    zeigeErgebnis(aktuelleKarte(), "weissnicht", []);
  }

  function aufdecken() {
    zeigeErgebnis(aktuelleKarte(), "selbst", []);
  }

  function zeigeErgebnis(k, art, treffer) {
    $("block-tippen").hidden = true;
    $("block-aufdecken").hidden = true;
    $("block-ergebnis").hidden = false;

    const urteil = $("urteil");
    const texte = {
      richtig: ["RICHTIG", "Alle Schlüsselwörter gefunden."],
      falsch: ["NOCH NICHT", "Es fehlen Schlüsselwörter – vergleiche mit der Musterantwort."],
      weissnicht: ["KEIN PROBLEM", "Lies die Antwort in Ruhe – die Karte kommt gleich noch einmal."],
      selbst: ["WIE WAR'S?", "Vergleiche mit deiner Antwort im Kopf und bewerte ehrlich."],
    };
    urteil.className = "urteil " + (art === "richtig" ? "richtig" : art === "selbst" ? "neutral" : "falsch");
    urteil.innerHTML = "";
    urteil.append(texte[art][0]);
    const klein = document.createElement("small");
    klein.textContent = texte[art][1];
    urteil.appendChild(klein);

    const box = $("treffer");
    box.innerHTML = "";
    for (const t of treffer) {
      const c = document.createElement("span");
      c.className = "chip " + (t.gefunden ? "ja" : "nein");
      c.textContent = t.alternativen.join(" / ");
      box.appendChild(c);
    }
    box.hidden = treffer.length === 0;

    schreibeMarkdown($("karte-antwort"), k.antwort);
    $("reihe-getippt").hidden = art === "selbst";
    $("reihe-selbst").hidden = art !== "selbst";
    const drei = L.istPool(k);                           // drei Stufen nur im Klausur-Pool (wie in Obsidian)
    $("unsicher").hidden = !drei;
    $("reihe-selbst").classList.toggle("drei", drei);
    $("doch-richtig").hidden = art !== "falsch";
    window.scrollTo(0, 0);
  }

  function dochRichtig() {
    const k = aktuelleKarte();
    const antwort = zustand.sitzung.antwort;
    schreibe("einwaende", "insert", { karte_id: k.id, antwort });
    bewerte(true);
  }

  function melden() {
    const k = aktuelleKarte();
    if (!k) return;
    const text = prompt("Was stimmt an dieser Karte nicht? (Claude bessert sie im Vault nach)");
    if (!text || !text.trim()) return;
    schreibe("meldungen", "insert", { karte_id: k.id, text: text.trim() });
    meldung("Danke – Karte gemeldet. Sie erscheint nach dem nächsten Hochladen in recApp Sync im Vault.");
  }

  /** Zählt das Ergebnis (true, false oder „unsicher“), plant die Karte neu und geht zur nächsten. */
  function bewerte(ergebnis) {
    const s = zustand.sitzung;
    const k = aktuelleKarte();
    const richtig = ergebnis === true;
    const sekunden = L.kartenSekunden(Date.now() - s.kartenStart);
    s.sekunden += sekunden;

    if (!s.gewertet.has(k.id)) {
      s.gewertet.add(k.id);
      s.gelernt++;
      if (richtig) s.richtig++;
      if (s.klausur) {
        if (richtig) s.klausur.gewusst++;
        else if (ergebnis === L.UNSICHER) s.klausur.unsicher++;
        else s.klausur.falsch.push(k.id);
      }
      speichereErgebnis(k, ergebnis, s.planIds.has(k.id), sekunden);
    } else {
      zaehleZeit(sekunden);
    }
    if (ergebnis === false && !s.klausur) {
      s.schlange.push(k.id);      // am Ende der Runde noch einmal (unsicher: morgen wieder)
    }
    s.pos++;
    if (s.pos >= s.schlange.length) {
      beendeSitzung(true);
    } else {
      zeigeKarte();
    }
  }

  /**
   * Speichert eine Antwort. Für den Wiederholungsplan nur, wenn die Karte heute dran war (imPlan);
   * fürs Tagesziel und die Lernzeit zählt jede Karte – auch Übung.
   */
  function speichereErgebnis(k, ergebnis, imPlan, sekunden) {
    const richtig = ergebnis === true;
    let warNeu = false;
    if (imPlan) {
      const alt = zustand.fortschritt.get(k.id);
      warNeu = (!alt || !alt.faellig) && !L.istPool(k);   // Pool-Karten belasten das Tageslimit nicht
      const neu = L.naechsterStand(alt, ergebnis, zustand.heute, zustand.abstaende);
      const zeile = { karte_id: k.id, ...neu, zuletzt: new Date().toISOString() };
      zustand.fortschritt.set(k.id, zeile);
      schreibe("fortschritt", "upsert", zeile);
    }

    const e = heuteEintrag();
    const eintrag = {
      ...e,
      gelernt: (e.gelernt || 0) + 1,
      richtig: (e.richtig || 0) + (richtig ? 1 : 0),
      neue: (e.neue || 0) + (warNeu ? 1 : 0),
      sekunden: (e.sekunden || 0) + sekunden,
    };
    // Erst Lernstand und Tageskontingent aktualisieren, dann prüfen, ob das Ziel erreicht ist
    zustand.lerntage.set(zustand.heute, eintrag);
    eintrag.geschafft = L.tagGeschafft(eintrag, offenGesamt(), zustand.tagesziel);
    speichereLerntag(eintrag);
  }

  function zaehleZeit(sekunden) {
    if (!sekunden) return;
    const e = heuteEintrag();
    speichereLerntag({ ...e, sekunden: (e.sekunden || 0) + sekunden });
  }

  function beendeSitzung(fertig) {
    const s = zustand.sitzung;
    if (!fertig || !s || s.gelernt === 0) {
      zustand.sitzung = null;
      return zeigeStart();
    }
    if (s.klausur) return zeigeKlausurErgebnis(s);

    const quote = Math.round((s.richtig / s.gelernt) * 100);
    const min = Math.max(1, Math.round(s.sekunden / 60));
    $("fertig-zahl").textContent = s.gelernt;
    $("fertig-text").textContent = `${s.gelernt === 1 ? "Karte" : "Karten"} in „${s.titel}“ · ${quote} % beim ersten Versuch richtig · ${min} min`;

    const info = L.serienInfo(zustand.lerntage, zustand.heute);
    const e = heuteEintrag();
    const rest = zustand.tagesziel - (e.gelernt || 0);
    $("fertig-serie").textContent = e.geschafft
      ? `SERIE: ${info.serie} ${info.serie === 1 ? "TAG" : "TAGE"} – HEUTE GESCHAFFT`
      : `NOCH ${rest} ${rest === 1 ? "KARTE" : "KARTEN"} BIS ZUM TAGESZIEL`;

    // Gibt es in derselben Auswahl noch etwas? Dann „nächste Runde“ anbieten
    let weiter = 0;
    if (s.quelle) {
      const { plan, uebung } = stelleRundeZusammen(s.quelle.karten, s.quelle.optionen);
      weiter = s.quelle.optionen && s.quelle.optionen.alleUeben ? plan.length + uebung.length : plan.length;
    }
    $("fertig-weiter").hidden = weiter === 0;
    $("fertig-weiter").textContent = `NÄCHSTE RUNDE · ${Math.min(RUNDE, weiter)} KARTEN`;
    zustand.letzteQuelle = s.quelle;
    zustand.sitzung = null;
    zeige("fertig");
  }

  function naechsteRunde() {
    const q = zustand.letzteQuelle;
    if (q) starteLernen(q.karten, q.titel, q.optionen);
  }

  // ---------- Klausur-Ergebnis ----------

  function zeigeKlausurErgebnis(s) {
    const k = s.klausur;
    const fragen = s.schlange.length;
    const prozent = L.pruefungsProzent(k.gewusst, k.unsicher, fragen);
    const sekunden = Math.round((Date.now() - k.start) / 1000);
    const zeile = { modul: k.modul, fragen, gewusst: k.gewusst, unsicher: k.unsicher, sekunden, falsch: k.falsch };
    zustand.pruefungen.unshift({ ...zeile, zeit: new Date().toISOString() });
    schreibe("pruefungen", "insert", zeile);

    $("ergebnis-zahl").textContent = prozent;
    $("ergebnis-text").textContent = `${k.gewusst} gewusst · ${k.unsicher} unsicher · ${k.falsch.length} nicht gewusst · ${Math.max(1, Math.round(sekunden / 60))} min`;
    const vorher = zustand.pruefungen.filter((p) => p.modul === k.modul)[1];
    $("ergebnis-vergleich").textContent = vorher
      ? `Letztes Mal: ${L.pruefungsProzent(vorher.gewusst, vorher.unsicher, vorher.fragen)} %`
      : "Erste Simulation – ab jetzt siehst du die Entwicklung.";

    const liste = $("ergebnis-liste");
    liste.innerHTML = "";
    for (const id of k.falsch) {
      const karte = zustand.kartenNachId.get(id);
      if (!karte) continue;
      const d = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = karte.frage.replace(/[*_`]|\$+/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
      const a = document.createElement("div");
      a.className = "antwort";
      schreibeMarkdown(a, karte.antwort);
      d.append(sum, a);
      liste.appendChild(d);
    }
    $("ergebnis-liste-titel").hidden = k.falsch.length === 0;
    $("ergebnis-ueben").hidden = k.falsch.length === 0;
    zustand.letzteKlausurFalsch = k.falsch;
    zustand.sitzung = null;
    zeige("ergebnis");
  }

  function uebeFalscheAusKlausur() {
    const ks = (zustand.letzteKlausurFalsch || []).map((id) => zustand.kartenNachId.get(id)).filter(Boolean);
    if (ks.length) starteLernen(ks, "Nicht gewusst", { alleUeben: true });
  }

  // ==========================================
  // HILFEN
  // ==========================================

  function zeige(name) {
    for (const v of document.querySelectorAll(".ansicht")) v.hidden = v.id !== "ansicht-" + name;
    $("laden").hidden = true;
  }

  let meldungTimer = null;
  function meldung(text) {
    const m = $("meldung");
    m.textContent = text;
    m.hidden = false;
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => (m.hidden = true), 4500);
  }

  function fehlerSeite(text) {
    $("laden").textContent = text;
    $("laden").style.padding = "24px";
    $("laden").hidden = false;
  }

  function mische(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function schreibeMarkdown(el, text) {
    el.innerHTML = L.markdown(text);
    if (window.renderMathInElement) {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    }
  }
})();
