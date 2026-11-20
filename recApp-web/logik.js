/* recApp – Lernlogik ohne Oberfläche: Antwortprüfung, Karteikasten, Streak.
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

  // ==========================================
  // KARTEIKASTEN
  // ==========================================

  const STANDARD_ABSTAENDE = [1, 2, 4, 8, 16, 32];

  /** Bewertung „unsicher“ (nur Selbstbewertung im Klausur-Pool) */
  const UNSICHER = "unsicher";

  /**
   * Neuer Lernstand nach einer Antwort. fach 0–5.
   * richtig (true) → ein Fach höher · falsch (false) → Fach 0 · "unsicher" → Fach bleibt, morgen wieder dran.
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
    const fach = richtig ? Math.min(altFach + 1, 5) : 0;
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
   * Ergebnis: { faellig, neu, poolNeu } – faellig = früher gelernt und heute dran (auch Pool),
   * neu = neue Karten im Tageslimit, poolNeu = alle noch nie gelernten Pool-Karten (ohne Limit,
   * zählen nicht für die Serie)
   */
  function heutigeKarten(karten, fortschritt, heute, neueFrei, stapelReihenfolge) {
    const faellig = [];
    const neu = [];
    const poolNeu = [];
    for (const k of karten) {
      const f = fortschritt.get(k.id);
      if (f && f.faellig) {
        if (f.faellig <= heute) faellig.push(k);
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
    return { faellig, neu: neu.slice(0, Math.max(0, neueFrei)), poolNeu };
  }

  // ==========================================
  // STREAK
  // ==========================================

  /**
   * lerntage: Map tag → {geschafft}. Ein Tag zählt, wenn er geschafft ist.
   * Ist heute noch nicht geschafft, läuft die Serie trotzdem bis gestern weiter.
   */
  function serie(lerntage, heute) {
    let tag = lerntage.get(heute)?.geschafft ? heute : plusTage(heute, -1);
    let n = 0;
    while (lerntage.get(tag)?.geschafft) {
      n++;
      tag = plusTage(tag, -1);
    }
    return n;
  }

  function laengsteSerie(lerntage) {
    const tage = [...lerntage.entries()].filter(([, v]) => v.geschafft).map(([t]) => t).sort();
    let best = 0, akt = 0, vorher = null;
    for (const t of tage) {
      akt = vorher && plusTage(vorher, 1) === t ? akt + 1 : 1;
      best = Math.max(best, akt);
      vorher = t;
    }
    return best;
  }

  const Logik = {
    normalisiere, levenshtein, pruefeAntwort, datum, plusTage,
    naechsterStand, wirdGetippt, heutigeKarten, serie, laengsteSerie, STANDARD_ABSTAENDE,
    istPool, POOL_PRAEFIX, UNSICHER,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Logik;
  else global.Logik = Logik;
})(typeof window !== "undefined" ? window : globalThis);
