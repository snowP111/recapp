/* recApp – Lernlogik ohne Oberfläche: Antwortprüfung, Karteikasten, Tagesziel, Serie, Statistik, Markdown.
   Läuft im Browser (window.Logik) und in Node (für Tests). */
(function (global) {
  "use strict";

  // ==========================================
  // ANTWORTPRÜFUNG
  // ==========================================

  /** Kleinschreibung, Umlaute ausschreiben, Satzzeichen weg. */
  function normalisiere(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const v = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) v[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let links = i - 1;
      v[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const oben = v[j];
        v[j] = Math.min(v[j] + 1, v[j - 1] + 1, links + (a[i - 1] === b[j - 1] ? 0 : 1));
        links = oben;
      }
    }
    return v[b.length];
  }

  /** Passt ein einzelnes Wort aus dem Schlüsselwort zu einem Wort der Antwort? */
  function wortPasst(kw, token) {
    if (token === kw) return true;
    if (kw.length >= 3 && token.includes(kw)) return true;          // "kosten" in "kostensenkung"
    if (kw.length < 4) return false;
    const erlaubt = kw.length >= 9 ? 2 : 1;
    if (Math.abs(token.length - kw.length) <= erlaubt && levenshtein(token, kw) <= erlaubt) return true;
    // Tippfehler in einem zusammengesetzten Wort: Anfang des Tokens vergleichen
    if (token.length > kw.length) {
      return levenshtein(token.slice(0, kw.length), kw) <= erlaubt;
    }
    return false;
  }

  /** Ein (evtl. mehrwortiges) Schlüsselwort ist erfüllt, wenn jedes seiner Wörter vorkommt. */
  function schluesselwortPasst(schluesselwort, tokens) {
    const teile = normalisiere(schluesselwort).split(" ").filter(Boolean);
    if (teile.length === 0) return false;
    return teile.every((kw) => tokens.some((t) => wortPasst(kw, t)));
  }

  /**
   * Prüft eine getippte Antwort.
   * gruppen: [["Kostenführerschaft","Kostenführer"],["niedrig"]] – jede Gruppe ist Pflicht,
   * innerhalb einer Gruppe reicht eine Alternative.
   * Ergebnis: { richtig, treffer: [{wort, gefunden}] }
   */
  function pruefeAntwort(antwort, gruppen) {
    const tokens = normalisiere(antwort).split(" ").filter(Boolean);
    const treffer = (gruppen || []).map((gruppe) => {
      const passend = gruppe.find((alt) => schluesselwortPasst(alt, tokens));
      return { wort: passend || gruppe[0], alternativen: gruppe, gefunden: Boolean(passend) };
    });
    return { richtig: treffer.length > 0 && treffer.every((t) => t.gefunden), treffer };
  }

  // ==========================================
  // DATUM
  // ==========================================

  function datum(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function plusTage(tag, n) {
    const [j, m, t] = tag.split("-").map(Number);
    return datum(new Date(j, m - 1, t + n));
  }

  /** Tage von „von“ bis „bis“ (beide JJJJ-MM-TT); negativ, wenn „bis“ vorbei ist. */
  function tageBis(von, bis) {
    const [a, b, c] = von.split("-").map(Number);
    const [d, e, f] = bis.split("-").map(Number);
    return Math.round((Date.UTC(d, e - 1, f) - Date.UTC(a, b - 1, c)) / 86400000);
  }

  /** Montag der Woche (ISO) – für „ein Pause-Tag pro Woche“. */
  function wochenStart(tag) {
    const [j, m, t] = tag.split("-").map(Number);
    const wt = (new Date(j, m - 1, t).getDay() + 6) % 7;   // Mo = 0 … So = 6
    return plusTage(tag, -wt);
  }

  // ==========================================
  // KARTEIKASTEN
  // ==========================================

  const STANDARD_ABSTAENDE = [1, 2, 4, 8, 16, 32];

  /** Wie viele Fächer eine falsch beantwortete Karte zurückfällt (statt ganz auf Fach 0). */
  const RUECKFALL = 2;

  /** Bewertung „unsicher“ (nur Selbstbewertung im Klausur-Pool) */
  const UNSICHER = "unsicher";

  /**
   * Neuer Lernstand nach einer Antwort. fach 0–5.
   * richtig (true) → ein Fach höher · falsch (false) → 2 Fächer zurück (mind. 0) ·
   * "unsicher" → Fach bleibt, morgen wieder dran.
   */
  function naechsterStand(stand, ergebnis, heute, abstaende) {
    const abst = abstaende && abstaende.length === 6 ? abstaende : STANDARD_ABSTAENDE;
    const altFach = stand && Number.isInteger(stand.fach) ? stand.fach : 0;
    if (ergebnis === UNSICHER) {
      return {
        fach: altFach,
        faellig: plusTage(heute, 1),
        richtig: stand?.richtig || 0,
        falsch: stand?.falsch || 0,
      };
    }
    const richtig = ergebnis === true;
    const fach = richtig ? Math.min(altFach + 1, 5) : Math.max(altFach - RUECKFALL, 0);
    return {
      fach,
      faellig: plusTage(heute, abst[fach]),
      richtig: (stand?.richtig || 0) + (richtig ? 1 : 0),
      falsch: (stand?.falsch || 0) + (richtig ? 0 : 1),
    };
  }

  /** Klausur-Pool: Stapel-ID beginnt mit „Klausur-Pool/“ (kommt von recApp Sync). */
  const POOL_PRAEFIX = "Klausur-Pool/";
  function istPool(karte) {
    return String(karte && karte.stapel_id || "").startsWith(POOL_PRAEFIX);
  }

  /** Braucht die Karte eine getippte Antwort? (sonst: aufdecken und selbst bewerten) */
  function wirdGetippt(karte) {
    return karte.typ === "tippen" && Array.isArray(karte.schluesselwoerter) && karte.schluesselwoerter.length > 0;
  }

  /**
   * Stellt die Karten für heute zusammen.
   * karten: aktive Karten; fortschritt: Map id → {fach, faellig, ...}; stapelReihenfolge: Map stapel_id → Sortierwert
   * neueFrei: wie viele neue Karten heute noch dazukommen dürfen (gilt nicht für den Klausur-Pool)
   * Ergebnis: { faellig, neu, poolNeu, ueberfaellig } – faellig = früher gelernt und heute dran (auch Pool),
   * älteste zuerst; ueberfaellig = davon schon vor heute fällig; neu = neue Karten im Tageslimit;
   * poolNeu = alle noch nie gelernten Pool-Karten (ohne Limit, zählen nicht für „offen“)
   */
  function heutigeKarten(karten, fortschritt, heute, neueFrei, stapelReihenfolge) {
    const faellig = [];
    const neu = [];
    const poolNeu = [];
    let ueberfaellig = 0;
    for (const k of karten) {
      const f = fortschritt.get(k.id);
      if (f && f.faellig) {
        if (f.faellig <= heute) {
          faellig.push(k);
          if (f.faellig < heute) ueberfaellig++;
        }
      } else if (istPool(k)) {
        poolNeu.push(k);
      } else {
        neu.push(k);
      }
    }
    const sortWert = (k) => (stapelReihenfolge && stapelReihenfolge.has(k.stapel_id) ? stapelReihenfolge.get(k.stapel_id) : 0);
    faellig.sort((a, b) => (fortschritt.get(a.id).faellig < fortschritt.get(b.id).faellig ? -1 : 1));
    neu.sort((a, b) => sortWert(a) - sortWert(b) || (a.position || 0) - (b.position || 0));
    poolNeu.sort((a, b) => sortWert(a) - sortWert(b));
    return { faellig, neu: neu.slice(0, Math.max(0, neueFrei)), poolNeu, ueberfaellig };
  }

  /** So viele Tage vor der Klausur kommt ein Modul beim Lernen zuerst dran. */
  const KLAUSUR_VORLAUF = 21;

  /**
   * Stabile Sortierung: Karten aus Modulen mit naher Klausur (0–21 Tage) zuerst, die nächste Klausur vorn.
   * Die Reihenfolge innerhalb einer Gruppe (z. B. älteste fällige zuerst) bleibt erhalten.
   * klausurVon: (karte) → "JJJJ-MM-TT" oder null
   */
  function nachKlausurSortieren(karten, klausurVon, heute) {
    const wert = (k) => {
      const t = klausurVon(k);
      if (!t) return Infinity;
      const d = tageBis(heute, t);
      return d >= 0 && d <= KLAUSUR_VORLAUF ? d : Infinity;
    };
    return karten.map((k, i) => ({ k, i, w: wert(k) }))
      .sort((a, b) => (a.w === b.w ? a.i - b.i : a.w - b.w))
      .map((x) => x.k);
  }

  // ==========================================
  // TAGESZIEL UND SERIE
  // ==========================================

  const STANDARD_TAGESZIEL = 20;

  /** Ein Tag ist geschafft, wenn das Tagesziel erreicht ist oder nichts mehr offen war. */
  function tagGeschafft(eintrag, offen, ziel) {
    if (eintrag && eintrag.geschafft) return true;
    return (eintrag && (eintrag.gelernt || 0) >= (ziel || STANDARD_TAGESZIEL)) || offen === 0;
  }

  /**
   * Serie mit Pause-Tag: Pro Woche (Mo–So) darf ein verpasster Tag die Serie überbrücken – er zählt
   * nicht mit, bricht sie aber nicht. Heute bricht nie (der Tag läuft noch).
   * lerntage: Map tag → {geschafft}. Ergebnis: { serie, laengste, pausen: Set der überbrückten Tage }
   */
  function serienInfo(lerntage, heute) {
    const tage = [...lerntage.entries()].filter(([, v]) => v && v.geschafft).map(([t]) => t).sort();
    const pausen = new Set();
    if (tage.length === 0) return { serie: 0, laengste: 0, pausen };
    let akt = 0, best = 0;
    let genutzt = new Set();       // Wochen, deren Pause-Tag in der laufenden Serie verbraucht ist
    let kandidaten = [];           // überbrückte Tage der laufenden Serie
    for (let tag = tage[0]; tag <= heute; tag = plusTage(tag, 1)) {
      if (lerntage.get(tag)?.geschafft) {
        akt++;
      } else if (tag === heute) {
        // läuft noch
      } else if (akt > 0 && !genutzt.has(wochenStart(tag))) {
        genutzt.add(wochenStart(tag));
        kandidaten.push(tag);
      } else {
        akt = 0;
        genutzt = new Set();
        kandidaten = [];
        continue;
      }
      best = Math.max(best, akt);
    }
    // Pause-Tage am Ende (gestern verpasst) zählen nur, wenn die Serie danach weiterlaufen kann
    kandidaten.forEach((t) => pausen.add(t));
    return { serie: akt, laengste: best, pausen };
  }

  function serie(lerntage, heute) {
    return serienInfo(lerntage, heute).serie;
  }

  function laengsteSerie(lerntage, heute) {
    const letzter = [...lerntage.keys()].sort().pop();
    return serienInfo(lerntage, heute || letzter || datum(new Date())).laengste;
  }

  // ==========================================
  // STATISTIK
  // ==========================================

  /** Ab diesem Fach (8 Tage Abstand) gilt eine Karte als „sicher“. */
  const SICHER_AB = 3;

  function istSicher(f) {
    return Boolean(f && f.faellig && f.fach >= SICHER_AB);
  }

  /** Schwierig: schon falsch beantwortet und noch in einem niedrigen Fach oder mit hoher Fehlerquote. */
  function istSchwierig(f) {
    if (!f || !f.faellig) return false;
    const falsch = f.falsch || 0;
    const gesamt = falsch + (f.richtig || 0);
    if (falsch === 0 || gesamt === 0) return false;
    return f.fach <= 1 || falsch / gesamt >= 0.34;
  }

  /** Anteil sicherer Karten in Prozent (gerundet). */
  function sicherProzent(karten, fortschritt) {
    if (!karten.length) return 0;
    const n = karten.filter((k) => istSicher(fortschritt.get(k.id))).length;
    return Math.round((n / karten.length) * 100);
  }

  /**
   * Schwächste Stapel nach Trefferquote (alle bisherigen Antworten).
   * Nur Stapel mit mindestens „mindestens“ Antworten und Quote unter 80 %. Ergebnis: [{stapel_id, quote, antworten}]
   */
  function schwaechen(karten, fortschritt, anzahl, mindestens) {
    const proStapel = new Map();
    for (const k of karten) {
      const f = fortschritt.get(k.id);
      if (!f) continue;
      const s = proStapel.get(k.stapel_id) || { r: 0, f: 0 };
      s.r += f.richtig || 0;
      s.f += f.falsch || 0;
      proStapel.set(k.stapel_id, s);
    }
    return [...proStapel.entries()]
      .map(([stapel_id, s]) => ({ stapel_id, antworten: s.r + s.f, quote: s.r + s.f ? s.r / (s.r + s.f) : 1 }))
      .filter((x) => x.antworten >= (mindestens || 6) && x.quote < 0.8)
      .sort((a, b) => a.quote - b.quote || b.antworten - a.antworten)
      .slice(0, anzahl || 3);
  }

  /** Summe der letzten 7 Tage (inkl. heute): { karten, sekunden, tage } */
  function woche(lerntage, heute) {
    let karten = 0, sekunden = 0, tage = 0;
    for (let i = 0; i < 7; i++) {
      const e = lerntage.get(plusTage(heute, -i));
      if (!e) continue;
      karten += e.gelernt || 0;
      sekunden += e.sekunden || 0;
      if (e.gelernt) tage++;
    }
    return { karten, sekunden, tage };
  }

  /** Lernzeit einer Karte: höchstens 2 Minuten (sonst zählt Weglegen des Handys mit). */
  function kartenSekunden(ms) {
    return Math.max(0, Math.min(120, Math.round(ms / 1000)));
  }

  /** Ergebnis des Klausur-Modus in Prozent: gewusst = 1, unsicher = ½. */
  function pruefungsProzent(gewusst, unsicher, fragen) {
    return fragen ? Math.round(((gewusst + unsicher / 2) / fragen) * 100) : 0;
  }

  // ==========================================
  // MARKDOWN (klein: fett, kursiv, Code, Codeblöcke, Listen, Wikilinks – Formeln bleiben für KaTeX)
  // ==========================================

  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function inline(text) {
    const teile = text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|`[^`]+`)/g);
    return teile.map((t, i) => {
      if (i % 2 === 1) {
        if (t.startsWith("`")) return `<code>${esc(t.slice(1, -1))}</code>`;
        return esc(t);                                           // Formel
      }
      return esc(t)
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/==([^=]+)==/g, "<mark>$1</mark>");
    }).join("");
  }

  function markdown(text) {
    // Zeilenumbrüche in Display-Formeln würden sie zerreißen
    const quelle = String(text || "").replace(/\r\n/g, "\n").replace(/\$\$[\s\S]+?\$\$/g, (m) => m.replace(/\n/g, " "));
    const html = [];
    let liste = null;
    let code = null;
    const listeZu = () => {
      if (liste) html.push(`<${liste.typ}>${liste.punkte.map((p) => `<li>${p}</li>`).join("")}</${liste.typ}>`);
      liste = null;
    };
    for (const zeile of quelle.split("\n")) {
      if (code) {
        if (/^\s*```/.test(zeile)) {
          html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
          code = null;
        } else {
          code.push(zeile);
        }
        continue;
      }
      if (/^\s*```/.test(zeile)) {
        listeZu();
        code = [];
        continue;
      }
      const ul = zeile.match(/^\s*[-*+] (.*)$/);
      const ol = zeile.match(/^\s*\d+[.)] (.*)$/);
      if (ul || ol) {
        const typ = ul ? "ul" : "ol";
        if (!liste || liste.typ !== typ) {
          listeZu();
          liste = { typ, punkte: [] };
        }
        liste.punkte.push(inline((ul || ol)[1]));
        continue;
      }
      listeZu();
      if (zeile.trim()) html.push(`<p>${inline(zeile)}</p>`);
    }
    if (code) html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    listeZu();
    return html.join("");
  }

  const Logik = {
    normalisiere, levenshtein, pruefeAntwort, datum, plusTage, tageBis, wochenStart,
    naechsterStand, wirdGetippt, heutigeKarten, nachKlausurSortieren, KLAUSUR_VORLAUF,
    serie, laengsteSerie, serienInfo, tagGeschafft, STANDARD_TAGESZIEL, STANDARD_ABSTAENDE, RUECKFALL,
    istPool, POOL_PRAEFIX, UNSICHER,
    istSicher, istSchwierig, sicherProzent, schwaechen, woche, kartenSekunden, pruefungsProzent, SICHER_AB,
    markdown, esc,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Logik;
  else global.Logik = Logik;
})(typeof window !== "undefined" ? window : globalThis);
