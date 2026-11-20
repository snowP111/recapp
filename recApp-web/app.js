/* recApp – Oberfläche und Datenzugriff */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const L = window.Logik;

  const zustand = {
    db: null,
    heute: "",
    stapel: new Map(),        // id → {id, modul, titel, reihenfolge}
    karten: [],               // aktive Karten
    fortschritt: new Map(),   // karte_id → {fach, faellig, richtig, falsch}
    lerntage: new Map(),      // tag → {gelernt, richtig, neue, geschafft}
    neueProTag: 20,
    abstaende: L.STANDARD_ABSTAENDE,
    offenModule: new Set(),
    sitzung: null,
  };

  // ==========================================
  // START
  // ==========================================

  window.addEventListener("DOMContentLoaded", start);

  async function start() {
    if (!window.supabase || !window.supabase.createClient) {
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

    const { data } = await zustand.db.auth.getSession();
    if (data && data.session) {
      await ladeUndZeigeStart();
    } else {
      zeige("login");
    }
  }

  function verbindeKnoepfe() {
    $("login-form").addEventListener("submit", anmelden);
    $("abmelden").addEventListener("click", abmelden);
    $("alles-lernen").addEventListener("click", () => starteLernen(zustand.karten, "Alles", { ohnePoolNeu: true }));
    $("lernen-zurueck").addEventListener("click", () => beendeSitzung(false));
    $("pruefen").addEventListener("click", pruefe);
    $("weiss-nicht").addEventListener("click", weissNicht);
    $("aufdecken").addEventListener("click", aufdecken);
    $("weiter").addEventListener("click", () => bewerte(zustand.sitzung.ergebnis));
    $("doch-richtig").addEventListener("click", dochRichtig);
    $("gewusst").addEventListener("click", () => bewerte(true));
    $("unsicher").addEventListener("click", () => bewerte(L.UNSICHER));
    $("nicht-gewusst").addEventListener("click", () => bewerte(false));
    $("fertig-zurueck").addEventListener("click", () => ladeUndZeigeStart());
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
    await zustand.db.auth.signOut();
    zeige("login");
  }

  // ==========================================
  // DATEN
  // ==========================================

  async function ladeUndZeigeStart() {
    $("laden").hidden = false;
    try {
      await ladeDaten();
      await markiereLeerenTag();
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
    const [st, ka, fo, le, ei] = await Promise.all([
      db.from("stapel").select("id, modul, titel, reihenfolge"),
      db.from("karten").select("id, stapel_id, frage, antwort, typ, schluesselwoerter").eq("aktiv", true).range(0, 9999),
      db.from("fortschritt").select("karte_id, fach, faellig, richtig, falsch").range(0, 9999),
      db.from("lerntage").select("*").order("tag", { ascending: false }).limit(400),
      db.from("einstellungen").select("schluessel, wert"),
    ]);
    for (const r of [st, ka, fo, le, ei]) {
      if (r.error) throw r.error;
    }
    zustand.heute = L.datum(new Date());
    zustand.stapel = new Map(st.data.map((s) => [s.id, s]));
    zustand.karten = ka.data;
    zustand.fortschritt = new Map(fo.data.map((f) => [f.karte_id, f]));
    zustand.lerntage = new Map(le.data.map((t) => [t.tag, t]));
    for (const { schluessel, wert } of ei.data) {
      if (schluessel === "neue_pro_tag") zustand.neueProTag = parseInt(wert, 10) || 20;
      if (schluessel === "abstaende_tage") {
        const a = wert.split(",").map((x) => parseInt(x, 10));
        if (a.length === 6 && a.every((x) => x > 0)) zustand.abstaende = a;
      }
    }
  }

  function heuteEintrag() {
    return zustand.lerntage.get(zustand.heute) || { tag: zustand.heute, gelernt: 0, richtig: 0, neue: 0, geschafft: false };
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

  /** Ist heute nichts (mehr) fällig, zählt der Tag für die Serie. */
  async function markiereLeerenTag() {
    if (offenGesamt() === 0 && !heuteEintrag().geschafft && zustand.karten.length > 0) {
      await speichereLerntag({ ...heuteEintrag(), geschafft: true });
    }
  }

  async function speichereLerntag(eintrag) {
    const zeile = {
      tag: zustand.heute,
      gelernt: eintrag.gelernt || 0,
      richtig: eintrag.richtig || 0,
      neue: eintrag.neue || 0,
      geschafft: Boolean(eintrag.geschafft),
    };
    zustand.lerntage.set(zustand.heute, zeile);
    const { error } = await zustand.db.from("lerntage").upsert(zeile);
    if (error) meldung("Lerntag nicht gespeichert: " + error.message);
  }

  // ==========================================
  // STARTSEITE
  // ==========================================

  function zeigeStart() {
    const serie = L.serie(zustand.lerntage, zustand.heute);
    const offen = offenGesamt();
    const geschafft = heuteEintrag().geschafft;

    $("serie-zahl").textContent = serie;
    $("serie-text").textContent = geschafft ? "Tage – heute geschafft" : (serie > 0 ? "Tage – heute noch offen" : "Tage am Stück");
    $("heute-zahl").textContent = offen;
    $("heute-text").textContent = offen === 1 ? "Karte offen" : "Karten offen";
    $("alles-lernen").textContent = offen > 0 ? `ALLES LERNEN (${offen})` : "ALLES GESCHAFFT – TROTZDEM ÜBEN";

    zeigeKalender();
    zeigeModule();
    const laengste = L.laengsteSerie(zustand.lerntage);
    $("bestand").textContent = `${zustand.karten.length} Karten · ${zustand.stapel.size} Stapel · längste Serie ${laengste} Tage`;
    zeige("start");
  }

  function zeigeKalender() {
    const box = $("kalender");
    box.innerHTML = "";
    for (let i = 27; i >= 0; i--) {
      const tag = L.plusTage(zustand.heute, -i);
      const e = zustand.lerntage.get(tag);
      const d = document.createElement("div");
      d.className = "tag" + (e?.geschafft ? " geschafft" : e?.gelernt ? " gelernt" : "") + (i === 0 ? " heute" : "");
      d.title = tag;
      box.appendChild(d);
    }
    const leg = document.createElement("div");
    leg.className = "legende";
    leg.textContent = "Letzte 4 Wochen · rot = geschafft · grau = gelernt";
    box.appendChild(leg);
  }

  const MODULFARBEN = ["pink", "cyan", "lime", "orange", "violett", "gelb"];
  const istPoolModul = (modul) => [...zustand.stapel.values()].some((s) => s.modul === modul && s.id.startsWith(L.POOL_PRAEFIX));

  function zeigeModule() {
    const box = $("module");
    box.innerHTML = "";
    const alle = [...new Set([...zustand.stapel.values()].map((s) => s.modul))].sort((a, b) => a.localeCompare(b, "de"));
    // Klausur-Pools zuerst – sie sind die Klausurvorbereitung
    const module = [...alle.filter(istPoolModul), ...alle.filter((m) => !istPoolModul(m))];
    let farbIndex = 0;

    module.forEach((modul) => {
      const pool = istPoolModul(modul);
      const stapelListe = [...zustand.stapel.values()]
        .filter((s) => s.modul === modul)
        .sort((a, b) => a.reihenfolge - b.reihenfolge || a.titel.localeCompare(b.titel, "de"));
      const kartenModul = zustand.karten.filter((k) => zustand.stapel.get(k.stapel_id)?.modul === modul);
      const hm = heuteIn(kartenModul);

      const wrap = document.createElement("div");
      wrap.className = "modul";
      const kopf = document.createElement("button");
      kopf.type = "button";
      kopf.className = `knopf modul-kopf kachel ${pool ? "rot pool" : MODULFARBEN[farbIndex++ % MODULFARBEN.length]}`;
      kopf.innerHTML = `<span class="name"></span><span class="anzahl"></span>`;
      const anzeige = pool ? modul.replace(/^Klausur-Pool\s*/, "") : modul;
      kopf.querySelector(".name").textContent = (zustand.offenModule.has(modul) ? "▾ " : "▸ ") + anzeige;
      setzeAnzahl(kopf.querySelector(".anzahl"), hm.faellig.length + hm.neu.length + hm.poolNeu.length, pool ? kartenModul.length : undefined);
      kopf.addEventListener("click", () => {
        zustand.offenModule.has(modul) ? zustand.offenModule.delete(modul) : zustand.offenModule.add(modul);
        zeigeModule();
      });
      wrap.appendChild(kopf);

      if (zustand.offenModule.has(modul)) {
        const liste = document.createElement("div");
        liste.className = "stapel-liste";
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
    b.innerHTML = `<span></span><span class="anzahl"></span>`;
    b.firstChild.textContent = titel;
    setzeAnzahl(b.lastChild, h.faellig.length + h.neu.length + h.poolNeu.length, karten.length);
    b.addEventListener("click", () => starteLernen(karten, sitzungsTitel));
    return b;
  }

  function setzeAnzahl(el, offen, gesamt) {
    el.textContent = gesamt === undefined ? `${offen} offen` : `${offen} / ${gesamt}`;
    el.classList.toggle("null", offen === 0);
  }

  // ==========================================
  // LERNEN
  // ==========================================

  function starteLernen(karten, titel, optionen) {
    const h = heuteIn(karten);
    // Neue Pool-Karten (ohne Tageslimit) gemischt hinten an – bei „Alles lernen“ nicht, sonst wäre die Liste riesig
    const poolNeu = optionen && optionen.ohnePoolNeu ? [] : mische([...h.poolNeu]);
    let schlange = [...h.faellig, ...h.neu, ...poolNeu];
    let ueben = false;
    if (schlange.length === 0) {
      if (karten.length === 0) return meldung("Hier gibt es keine Karten.");
      if (!confirm(`In „${titel}“ ist heute nichts fällig. Trotzdem alle ${karten.length} Karten üben? (Zählt nicht für den Wiederholungsplan.)`)) return;
      schlange = mische([...karten]);
      ueben = true;
    }
    zustand.sitzung = {
      titel, ueben,
      schlange: schlange.map((k) => k.id),
      pos: 0,
      gewertet: new Set(),   // Karten, die in dieser Sitzung schon zählten
      richtig: 0, gelernt: 0,
      ergebnis: false,
      antwort: "",
    };
    zeige("lernen");
    zeigeKarte();
  }

  function aktuelleKarte() {
    const s = zustand.sitzung;
    const id = s.schlange[s.pos];
    return zustand.karten.find((k) => k.id === id);
  }

  function zeigeKarte() {
    const s = zustand.sitzung;
    const k = aktuelleKarte();
    if (!k) return beendeSitzung(true);

    $("fortschritt-text").textContent = `${s.pos + 1} / ${s.schlange.length}`;
    $("fortschritt-balken").style.width = `${(s.pos / s.schlange.length) * 100}%`;
    $("karte-stapel").textContent = (zustand.stapel.get(k.stapel_id)?.titel || "") + (s.ueben ? " · Üben" : "");
    schreibeMarkdown($("karte-frage"), k.frage);
    $("karte-frage").classList.toggle("lang", k.frage.length > 160);   // Fallstudien: Lesegröße statt Fragengröße

    const getippt = L.wirdGetippt(k);
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
    $("unsicher").hidden = !L.istPool(k);           // drei Stufen nur im Klausur-Pool (wie in Obsidian)
    $("reihe-selbst").classList.toggle("drei", L.istPool(k));
    $("doch-richtig").hidden = art !== "falsch";
    window.scrollTo(0, 0);
  }

  async function dochRichtig() {
    const k = aktuelleKarte();
    const antwort = zustand.sitzung.antwort;
    bewerte(true);
    const { error } = await zustand.db.from("einwaende").insert({ karte_id: k.id, antwort });
    if (error) meldung("Einwand nicht gespeichert: " + error.message);
  }

  /** Zählt das Ergebnis (true, false oder „unsicher“), plant die Karte neu und geht zur nächsten. */
  function bewerte(ergebnis) {
    const s = zustand.sitzung;
    const k = aktuelleKarte();
    const richtig = ergebnis === true;

    if (!s.gewertet.has(k.id)) {
      s.gewertet.add(k.id);
      s.gelernt++;
      if (richtig) s.richtig++;
      if (!s.ueben) speichereErgebnis(k, ergebnis);
    }
    if (ergebnis === false) {
      s.schlange.push(k.id);      // am Ende der Sitzung noch einmal (unsicher: morgen wieder)
    }
    s.pos++;
    if (s.pos >= s.schlange.length) {
      beendeSitzung(true);
    } else {
      zeigeKarte();
    }
  }

  function speichereErgebnis(k, ergebnis) {
    const richtig = ergebnis === true;
    const alt = zustand.fortschritt.get(k.id);
    const warNeu = (!alt || !alt.faellig) && !L.istPool(k);   // Pool-Karten belasten das Tageslimit nicht
    const neu = L.naechsterStand(alt, ergebnis, zustand.heute, zustand.abstaende);
    const zeile = { karte_id: k.id, ...neu, zuletzt: new Date().toISOString() };
    zustand.fortschritt.set(k.id, zeile);

    const e = heuteEintrag();
    const eintrag = {
      ...e,
      gelernt: (e.gelernt || 0) + 1,
      richtig: (e.richtig || 0) + (richtig ? 1 : 0),
      neue: (e.neue || 0) + (warNeu ? 1 : 0),
    };
    // Erst Lernstand und Tageskontingent aktualisieren, dann prüfen, ob noch etwas offen ist
    zustand.lerntage.set(zustand.heute, eintrag);
    eintrag.geschafft = e.geschafft || offenGesamt() === 0;

    zustand.db.from("fortschritt").upsert(zeile).then(({ error }) => {
      if (error) meldung("Lernstand nicht gespeichert: " + error.message);
    });
    speichereLerntag(eintrag);
  }

  async function beendeSitzung(fertig) {
    const s = zustand.sitzung;
    if (!fertig || !s || s.gelernt === 0) {
      zustand.sitzung = null;
      return zeigeStart();
    }
    const quote = Math.round((s.richtig / s.gelernt) * 100);
    $("fertig-zahl").textContent = s.gelernt;
    $("fertig-text").textContent = `${s.gelernt === 1 ? "Karte" : "Karten"} in „${s.titel}“ · ${quote} % beim ersten Versuch richtig` + (s.ueben ? " · Übungsrunde" : "");
    const serie = L.serie(zustand.lerntage, zustand.heute);
    const offen = offenGesamt();
    $("fertig-serie").textContent = heuteEintrag().geschafft
      ? `SERIE: ${serie} ${serie === 1 ? "TAG" : "TAGE"} – HEUTE GESCHAFFT`
      : `NOCH ${offen} ${offen === 1 ? "KARTE" : "KARTEN"} BIS ZUR SERIE`;
    zustand.sitzung = null;
    zeige("fertig");
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

  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** Kleines Markdown: fett, kursiv, Code, Wikilinks, Zeilen – Formeln bleiben für KaTeX unangetastet. */
  function markdown(text) {
    const teile = String(text).split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g);
    const html = teile.map((t, i) => {
      if (i % 2 === 1) return esc(t).replace(/\n/g, " ");   // Formel (Zeilenumbrüche würden sie zerreißen)
      return esc(t)
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/^- /gm, "• ");
    }).join("");
    return html.split(/\n+/).map((z) => `<p>${z}</p>`).join("");
  }

  function schreibeMarkdown(el, text) {
    el.innerHTML = markdown(text);
    if (window.renderMathInElement) {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    }
  }
})();
