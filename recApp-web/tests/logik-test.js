// Logik-Tests für recApp – ausführen mit:  node tests/logik-test.js
const assert = require("node:assert/strict");
const L = require("../logik.js");
let n = 0;
const test = (name, f) => { f(); n++; console.log("ok  " + name); };
const tage = (obj) => new Map(Object.entries(obj).map(([t, v]) => [t, { tag: t, ...v }]));

test("Antwortprüfung: Schlüsselwörter, Umlaute, Tippfehler", () => {
  const g = [["Kostenführerschaft", "Kostenführer"], ["niedrig"]];
  assert.equal(L.pruefeAntwort("kostenfuehrerschaft durch niedrige Preise", g).richtig, true);
  assert.equal(L.pruefeAntwort("Kostenfürerschaft, niedrig", g).richtig, true);
  assert.equal(L.pruefeAntwort("Differenzierung", g).richtig, false);
  assert.equal(L.pruefeAntwort("irgendwas", []).richtig, false);
});

test("Karteikasten: richtig ein Fach hoch, falsch zwei zurück", () => {
  const h = "2026-11-27";
  assert.deepEqual(L.naechsterStand(null, true, h), { fach: 1, faellig: "2026-11-29", richtig: 1, falsch: 0 });
  assert.equal(L.naechsterStand({ fach: 5, richtig: 5, falsch: 0 }, false, h).fach, 3);
  assert.equal(L.naechsterStand({ fach: 5, richtig: 5, falsch: 0 }, false, h).faellig, "2026-12-05");
  assert.equal(L.naechsterStand({ fach: 1 }, false, h).fach, 0);
  assert.equal(L.naechsterStand(null, false, h).fach, 0);
  assert.equal(L.naechsterStand({ fach: 5 }, true, h).fach, 5);
  const u = L.naechsterStand({ fach: 3, richtig: 2, falsch: 1 }, L.UNSICHER, h);
  assert.deepEqual(u, { fach: 3, faellig: "2026-11-28", richtig: 2, falsch: 1 });
});

test("Heute: fällige (älteste zuerst), überfällige, neue im Limit, Pool ohne Limit", () => {
  const karten = [
    { id: "a", stapel_id: "M/VL01" }, { id: "b", stapel_id: "M/VL01" }, { id: "c", stapel_id: "M/VL02" },
    { id: "d", stapel_id: "M/VL02" }, { id: "p", stapel_id: "Klausur-Pool/x" },
  ];
  const f = new Map([["a", { faellig: "2026-11-27" }], ["b", { faellig: "2026-11-20" }], ["c", { faellig: "2026-12-01" }]]);
  const h = L.heutigeKarten(karten, f, "2026-11-27", 5, new Map());
  assert.deepEqual(h.faellig.map((k) => k.id), ["b", "a"]);
  assert.equal(h.ueberfaellig, 1);
  assert.deepEqual(h.neu.map((k) => k.id), ["d"]);
  assert.deepEqual(h.poolNeu.map((k) => k.id), ["p"]);
  assert.equal(L.heutigeKarten(karten, f, "2026-11-27", 0, new Map()).neu.length, 0);
});

test("Klausur zuerst: nur Module mit Klausur in 0–21 Tagen, Reihenfolge sonst stabil", () => {
  const ks = [{ id: 1, m: "A" }, { id: 2, m: "B" }, { id: 3, m: "A" }, { id: 4, m: "C" }, { id: 5, m: "D" }];
  const termin = { B: "2026-12-18", C: "2026-12-01", D: "2027-01-28" };
  const r = L.nachKlausurSortieren(ks, (k) => termin[k.m], "2026-11-27").map((k) => k.id);
  assert.deepEqual(r, [4, 2, 1, 3, 5]);
});

test("Tagesziel: 20 Karten oder nichts mehr offen", () => {
  assert.equal(L.tagGeschafft({ gelernt: 19 }, 5, 20), false);
  assert.equal(L.tagGeschafft({ gelernt: 20 }, 5, 20), true);
  assert.equal(L.tagGeschafft({ gelernt: 3 }, 0, 20), true);
  assert.equal(L.tagGeschafft({ gelernt: 0, geschafft: true }, 9, 20), true);
  assert.equal(L.tagGeschafft(undefined, 4, 20), false);
});

test("Serie: läuft bis gestern weiter, heute bricht nicht", () => {
  const lt = tage({ "2026-11-24": { geschafft: true }, "2026-11-25": { geschafft: true }, "2026-11-26": { geschafft: true } });
  assert.equal(L.serie(lt, "2026-11-27"), 3);
  lt.set("2026-11-27", { geschafft: true });
  assert.equal(L.serie(lt, "2026-11-27"), 4);
  assert.equal(L.serie(new Map(), "2026-11-27"), 0);
});

test("Serie: ein Pause-Tag pro Woche überbrückt, zwei in derselben Woche brechen", () => {
  // Mi 25.11. verpasst (Woche 23.–29.11.)
  const lt = tage({ "2026-11-23": { geschafft: true }, "2026-11-24": { geschafft: true }, "2026-11-26": { geschafft: true } });
  const i = L.serienInfo(lt, "2026-11-27");
  assert.equal(i.serie, 3);
  assert.deepEqual([...i.pausen], ["2026-11-25"]);
  // zusätzlich Fr 27. verpasst, heute Sa 28. → zweiter Ausfall in derselben Woche → Serie weg
  assert.equal(L.serie(lt, "2026-11-28"), 0);
  // Ausfälle in verschiedenen Wochen: So 22.11. und Mi 25.11.
  const lt2 = tage({ "2026-11-20": { geschafft: true }, "2026-11-21": { geschafft: true }, "2026-11-23": { geschafft: true },
    "2026-11-24": { geschafft: true }, "2026-11-26": { geschafft: true } });
  assert.equal(L.serie(lt2, "2026-11-27"), 5);
  // zwei Tage am Stück in einer Woche → gebrochen, neue Serie danach
  const lt3 = tage({ "2026-11-23": { geschafft: true }, "2026-11-26": { geschafft: true } });
  assert.equal(L.serie(lt3, "2026-11-27"), 1);
});

test("Längste Serie mit Pause-Tagen", () => {
  const lt = tage({ "2026-11-02": { geschafft: true }, "2026-11-03": { geschafft: true }, "2026-11-05": { geschafft: true },
    "2026-11-20": { geschafft: true } });
  assert.equal(L.laengsteSerie(lt, "2026-11-27"), 3);
});

test("Wochenstart (Montag)", () => {
  assert.equal(L.wochenStart("2026-11-27"), "2026-11-23");
  assert.equal(L.wochenStart("2026-11-29"), "2026-11-23");
  assert.equal(L.wochenStart("2026-11-30"), "2026-11-30");
  assert.equal(L.tageBis("2026-11-27", "2026-12-18"), 21);
  assert.equal(L.tageBis("2026-11-27", "2026-11-20"), -7);
});

test("Sicher, schwierig, Prozent", () => {
  assert.equal(L.istSicher({ fach: 3, faellig: "x" }), true);
  assert.equal(L.istSicher({ fach: 2, faellig: "x" }), false);
  assert.equal(L.istSicher(undefined), false);
  assert.equal(L.istSchwierig({ fach: 0, faellig: "x", falsch: 1, richtig: 0 }), true);
  assert.equal(L.istSchwierig({ fach: 4, faellig: "x", falsch: 1, richtig: 5 }), false);
  assert.equal(L.istSchwierig({ fach: 3, faellig: "x", falsch: 2, richtig: 2 }), true);
  assert.equal(L.istSchwierig({ fach: 0, faellig: null, falsch: 0, richtig: 0 }), false);
  const ks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.equal(L.sicherProzent(ks, new Map([["a", { fach: 3, faellig: "x" }]])), 25);
  assert.equal(L.sicherProzent([], new Map()), 0);
});

test("Schwächen: schlechteste Stapel mit genug Antworten", () => {
  const ks = [{ id: 1, stapel_id: "A" }, { id: 2, stapel_id: "A" }, { id: 3, stapel_id: "B" }, { id: 4, stapel_id: "C" }];
  const f = new Map([[1, { richtig: 2, falsch: 3 }], [2, { richtig: 1, falsch: 0 }], [3, { richtig: 9, falsch: 1 }], [4, { richtig: 0, falsch: 2 }]]);
  const s = L.schwaechen(ks, f, 3, 6);
  assert.deepEqual(s.map((x) => x.stapel_id), ["A"]);
  assert.equal(Math.round(s[0].quote * 100), 50);
});

test("Woche, Lernzeit, Prüfungsprozent", () => {
  const lt = tage({ "2026-11-27": { gelernt: 20, sekunden: 600 }, "2026-11-21": { gelernt: 5, sekunden: 60 }, "2026-11-20": { gelernt: 99 } });
  assert.deepEqual(L.woche(lt, "2026-11-27"), { karten: 25, sekunden: 660, tage: 2 });
  assert.equal(L.kartenSekunden(5400), 5);
  assert.equal(L.kartenSekunden(10 * 60 * 1000), 120);
  assert.equal(L.pruefungsProzent(14, 2, 20), 75);
});

test("Markdown: Listen, Codeblöcke, Inline-Code, Formeln, kein HTML", () => {
  const h = L.markdown("Vorteile:\n- **schnell**\n- `int x = 1;`\n\n1. erst\n2. dann");
  assert.equal(h, "<p>Vorteile:</p><ul><li><strong>schnell</strong></li><li><code>int x = 1;</code></li></ul><ol><li>erst</li><li>dann</li></ol>");
  assert.equal(L.markdown("```java\nif (a < b) {\n  x++;\n}\n```"), "<pre><code>if (a &lt; b) {\n  x++;\n}</code></pre>");
  assert.equal(L.markdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(L.markdown("$$a\n+b$$"), "<p>$$a +b$$</p>");
  assert.equal(L.markdown("Formel $x*y*z$ und *kursiv*"), "<p>Formel $x*y*z$ und <em>kursiv</em></p>");
  assert.equal(L.markdown("[[Notiz|Text]] und [[Begriff]]"), "<p>Text und Begriff</p>");
});

console.log(`\n${n} Tests bestanden.`);
