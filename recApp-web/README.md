# recApp – Web-App

Lernkarten aus dem Obsidian-Vault auf dem iPhone lernen: Antwort tippen, Schlüsselwort-Prüfung, Karteikasten, Serie.
Die Karten kommen über **recApp Sync** (Java-Projekt `recApp`) nach Supabase.

## Dateien
| Datei | Inhalt |
|---|---|
| `index.html` | Ansichten: Anmelden, Start, Lernen, Geschafft |
| `style.css` | Dark Swiss · Editorial Minimalism (wie das Vault-Design seit 20.11.2026) |
| `logik.js` | Antwortprüfung, Karteikasten, fällige/neue Karten, Serie – ohne Oberfläche, testbar |
| `app.js` | Oberfläche und Datenzugriff (supabase-js) |
| `config.js` | Supabase-URL und **öffentlicher** Schlüssel |
| `manifest.webmanifest`, `icons/` | Homescreen-App; `icons/icon.svg` ist die Vorlage des Icons |

## Einrichten
1. In `config.js` Projekt-URL und öffentlichen Schlüssel (`sb_publishable_…`) eintragen – zu finden in Supabase unter *Project Settings → API Keys* bzw. *Data API*. **Nie** den geheimen Schlüssel eintragen.
2. Neues Repository auf github.com (z. B. `recapp`), alle Dateien hochladen (*Add file → Upload files*, Ordner `icons` per Drag & Drop mit).
3. *Settings → Pages → Deploy from a branch → `main` / `(root)`*.
4. Auf dem iPhone die Pages-Adresse in Safari öffnen → Teilen → *Zum Home-Bildschirm*.

Die Daten schützt der Login (Registrierung in Supabase aus) plus Row Level Security; der Code selbst darf öffentlich sein.

## Regeln
- **Tippen:** richtig, wenn alle Pflicht-Schlüsselwörter vorkommen (Groß-/Kleinschreibung egal, ä = ae, 1–2 Tippfehler erlaubt, Teil eines Worts reicht). „Doch richtig“ zählt die Karte und speichert die Antwort für Claude.
- **Selbst bewerten:** Formelkarten und Karten ohne Schlüsselwörter.
- **Karteikasten:** richtig → ein Fach höher (1, 2, 4, 8, 16, 32 Tage), falsch → Fach 0 und am Ende der Sitzung noch einmal.
- **Neue Karten:** höchstens 20 pro Tag (Tabelle `einstellungen`, `neue_pro_tag`).
- **Klausur-Pool:** Stapel mit ID `Klausur-Pool/…` (aus den Lernmodus-Blöcken im Vault). Selbstbewertung in drei Stufen: *nicht gewusst* (Fach 0, in der Sitzung noch einmal), *unsicher* (Fach bleibt, morgen wieder), *gewusst* (ein Fach höher). Neue Pool-Karten ohne Tageslimit; sie zählen erst für die Serie, wenn sie einmal gelernt und wieder fällig sind. „Alles lernen“ nimmt keine neuen Pool-Karten mit – dafür das Pool-Modul öffnen („Alle … zusammen“).
- **Serie:** Ein Tag zählt, wenn am Ende keine fälligen Karten mehr offen sind. Öffnest du die App an einem Tag ohne fällige Karten, zählt er ebenfalls.
