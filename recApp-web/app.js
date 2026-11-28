/* recApp – Oberfläche, Datenzugriff und Offline-Betrieb */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const L = window.Logik;

  const RUNDE = 20;                         // Karten pro Runde
  const KLAUSUR_FRAGEN = 20;                // Fragen im Klausur-Modus
  const CACHE_DATEN = "recapp-daten";       // zuletzt geladener Stand (für offline)
  const CACHE_SCHLANGE = "recapp-schlange"; // Änderungen, die noch zu Supabase müssen
  const CACHE_SKRIPTE = "recapp-skripte";   // Skripte zum Nachschlagen (offline)
  const VORTRAEGE = "recapp-vortraege";     // wann welches Thema vorgetragen wurde (nur dieses Gerät)

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
    modulFarbe: new Map(),    // Modul → Kennfarbe (wie auf der Startseite)
    skripte: null,            // stapel_id → Text (null = noch nicht geladen)
    offenVortrag: new Set(),
    vortrag: null,            // laufender Vortrag (Reiter „Vortragen“)
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
      if (document.visibilityState === "visible") behalteBildschirmAn();
      if (document.visibilityState === "visible" && !zustand.sitzung && !zustand.vortrag && zustand.heute && zustand.heute !== L.datum(new Date())) {
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
    for (const b of document.querySelectorAll("#reiter button")) {
      b.addEventListener("click", () => (b.dataset.ziel === "vortraege" ? zeigeVortraege() : zeigeStart()));
    }
    $("vortrag-zurueck").addEventListener("click", () => { beendeVortrag(false); zeigeVortraege(); });
    $("vortrag-knopf").addEventListener("click", vortragKnopf);
    $("skript-oeffnen").addEventListener("click", oeffneSkript);
    $("skript-zurueck").addEventListener("click", schliesseSkript);
    $("buehne").addEventListener("click", () => zustand.vortrag && reagiere(L.ANSTUPSEN, true));
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
      localStorage.removeItem(CACHE_SKRIPTE);
    } catch (e) { /* egal */ }
    zustand.skripte = null;
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
      ? `OFFLINE${n > 0 ? ` · ${n} warten` : ""}`
      : `${n} werden übertragen`;
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
    const ziel = zustand.tagesziel;
    const gelernt = e.gelernt || 0;
    const rest = Math.max(0, ziel - gelernt);

    // Headline = Lage des Tages
    $("ziel-text").innerHTML = e.geschafft
      ? (gelernt >= ziel ? 'Ziel <span class="rot">erreicht.</span>' : 'Alles <span class="rot">erledigt.</span>')
      : `Noch <span class="rot">${rest}</span> ${rest === 1 ? "Karte" : "Karten"}.`;

    // Kennzahlen
    $("serie-zahl").textContent = info.serie;
    $("serie-text").textContent = e.geschafft ? "heute geschafft" : info.serie === 1 ? "Tag" : "Tage";
    $("ziel-zahl").textContent = Math.min(gelernt, ziel);
    $("ziel-von").textContent = `/${ziel}`;
    $("ziel-balken").style.width = `${Math.min(100, (gelernt / ziel) * 100)}%`;
    $("offen-text").textContent = offen;
    $("offen-neben").textContent = h.ueberfaellig ? `${h.ueberfaellig} überfällig` : offen ? `${h.neu.length} neu` : "";

    // Klausur-Countdown (nächste Klausur in den kommenden 60 Tagen)
    const naechste = [...zustand.module.entries()]
      .filter(([name, t]) => t && !name.startsWith("Klausur-Pool") && L.tageBis(zustand.heute, t) >= 0 && L.tageBis(zustand.heute, t) <= 60)
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))[0];
    $("klausur-hinweis").hidden = !naechste;
    if (naechste) {
      const d = L.tageBis(zustand.heute, naechste[1]);
      $("klausur-hinweis").textContent = (d === 0 ? "Klausur heute" : `Klausur in ${d} ${d === 1 ? "Tag" : "Tagen"}`) + " · " + naechste[0];
    }

    // Eine Hauptaktion, Rest als Textlink
    $("lernen-start").innerHTML = (offen > 0 ? "Runde starten" : "Trotzdem üben") + ' <span class="pfeil">→</span>';
    const schwierig = zustand.karten.filter((k) => L.istSchwierig(zustand.fortschritt.get(k.id)));
    $("schwierig-start").hidden = schwierig.length === 0;
    $("schwierig-start").textContent = `Schwierige Karten · ${schwierig.length}`;

    zeigeKalender(info.pausen);
    zeigeSchwaechen();
    zeigeModule();

    const w = L.woche(zustand.lerntage, zustand.heute);
    $("bestand").textContent = `Woche ${w.karten} Karten · ${Math.round(w.sekunden / 60)} min · längste Serie ${info.laengste}`;
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
      d.title = tag + (e?.gelernt ? ` · ${e.gelernt} Karten` : "") + (pausen.has(tag) ? " · Pause-Tag" : "");
      box.appendChild(d);
    }
  }

  /** Eine Listenzeile: Titel, eine Zeile Nebeninfo, Wert rechts. */
  function zeile(titel, neben, wert, klick, extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "zeile" + (extra ? " " + extra : "");
    b.innerHTML = `<span><span class="titel"></span><span class="neben"></span></span><span class="wert"></span>`;
    b.querySelector(".titel").textContent = titel;
    b.querySelector(".neben").textContent = neben || "";
    b.querySelector(".neben").hidden = !neben;
    b.querySelector(".wert").textContent = wert;
    b.addEventListener("click", klick);
    return b;
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
      const z = zeile(st.titel, st.modul, `${Math.round(s.quote * 100)} %`, () => starteLernen(ks, st.titel, { alleUeben: true }));
      z.querySelector(".wert").classList.add("rot");
      box.appendChild(z);
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
      const farbe = pool ? "rot" : MODULFARBEN[farbIndex++ % MODULFARBEN.length];
      zustand.modulFarbe.set(modul, farbe);
      const stapelListe = [...zustand.stapel.values()]
        .filter((s) => s.modul === modul)
        .sort((a, b) => a.reihenfolge - b.reihenfolge || a.titel.localeCompare(b.titel, "de"));
      const kartenModul = zustand.karten.filter((k) => modulVon(k) === modul);
      const hm = heuteIn(kartenModul);
      const t = klausurVon(modul);
      const d = t ? L.tageBis(zustand.heute, t) : null;
      const neben = (pool ? modul.replace(/^Klausur-Pool\s*/, "") + " · " : "") + `${L.sicherProzent(kartenModul, zustand.fortschritt)} % sicher`
        + (d !== null && d >= 0 ? ` · Klausur in ${d} ${d === 1 ? "Tag" : "Tagen"}` : "");
      const offen = zustand.offenModule.has(modul);

      const kopf = zeile(pool ? "Klausur-Pool" : modul, neben, "", () => {
        offen ? zustand.offenModule.delete(modul) : zustand.offenModule.add(modul);
        zeigeModule();
      }, "modul" + (pool ? " pool" : "") + (offen ? " offen" : ""));
      const q = document.createElement("span");
      q.className = "quadrat " + farbe;
      kopf.querySelector(".titel").prepend(q);
      kopf.setAttribute("aria-expanded", String(offen));
      setzeAnzahl(kopf.querySelector(".wert"), hm.faellig.length + hm.neu.length + hm.poolNeu.length, pool ? kartenModul.length : undefined);
      box.appendChild(kopf);

      if (offen) {
        const liste = document.createElement("div");
        liste.className = "unterliste";
        if (pool) liste.appendChild(klausurZeile(modul, kartenModul));
        liste.appendChild(stapelZeile(pool ? `Alle ${kartenModul.length} zusammen` : "Ganzes Modul", kartenModul, modul));
        for (const s of stapelListe) {
          const ks = zustand.karten.filter((k) => k.stapel_id === s.id);
          liste.appendChild(stapelZeile(s.titel, ks, s.titel));
        }
        box.appendChild(liste);
      }
    });
  }

  function stapelZeile(titel, karten, sitzungsTitel) {
    const h = heuteIn(karten);
    const z = zeile(titel, `${L.sicherProzent(karten, zustand.fortschritt)} % sicher`, "", () => starteLernen(karten, sitzungsTitel));
    setzeAnzahl(z.querySelector(".wert"), h.faellig.length + h.neu.length + h.poolNeu.length, karten.length);
    return z;
  }

  /** Zeile „Klausur simulieren“ mit den letzten Ergebnissen. */
  function klausurZeile(modul, karten) {
    const letzte = zustand.pruefungen.filter((p) => p.modul === modul).slice(0, 4).reverse();
    const verlauf = letzte.map((p) => L.pruefungsProzent(p.gewusst, p.unsicher, p.fragen) + " %").join(" → ");
    const z = zeile(`Klausur simulieren · ${Math.min(KLAUSUR_FRAGEN, karten.length)} Fragen`, verlauf ? `Zuletzt ${verlauf}` : "", "→", () => starteKlausur(modul, karten), "klausur-zeile");
    z.querySelector(".wert").classList.add("rot");
    return z;
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
    const texte = { richtig: "Richtig", falsch: "Noch nicht", weissnicht: "Kommt gleich noch einmal", selbst: "Gewusst?" };
    urteil.className = "urteil " + (art === "richtig" ? "richtig" : art === "selbst" ? "neutral" : "falsch");
    urteil.textContent = texte[art];

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
    $("fertig-text").textContent = `${quote} % beim ersten Versuch · ${min} min · ${s.titel}`;

    const info = L.serienInfo(zustand.lerntage, zustand.heute);
    const e = heuteEintrag();
    const rest = zustand.tagesziel - (e.gelernt || 0);
    $("fertig-serie").textContent = e.geschafft
      ? `Serie ${info.serie} · heute geschafft`
      : `Noch ${rest} bis zum Tagesziel`;

    // Gibt es in derselben Auswahl noch etwas? Dann „nächste Runde“ anbieten
    let weiter = 0;
    if (s.quelle) {
      const { plan, uebung } = stelleRundeZusammen(s.quelle.karten, s.quelle.optionen);
      weiter = s.quelle.optionen && s.quelle.optionen.alleUeben ? plan.length + uebung.length : plan.length;
    }
    $("fertig-weiter").hidden = weiter === 0;
    $("fertig-weiter").innerHTML = `Nächste Runde · ${Math.min(RUNDE, weiter)} <span class="pfeil">→</span>`;
    $("fertig-zurueck").className = weiter === 0 ? "knopf haupt" : "textlink";   // immer genau eine Hauptaktion
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
      : "";

    const liste = $("ergebnis-liste");
    liste.innerHTML = "";
    for (const id of k.falsch) {
      const karte = zustand.kartenNachId.get(id);
      if (!karte) continue;
      const d = document.createElement("details");
      const sum = document.createElement("summary");
      const kurz = karte.frage.replace(/[*_`]|\$+/g, "").replace(/\s+/g, " ").trim();
      sum.textContent = kurz.length > 160 ? kurz.slice(0, 160).replace(/\s+\S*$/, "") + " …" : kurz;
      const a = document.createElement("div");
      a.className = "antwort";
      schreibeMarkdown(a, karte.antwort);
      d.append(sum, a);
      liste.appendChild(d);
    }
    $("ergebnis-liste-titel").hidden = k.falsch.length === 0;
    $("ergebnis-ueben").hidden = k.falsch.length === 0;
    $("ergebnis-zurueck").className = k.falsch.length === 0 ? "knopf haupt" : "textlink";
    zustand.letzteKlausurFalsch = k.falsch;
    zustand.sitzung = null;
    zeige("ergebnis");
  }

  function uebeFalscheAusKlausur() {
    const ks = (zustand.letzteKlausurFalsch || []).map((id) => zustand.kartenNachId.get(id)).filter(Boolean);
    if (ks.length) starteLernen(ks, "Nicht gewusst", { alleUeben: true });
  }

  // ==========================================
  // VORTRAGEN (Reiter nur auf dem iPhone)
  // Lauscher hört nicht wirklich zu: Er reagiert in zufälligen Abständen mit einer zufälligen
  // Reaktion – das reicht, damit es sich anfühlt, als würde jemand zuhören (Placebo).
  // ==========================================

  function zeigeVortraege() {
    if (!$("lauscher-klein").firstElementChild) {
      $("lauscher-klein").appendChild($("lauscher-vorlage").content.firstElementChild.cloneNode(true));
    }
    zeigeVortragsModule();
    zeige("vortraege");
    ladeSkripte();                                  // im Hintergrund, fürs Nachschlagen
  }

  function vortraege() {
    try {
      return JSON.parse(localStorage.getItem(VORTRAEGE) || "{}");
    } catch (e) {
      return {};
    }
  }

  function zeigeVortragsModule() {
    const box = $("vortrag-module");
    box.innerHTML = "";
    const v = vortraege();
    const module = [...new Set([...zustand.stapel.values()].map((s) => s.modul))]
      .filter((m) => !istPoolModul(m))
      .sort((a, b) => a.localeCompare(b, "de"));
    if (!module.length) {
      box.innerHTML = '<p class="neben gross">Noch keine Themen – erst in recApp Sync hochladen.</p>';
      return;
    }
    for (const modul of module) {
      const stapelListe = [...zustand.stapel.values()]
        .filter((s) => s.modul === modul)
        .sort((a, b) => a.reihenfolge - b.reihenfolge || a.titel.localeCompare(b.titel, "de"));
      const offen = zustand.offenVortrag.has(modul);
      const erledigt = stapelListe.filter((s) => v[s.id]).length;
      const kopf = zeile(modul, `${erledigt} von ${stapelListe.length} vorgetragen`, "", () => {
        offen ? zustand.offenVortrag.delete(modul) : zustand.offenVortrag.add(modul);
        zeigeVortragsModule();
      }, "modul" + (offen ? " offen" : ""));
      const q = document.createElement("span");
      q.className = "quadrat " + (zustand.modulFarbe.get(modul) || "");
      kopf.querySelector(".titel").prepend(q);
      kopf.setAttribute("aria-expanded", String(offen));
      box.appendChild(kopf);
      if (!offen) continue;
      const liste = document.createElement("div");
      liste.className = "unterliste";
      for (const s of stapelListe) {
        const e = v[s.id];
        const neben = e ? `${L.seitText(e.tag, L.datum(new Date()))} · ${L.dauerText(e.sekunden)} min` : "noch nicht vorgetragen";
        liste.appendChild(zeile(s.titel, neben, "→", () => starteVortrag(s)));
      }
      box.appendChild(liste);
    }
  }

  // ---------- Skripte laden (Supabase-Tabelle „skripte“, offline aus dem Speicher) ----------

  let skripteLaden = null;
  function ladeSkripte() {
    if (zustand.skripte && !zustand.skripteAlt) return Promise.resolve();
    if (!zustand.skripte) {
      try {
        const d = JSON.parse(localStorage.getItem(CACHE_SKRIPTE) || "null");
        if (d) {
          zustand.skripte = new Map(d);
          zustand.skripteAlt = true;             // gleich trotzdem frisch laden
        }
      } catch (e) { /* ohne Speicher */ }
    }
    if (!skripteLaden) {
      skripteLaden = (async () => {
        try {
          const { data, error } = await zustand.db.from("skripte").select("stapel_id, text").range(0, 9999);
          if (error) throw error;
          zustand.skripte = new Map(data.map((r) => [r.stapel_id, r.text]));
          zustand.skripteAlt = false;
          try {
            localStorage.setItem(CACHE_SKRIPTE, JSON.stringify([...zustand.skripte]));
          } catch (e) { /* Speicher voll – dann nur online */ }
        } catch (e) {
          if (!zustand.skripte) zustand.skripte = new Map();   // Tabelle fehlt oder offline: Lernkarten als Ersatz
        } finally {
          skripteLaden = null;
        }
      })();
    }
    return skripteLaden;
  }

  // ---------- Vortrag ----------

  function starteVortrag(stapel) {
    const buehne = $("buehne");
    if (!buehne.firstElementChild) buehne.appendChild($("lauscher-vorlage").content.firstElementChild.cloneNode(true));
    zustand.vortrag = { stapel, phase: "bereit", start: 0, sekunden: 0, letzte: null, timer: [], uhr: null, sperre: null };
    $("vortrag-modul").textContent = stapel.modul;
    $("vortrag-titel").textContent = stapel.titel;
    $("vortrag-zeit").textContent = "0:00";
    $("vortrag-zeit").classList.remove("laeuft");
    setzeVortragsKnopf("Loslegen", true);
    $("skript-oeffnen").hidden = false;
    lauscher().setAttribute("class", "lauscher");
    sage("Ich bin ganz Ohr.");
    zeige("vortrag");
    lebe();
  }

  function setzeVortragsKnopf(text, pfeil) {
    $("vortrag-knopf").innerHTML = text + (pfeil ? ' <span class="pfeil">→</span>' : "");
  }

  function vortragKnopf() {
    const v = zustand.vortrag;
    if (!v) return;
    if (v.phase === "bereit") {
      v.phase = "laeuft";
      v.start = Date.now();
      setzeVortragsKnopf("Fertig", false);
      $("vortrag-zeit").classList.add("laeuft");
      v.uhr = setInterval(zeigeZeit, 500);
      behalteBildschirmAn();
      sage("");
      reagiere({ ...L.REAKTIONEN[0], text: "" }, false);   // kurz nicken: „los geht's“
      planeReaktion(4000 + Math.random() * 2000);
    } else if (v.phase === "laeuft") {
      beendeVortrag(true);
    } else {
      starteVortrag(v.stapel);                             // „Noch einmal“
    }
  }

  function zeigeZeit() {
    const v = zustand.vortrag;
    if (!v || v.phase !== "laeuft") return;
    const t = L.dauerText((Date.now() - v.start) / 1000);
    $("vortrag-zeit").textContent = t;
    $("skript-zeit").textContent = t;
  }

  /** Nächste Zufallsreaktion einplanen – nur während des Vortrags und solange Lauscher zu sehen ist. */
  function planeReaktion(ms) {
    const v = zustand.vortrag;
    if (!v) return;
    clearTimeout(v.reaktion);
    v.reaktion = setTimeout(() => {
      if (!zustand.vortrag || v.phase !== "laeuft") return;
      if ($("ansicht-vortrag").hidden) return planeReaktion(1500);
      const r = L.naechsteReaktion(v.letzte);
      v.letzte = r.name;
      reagiere(r, true);
      planeReaktion(r.dauer + r.pause);
    }, ms);
  }

  /** Spielt eine Reaktion ab (Klassen am SVG) und zeigt ggf. einen kurzen Satz. */
  function reagiere(r, mitText) {
    const svg = lauscher();
    if (!svg) return;
    const v = zustand.vortrag;
    clearTimeout(v && v.reaktionEnde);
    svg.setAttribute("class", "lauscher");
    void svg.getBoundingClientRect();                    // Animation neu starten
    svg.setAttribute("class", ("lauscher " + r.klassen).trim());
    if (r.name === "blick" || r.name === "nachdenken") schaue(r.name === "nachdenken" ? -4 : null, r.name === "nachdenken" ? -5 : null);
    const text = mitText ? (r.text !== undefined ? r.text : r.texte[Math.floor(Math.random() * r.texte.length)]) : "";
    if (text) sage(text, r.dauer + 1400);
    const ende = setTimeout(() => {
      if (lauscher() === svg) svg.setAttribute("class", "lauscher");
      if (r.name === "nachdenken") schaue(0, 0);
    }, r.dauer);
    if (v) v.reaktionEnde = ende;
  }

  let textTimer = null;
  function sage(text, dauer) {
    const el = $("lauscher-text");
    clearTimeout(textTimer);
    if (!text) {
      el.classList.remove("zeigen");
      return;
    }
    el.textContent = text;
    el.classList.add("zeigen");
    if (dauer) textTimer = setTimeout(() => el.classList.remove("zeigen"), dauer);
  }

  function lauscher() {
    return $("buehne").querySelector(".lauscher");
  }

  /** Augen bewegen (ohne Angabe: zufällig ein Stück) */
  function schaue(x, y) {
    const svg = lauscher();
    if (!svg) return;
    const zx = x === null || x === undefined ? Math.round((Math.random() * 2 - 1) * 4) : x;
    const zy = y === null || y === undefined ? Math.round((Math.random() * 2 - 1) * 2) : y;
    svg.style.setProperty("--bx", zx + "px");
    svg.style.setProperty("--by", zy + "px");
  }

  /** Blinzeln und Umherschauen laufen immer (auch vor dem Start) – Lauscher soll lebendig wirken. */
  function lebe() {
    const v = zustand.vortrag;
    if (!v) return;
    const blinzeln = () => {
      if (zustand.vortrag !== v) return;
      const svg = lauscher();
      svg.classList.add("blinzeln");
      setTimeout(() => svg.classList.remove("blinzeln"), 140);
      v.timer.push(setTimeout(blinzeln, 2500 + Math.random() * 3500));
    };
    const umsehen = () => {
      if (zustand.vortrag !== v) return;
      if (!/r-nachdenken/.test(lauscher().getAttribute("class"))) schaue(Math.random() < 0.4 ? 0 : null, Math.random() < 0.4 ? 0 : null);
      v.timer.push(setTimeout(umsehen, 2000 + Math.random() * 3000));
    };
    v.timer.push(setTimeout(blinzeln, 1200), setTimeout(umsehen, 1800));
  }

  /** fertig = true: Zeit merken und jubeln; false: abbrechen (ab 30 s wird trotzdem gemerkt). */
  function beendeVortrag(fertig) {
    const v = zustand.vortrag;
    if (!v) return;
    clearInterval(v.uhr);
    clearTimeout(v.reaktion);
    lasseBildschirmLos();
    const sekunden = v.phase === "laeuft" ? Math.round((Date.now() - v.start) / 1000) : 0;
    if (sekunden >= 30 || (fertig && sekunden > 0)) {
      const alle = vortraege();
      alle[v.stapel.id] = { tag: L.datum(new Date()), sekunden };
      try {
        localStorage.setItem(VORTRAEGE, JSON.stringify(alle));
      } catch (e) { /* egal */ }
    }
    if (!fertig) {
      v.timer.forEach(clearTimeout);
      clearTimeout(v.reaktionEnde);
      sage("");
      zustand.vortrag = null;
      return;
    }
    v.phase = "ende";
    $("vortrag-zeit").textContent = L.dauerText(sekunden);
    $("vortrag-zeit").classList.remove("laeuft");
    reagiere(L.JUBELN, true);
    sage(`Gut erklärt. ${L.dauerText(sekunden)} min.`);
    setzeVortragsKnopf("Noch einmal", true);
    $("skript-oeffnen").hidden = true;
  }

  // ---------- Skript ----------

  async function oeffneSkript() {
    const v = zustand.vortrag;
    if (!v) return;
    $("skript-label").textContent = v.stapel.modul;
    $("skript-zeit").textContent = v.phase === "laeuft" ? $("vortrag-zeit").textContent : "";
    const box = $("skript-inhalt");
    box.innerHTML = '<p class="neben gross">Lade …</p>';
    zeige("skript");
    window.scrollTo(0, 0);
    await ladeSkripte();
    if (zustand.vortrag !== v || $("ansicht-skript").hidden) return;
    const text = zustand.skripte && zustand.skripte.get(v.stapel.id);
    if (text) {
      schreibeMarkdown(box, text, { skript: true });
      return;
    }
    // Ersatz: die Lernkarten des Themas als Spickzettel
    box.innerHTML = `<h2></h2><p class="neben gross">Kein Skript hochgeladen – hier die Lernkarten.</p>`;
    box.querySelector("h2").textContent = v.stapel.titel;
    for (const k of zustand.karten.filter((x) => x.stapel_id === v.stapel.id)) {
      const d = document.createElement("div");
      d.className = "skript-karte";
      d.innerHTML = '<div class="frage-klein"></div><div class="antwort"></div>';
      schreibeMarkdown(d.firstChild, k.frage);
      schreibeMarkdown(d.lastChild, k.antwort);
      box.appendChild(d);
    }
  }

  function schliesseSkript() {
    const v = zustand.vortrag;
    if (!v) return zeigeVortraege();
    zeige("vortrag");
    window.scrollTo(0, 0);
    if (v.phase === "laeuft") reagiere({ ...L.REAKTIONEN[1], text: "Weiter geht's." }, true);
  }

  // ---------- Bildschirm während des Vortrags anlassen ----------

  async function behalteBildschirmAn() {
    const v = zustand.vortrag;
    if (!v || v.phase !== "laeuft" || !("wakeLock" in navigator)) return;
    try {
      v.sperre = await navigator.wakeLock.request("screen");
    } catch (e) { /* nicht erlaubt – egal */ }
  }

  function lasseBildschirmLos() {
    const v = zustand.vortrag;
    if (v && v.sperre) v.sperre.release().catch(() => {});
    if (v) v.sperre = null;
  }

  // ==========================================
  // HILFEN
  // ==========================================

  function zeige(name) {
    for (const v of document.querySelectorAll(".ansicht")) v.hidden = v.id !== "ansicht-" + name;
    $("laden").hidden = true;
    // Reiter-Leiste nur auf den beiden Übersichten (und per CSS nur auf dem iPhone)
    const mitReiter = name === "start" || name === "vortraege";
    $("reiter").hidden = !mitReiter;
    $("app").classList.toggle("mit-reiter", mitReiter);
    for (const b of document.querySelectorAll("#reiter button")) b.classList.toggle("aktiv", b.dataset.ziel === name);
    if (mitReiter) window.scrollTo(0, 0);
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

  function schreibeMarkdown(el, text, optionen) {
    el.innerHTML = L.markdown(text, optionen);
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
