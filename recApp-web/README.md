# recApp – Web-App

Lernkarten aus dem Obsidian-Vault auf dem iPhone lernen: Antwort tippen, Schlüsselwort-Prüfung, Karteikasten, Serie.
Die Karten kommen über **recApp Sync** (Java-Projekt `recApp`) nach Supabase.

## Dateien
| Datei | Inhalt |
|---|---|
| `index.html` | Ansichten: Anmelden, Start, Lernen, Geschafft, Klausur-Ergebnis, Vortragen (Themen, Vortrag, Skript), Maskottchen Lauscher (SVG-Vorlage) |
| `style.css` | Dark Swiss · Editorial Minimalism (wie das Vault-Design seit 20.11.2026) |
| `logik.js` | Antwortprüfung, Karteikasten, fällige/neue Karten, Tagesziel, Serie, Statistik, Markdown – ohne Oberfläche, testbar |
| `app.js` | Oberfläche, Datenzugriff (supabase-js) und Offline-Betrieb (Warteschlange, gespeicherter Stand) |
| `sw.js` | Service Worker: App offline verfügbar (App-Dateien zuerst aus dem Netz, Bibliotheken aus dem Cache) |
| `tests/logik-test.js` | Logik-Tests: `node tests/logik-test.js` |
| `config.js` | Supabase-URL und **öffentlicher** Schlüssel |
| `manifest.webmanifest`, `icons/` | Homescreen-App; `icons/icon.svg` ist die Vorlage des Icons |

## Einrichten
1. In `config.js` Projekt-URL und öffentlichen Schlüssel (`sb_publishable_…`) eintragen – zu finden in Supabase unter *Project Settings → API Keys* bzw. *Data API*. **Nie** den geheimen Schlüssel eintragen.
2. Neues Repository auf github.com (z. B. `recapp`), alle Dateien hochladen (*Add file → Upload files*, Ordner `icons` per Drag & Drop mit).
3. *Settings → Pages → Deploy from a branch → `main` / `(root)`*.
4. Auf dem iPhone die Pages-Adresse in Safari öffnen → Teilen → *Zum Home-Bildschirm*.

Die Daten schützt der Login (Registrierung in Supabase aus) plus Row Level Security; der Code selbst darf öffentlich sein.

## Regeln
- **Runde:** höchstens 20 Karten – erst fällige (überfällige zuerst), dann neue. Module mit Klausur in den nächsten 21 Tagen kommen zuerst dran (Termin aus dem Feld `klausur` der Modulübersicht, über recApp Sync). Danach „Nächste Runde“, solange etwas offen ist.
- **Tagesziel und Serie:** Ein Tag ist geschafft, wenn 20 Karten gelernt sind (Einstellung `tagesziel`, auch Übungskarten zählen) oder nichts mehr offen ist. **Pause-Tag:** Pro Woche (Mo–So) darf ein verpasster Tag die Serie überbrücken – er zählt nicht mit, bricht sie aber nicht.
- **Tippen:** richtig, wenn alle Pflicht-Schlüsselwörter vorkommen (Groß-/Kleinschreibung egal, ä = ae, 1–2 Tippfehler erlaubt, Teil eines Worts reicht). „Doch richtig“ zählt die Karte und speichert die Antwort für Claude.
- **Selbst bewerten:** Formelkarten, Klausur-Pool und Karten ohne Schlüsselwörter.
- **Karteikasten:** richtig → ein Fach höher (1, 2, 4, 8, 16, 32 Tage), falsch → **2 Fächer zurück** (mind. Fach 0) und am Ende der Runde noch einmal.
- **Neue Karten:** höchstens 20 pro Tag (Tabelle `einstellungen`, `neue_pro_tag`).
- **Klausur-Pool:** Stapel mit ID `Klausur-Pool/…` (aus den Lernmodus-Blöcken im Vault). Selbstbewertung in drei Stufen: *nicht gewusst*, *unsicher* (Fach bleibt, morgen wieder), *gewusst*. Neue Pool-Karten ohne Tageslimit. **Klausur simulieren:** 20 zufällige Pool-Fragen, Ergebnis in % am Ende (unsicher zählt halb), Verlauf in Tabelle `pruefungen`.
- **Schwierige Karten:** schon falsch beantwortet und noch in Fach 0–1 oder mit Fehlerquote ab 34 %. **Schwächen:** die 3 Stapel mit der schlechtesten Trefferquote (ab 6 Antworten, unter 80 %). **Sicher:** Karte ab Fach 3.
- **Melden:** Knopf an der Musterantwort → Tabelle `meldungen`; recApp Sync schreibt Meldungen und „Doch richtig“ beim Hochladen in die Vault-Notiz *Rückmeldungen recApp*.
- **Vortragen (nur iPhone, Reiter unten):** Thema wählen und es dem Maskottchen **Lauscher** erklären. Lauscher hört nicht wirklich zu (kein Mikrofon): Er reagiert alle 3–7,5 s zufällig (nicken, Ohren spitzen, Kopf schief, nachdenken, staunen, lachen – nie zweimal dasselbe, gut die Hälfte mit kurzem Satz). Antippen = er erschrickt. Uhr läuft, Bildschirm bleibt an (Wake Lock). Wann welches Thema vorgetragen wurde, merkt sich nur das Gerät (localStorage `recapp-vortraege`). Reaktionen: `REAKTIONEN` in `logik.js`, Aussehen: Klassen `r-…` in `style.css`.
- **Skript:** Im Vortrag über „Skript“ – der Text der Vorlesungs-/Themennotiz (Tabelle `skripte`, kommt über recApp Sync; ohne Bilder, Lernkarten und Abfragen). Fehlt die Tabelle oder das Skript, zeigt die App die Lernkarten des Themas. Offline aus dem Speicher (`recapp-skripte`).
- **Offline:** Die App merkt sich den zuletzt geladenen Stand und alle Antworten in einer Warteschlange (localStorage); wieder online wird sie automatisch übertragen. Nicht abmelden, solange etwas wartet.
- **Datenbank:** `supabase/ergaenzung-2-tagesziel-klausur.sql` und `ergaenzung-3-skripte.sql` (im Java-Projekt) ausführen. Ohne Ergänzung 2 fehlen Klausurtermine, Klausur-Ergebnisse und Meldungen, ohne Ergänzung 3 die Skripte.
