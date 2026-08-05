# Codex-Verbrauchsanzeige

`cuw` zeigt neben den Claude-Konten auch die Limits des aktuell angemeldeten
Codex-Kontos an.

## Voraussetzungen

Die Codex CLI muss installiert und angemeldet sein:

```sh
codex login
```

Es muss keine Codex-Unterhaltung, kein Desktop-Fenster und keine laufende
Codex-Session geöffnet sein. Die Anzeige bezieht sich auf das aktive Konto der
lokalen Codex-Anmeldung.

## Verwendung

```sh
cuw                 # Tabelle für Claude und Codex
cuw status --json   # maschinenlesbare Ausgabe
```

Die Textausgabe stellt die Codex-Daten unterhalb der Claude-Tabelle dar:

```text
CODEX  active  PLAN plus
LIMIT  WINDOW         USED             RESETS
──────────────────────────────────────────────
codex  primary 7d      73%  ▓▓▓▓▓▓▓░░      4d
```

Ein Konto kann mehrere Limit-Buckets liefern. Jeder Bucket wird mit seiner
Rolle (`primary` oder `secondary`), seinem Zeitfenster, dem verbrauchten
Prozentsatz und dem Reset-Zeitpunkt angezeigt.

## JSON-Schnittstelle

Die JSON-Ausgabe enthält Claude und Codex gemeinsam:

```json
{
  "claude": [],
  "codex": {
    "planType": "plus",
    "limits": [
      {
        "id": "codex",
        "primary": {
          "usedPercent": 73,
          "windowDurationMins": 10080,
          "resetsAt": "2026-08-08T07:45:45.000Z"
        }
      }
    ],
    "error": null
  }
}
```

`limits` und `error` sind immer vorhanden. Bei einem Lesefehler bleibt die
Claude-Ausgabe verfügbar; `codex.error` enthält dann eine kurze, sichere
Fehlermeldung. Ein Codex-Fehler ändert den Exit-Code nicht. Nur ein Fehler, der
ein Claude-Konto betrifft, kann weiterhin Exit-Code `2` auslösen.

## Technischer Ablauf

Für die Abfrage startet `cuw` kurzzeitig `codex app-server` als lokalen
Unterprozess. Es führt den öffentlichen JSONL-Handshake aus und ruft
`account/rateLimits/read` auf. Die Antwort wird normalisiert und der Prozess
danach beendet. Claude- und Codex-Abfrage laufen parallel.

`cuw` liest dabei keine Codex-Token, E-Mail-Adressen, Session-Dateien,
Unterhaltungen oder privaten HTTP-Endpunkte. Die Authentifizierung und eine
eventuelle Token-Erneuerung bleiben vollständig bei der Codex CLI.

## Fehlersuche

- `codex` nicht gefunden: Codex CLI installieren und sicherstellen, dass sie im
  `PATH` liegt.
- Nicht angemeldet: `codex login` ausführen und `cuw status` erneut starten.
- Timeout oder nicht erreichbarer App-Server: `cuw doctor` für die Claude-Seite
  verwenden und die Codex CLI separat testen (`codex --version`).

Ein fehlender oder fehlerhafter Codex-Wert blendet die Claude-Tabelle nicht aus.
