# CitizenHQ Desktop-Client — Auftrag und Rahmen

Dieses Dokument ist die Übergabe. Es beschreibt, **was gebaut wird, warum so, und was
schon fertig ist** — damit niemand die Vorarbeit erneut recherchieren muss.

Der Client gehört zu **CitizenHQ** (citizenhq.space, Repo `miwidot/scverse`), einer
deutschsprachigen Star-Citizen-Plattform: Handelsdaten, Schiffs- und Missionsdatenbank,
Orga-Verwaltung mit Lager, Mining, Twitch- und Discord-Bots.

---

## 1. Was der Client tun soll

Ein **Windows/Linux-Programm** (Mac gern mit, kostet nichts), das

1. **die `Game.log` beobachtet** und daraus Käufe und Verkäufe erkennt,
2. **Hangar, Lager und Blaupausen** des Nutzers auf citizenhq.space pflegt,
3. **im Hintergrund läuft** (Tray, Autostart) und nicht stört.

Die Seite kann all das bereits im Browser — der Client nimmt dem Spieler das Abtippen ab.

## 2. Technik: Tauri

Entscheidung des Owners. UI in Web-Technik (React + TypeScript), Systemteile in Rust.

```
citizenhq-client/
├─ src/                    UI (React/TS)
├─ src-tauri/              Rust: Dateizugriff, Tray, Autostart, sichere Ablage
│  └─ tauri.conf.json
└─ .github/workflows/build.yml   Windows + Linux + macOS über GitHub Actions
```

Windows-Pakete werden **nicht auf dem Mac** gebaut, sondern in GitHub Actions auf einem
Windows-Runner. Lokal entwickelt man auf dem Mac, veröffentlicht über CI.

## 3. Anmeldung — FERTIG und geprüft, bitte nicht neu erfinden

Der Server kann bereits alles. Es ist der **OAuth Device Authorization Flow**
(better-auth), gegen `https://citizenhq.space` bzw. `https://dev.citizenhq.space`.

**Schritt 1 — Code anfordern**

```http
POST /api/auth/device/code
Content-Type: application/json     ← NICHT form-urlencoded, das lehnt der Server ab

{"client_id":"citizenhq-desktop","scope":"hangar"}
```

Antwort (echt gemessen am 18.08.2026):

```json
{
  "device_code": "XnmUi1xjkQArNPptIondVlSMWxlLc2jkejLGGIdg",
  "user_code": "BUDQUZLL",
  "verification_uri": "https://dev.citizenhq.space/geraet",
  "verification_uri_complete": "https://dev.citizenhq.space/geraet?user_code=BUDQUZLL",
  "expires_in": 600,
  "interval": 5
}
```

**Schritt 2 — dem Menschen den Code zeigen.** `verification_uri_complete` im
Standardbrowser öffnen (Tauri: `shell.open`), zusätzlich `user_code` groß anzeigen, falls
er auf einem anderen Gerät bestätigt. **Keinen eingebetteten Browser benutzen** — der
Nutzer muss die Adresszeile sehen können, das ist der ganze Sinn des Verfahrens.

**Schritt 3 — Token abholen**, alle `interval` Sekunden:

```http
POST /api/auth/device/token
Content-Type: application/json

{"grant_type":"urn:ietf:params:oauth:grant-type:device_code",
 "device_code":"…","client_id":"citizenhq-desktop"}
```

Antworten, die kommen können (alle mit HTTP 400, geprüft):

| `error` | Bedeutung | Was der Client tun muss |
|---|---|---|
| `authorization_pending` | noch nicht bestätigt | weiter warten |
| `slow_down` | zu schnell gefragt | Abstand **erhöhen**, dann weiter |
| `invalid_grant` | Code falsch/abgelaufen/verbraucht | abbrechen, neuen Code holen |
| `access_denied` | abgelehnt | abbrechen, nicht erneut fragen |

Bei Erfolg kommt ein Session-Token. Danach jede Anfrage mit
`Authorization: Bearer <token>`.

**Ablage des Tokens:** in den Schlüsselbund des Betriebssystems (Windows Credential
Manager, Linux Secret Service, macOS Keychain) — nicht in eine Datei neben dem Programm.
Für Tauri gibt es dafür fertige Plugins.

## 4. Sicherheitsregeln, die nicht verhandelbar sind

- **Der Client hat kein Geheimnis.** Ein Programm auf fremden Rechnern kann keins hüten.
  Es gibt deshalb kein Client-Secret, keine Signatur, keine Prüfsumme, die „nur unseren
  Client durchlässt". Der Server behandelt jeden Aufrufer als potenziell nachgebaut —
  geschützt wird über das **Nutzer-Token**, nicht über die Programm-Identität.
- **Rechte hängen am Menschen, nicht am Token.** Was in einer Orga erlaubt ist,
  entscheidet die dortige Rolle im Moment der Anfrage. Verliert jemand seine Rolle, wirkt
  das sofort. Der Client darf Rechte weder zwischenspeichern noch daraus Schlüsse ziehen —
  er fragt, der Server entscheidet.
- **Nie Zugangsdaten abfragen.** Kein Passwortfeld, kein Discord-Login im Programm.
- **Jedes Gerät ist einzeln abmeldbar** (Profil → Einstellungen → Verbundene Geräte).
  Nach einer Abmeldung antwortet der Server mit 401 — dann Token verwerfen und den
  Anmeldeweg neu anbieten, nicht stumm weiterversuchen.

## 5. Game.log auswerten

Die Logdatei liegt im Spielverzeichnis (`.../StarCitizen/LIVE/Game.log`) und wächst
laufend. Der Client liest sie fortlaufend (Position merken, nur Neues verarbeiten).

**Handel erkennen** — zwei Zeilenarten, mit unterschiedlichen Feldnamen:

```
<CEntityComponentCommodityUIProvider::SendCommodityBuyRequest>  … price[…]  resourceGUID[…] quantity[… cSCU]
<CEntityComponentCommodityUIProvider::SendCommoditySellRequest> … amount[…] resourceGUID[…] quantity[…]
```

Zwei Fallen, die Geld kosten:
- Kauf nennt den Betrag `price`, Verkauf `amount`.
- Kauf-Menge steht in **cSCU** (Hundertstel-SCU), Verkauf-Menge ohne Einheit. Wer das
  übersieht, rechnet um Faktor 100 daneben.

**Das ungelöste Problem: die GUID.** Das Log nennt nur eine `resourceGUID`, keinen
Warennamen. Diese GUIDs stammen aus einem **anderen UUID-Raum** als die Daten von CitizenHQ
— das wurde geprüft: keine der bekannten Log-GUIDs findet sich in den 21.490 Spiel-
Entitäten der Plattform, und „Quantum Fuel" existiert dort dreifach mit ganz anderen IDs.

Es gibt also **keine fertige Zuordnung**. Realistischer Weg: unbekannte GUIDs sammeln,
einmalig zuordnen (der Nutzer weiß ja, was er gerade gekauft hat), Zuordnung teilen.
Das ist ein eigener Arbeitsschritt und sollte **nicht** unterschätzt werden.

Weitere Ereignisse in der Logdatei (Missionen, Schiffe, Tod, Kontostand) sind
erschließbar, aber noch nicht untersucht.

## 6. Was auf der Serverseite NOCH FEHLT

Die Anmeldung steht. **Endpunkte für Hangar, Lager und Blaupausen gibt es noch nicht** —
sie werden im Hauptrepo unter Ticket #325 („Stufe 2") gebaut. Bis dahin kann der Client
sich anmelden und die Logdatei auswerten, aber nichts hochladen.

Wer hier anfängt, sollte deshalb mit **Anmeldung + Logauswertung + Oberfläche** beginnen
und die Übertragung hinter einer klaren Schnittstelle kapseln, die später angeschlossen
wird.

## 7. Aussehen

CitizenHQ hat ein festes Erscheinungsbild („deep-space cockpit HUD"), das der Client
übernehmen soll. Die Werte stehen in `apps/web/app/globals.css` im Hauptrepo:

```
Grund      #071015    Panels     #0a171d
Akzent     #7cc5d1    (Cyan)     Achtung  #d6a34a
Erfolg     #72ba91    Gefahr     #ef5454
Text       #dce6e8 / #a9bbc1 / #879ba3
Schriften  Chakra Petch (Überschriften), Sora (Text), Space Mono (Zahlen/Labels)
```

Nur dunkel — die Plattform hat kein helles Design, ein helles hier wäre ein Bruch.

## 8. Arbeitsweise

Aus dem Hauptrepo übernommen, weil sie sich bewährt hat:

- **Prüfen statt annehmen.** Aussagen über Verhalten gehören gegen die echte Sache
  belegt — API mit echten Aufrufen, Logauswertung an einer echten `Game.log`.
- **Keine stillen Fehler.** Was schiefgeht, wird sichtbar: im Programm für den Nutzer,
  im Log für die Fehlersuche. Ein leeres `catch` ist ein Fehler.
- **Deutsch** in Oberfläche und Dokumentation, Code-Kommentare erklären das *Warum*.
- **Kein Telemetriedatenversand ohne Zustimmung.** Was der Client hochlädt, muss der
  Nutzer wissen und abschalten können.
