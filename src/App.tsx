// Anmeldebildschirm des Clients (#325, Stufe 1).
//
// Mehr kann er noch nicht — die Endpunkte für Hangar und Lager gibt es serverseitig
// noch nicht (siehe AGENTS.md §6). Das ist Absicht: erst der Weg hinein, dann die Inhalte.
import { Hangar } from "./Hangar";
import { Bauplaene } from "./Bauplaene";
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  codeAnfordern,
  tokenHolen,
  werBinIch,
  meinStand,
  nachGruppe,
  BASIS,
  type GeraeteCode,
  type MeinStand,
} from "./hq";

type Zustand =
  | { art: "start" }
  | { art: "wartet"; code: GeraeteCode; restSek: number }
  // Das Token gehoert in den Zustand, nicht nur in den localStorage: die Ansichten
  // brauchen es fuer jede Abfrage, und aus dem Speicher zu lesen hiesse, dass ein
  // Abmelden in einem Reiter woanders unbemerkt bliebe.
  | { art: "angemeldet"; token: string; name: string; email?: string }
  | { art: "fehler"; text: string };

const SPEICHER = "chq.token";

export default function App() {
  const [zustand, setZustand] = useState<Zustand>({ art: "start" });
  // Rechte werden bei jedem Start FRISCH geholt und nicht gespeichert: eine
  // zwischengespeicherte Rolle waere beim naechsten Wechsel falsch.
  const [stand, setStand] = useState<MeinStand | null>(null);
  const [beschaeftigt, setBeschaeftigt] = useState(false);
  // Wird auf true gesetzt, sobald der Nutzer abbricht — laufende Abfragen sehen das.
  const abbrechen = useRef(false);

  // Beim Start prüfen, ob ein Token vom letzten Mal noch gilt. Ein gespeichertes Token
  // heißt NICHT "angemeldet" — nur der Server kann das beantworten (das Gerät kann im
  // Profil abgemeldet worden sein).
  useEffect(() => {
    const token = localStorage.getItem(SPEICHER);
    if (!token) return;
    void werBinIch(token).then((wer) => {
      if (wer) {
        setZustand({ art: "angemeldet", token, name: wer.name, email: wer.email });
        void meinStand(token).then(setStand);
      } else localStorage.removeItem(SPEICHER);
    });
  }, []);

  const anmelden = useCallback(async () => {
    setBeschaeftigt(true);
    abbrechen.current = false;
    try {
      const code = await codeAnfordern();
      setZustand({ art: "wartet", code, restSek: code.expires_in });

      // Browser öffnen — bewusst der Standardbrowser, kein eingebettetes Fenster:
      // der Nutzer muss die Adresszeile sehen können.
      void openUrl(code.verification_uri_complete ?? code.verification_uri).catch(() => {
        /* Öffnet er nicht, steht die Adresse ja im Fenster. */
      });

      let takt = code.interval * 1000;
      const ende = Date.now() + code.expires_in * 1000;

      while (!abbrechen.current && Date.now() < ende) {
        await new Promise((r) => setTimeout(r, takt));
        if (abbrechen.current) return;

        const r = await tokenHolen(code.device_code);
        if (r.art === "fertig") {
          localStorage.setItem(SPEICHER, r.token);
          const wer = await werBinIch(r.token);
          setZustand({ art: "angemeldet", token: r.token, name: wer?.name ?? "Pilot", email: wer?.email });
          void meinStand(r.token).then(setStand);
          return;
        }
        if (r.art === "abbruch") {
          setZustand({ art: "fehler", text: r.grund });
          return;
        }
        // slow_down heißt: Abstand erhöhen. Ignoriert man das, sperrt der Server.
        if (r.art === "langsamer") takt += 2000;

        setZustand((z) =>
          z.art === "wartet" ? { ...z, restSek: Math.max(0, Math.round((ende - Date.now()) / 1000)) } : z,
        );
      }
      if (!abbrechen.current) setZustand({ art: "fehler", text: "Zeit abgelaufen. Bitte neu versuchen." });
    } catch (e) {
      setZustand({ art: "fehler", text: e instanceof Error ? e.message : "Unbekannter Fehler." });
    } finally {
      setBeschaeftigt(false);
    }
  }, []);

  const abmelden = () => {
    localStorage.removeItem(SPEICHER);
    setStand(null);
    setZustand({ art: "start" });
  };

  return (
    <div className="huelle">
      <p className="kicker">▸ CitizenHQ</p>
      <h1>Desktop-Client</h1>

      {zustand.art === "start" && (
        <div className="panel">
          <p className="weich">
            Melde dich an, damit der Client Hangar, Lager und Blaupausen für dich pflegen kann.
          </p>
          <p className="leise" style={{ marginTop: "0.75rem" }}>
            Du bestätigst im Browser auf <span className="mono">{BASIS.replace("https://", "")}</span> —
            dieses Programm sieht dein Passwort nie.
          </p>
          <div className="reihe">
            <button onClick={anmelden} disabled={beschaeftigt}>
              {beschaeftigt ? "…" : "Anmelden"}
            </button>
          </div>
        </div>
      )}

      {zustand.art === "wartet" && (
        <div className="panel">
          <p className="kicker">▸ Code im Browser eingeben</p>
          <p className="code">{zustand.code.user_code}</p>
          <p className="leise" style={{ textAlign: "center" }}>
            {zustand.code.verification_uri.replace("https://", "")}
            {" · noch "}
            {Math.floor(zustand.restSek / 60)}:{String(zustand.restSek % 60).padStart(2, "0")}
          </p>
          <p className="leise" style={{ marginTop: "1rem" }}>
            Der Browser sollte sich geöffnet haben. Falls nicht, ruf die Adresse selbst auf und
            gib den Code ein.
          </p>
          <div className="reihe">
            <button
              className="stumm"
              onClick={() => {
                abbrechen.current = true;
                setZustand({ art: "start" });
              }}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {zustand.art === "angemeldet" && (
        <div className="panel">
          <p className="kicker gut">▸ Verbunden</p>
          <p style={{ fontSize: "1.4rem", marginTop: "0.5rem" }}>{zustand.name}</p>
          {zustand.email && <p className="leise">{zustand.email}</p>}
          {stand && (
            <p className="leise" style={{ marginTop: "0.35rem" }}>
              Konto-Rolle: <span className="mono">{stand.nutzer.rolle}</span>
              {stand.nutzer.rolle === "user" && " (normales Konto)"}
            </p>
          )}
          <p className="leise" style={{ marginTop: "1rem" }}>
            Lager und Blaupausen folgen — die Schnittstellen dafür entstehen gerade
            (#325). Den Zugriff kannst du jederzeit im Profil unter „Verbundene Geräte"
            wieder entziehen.
          </p>
          <div className="reihe">
            <button className="stumm" onClick={abmelden}>
              Abmelden
            </button>
          </div>
        </div>
      )}

      {/* Log-Scan braucht keine Anmeldung: er liest nur lokal (#501). */}
      <Bauplaene />

      {zustand.art === "angemeldet" && (
        <Hangar token={zustand.token} aufAbmeldung={abmelden} />
      )}

      {zustand.art === "angemeldet" && stand && (
        <div className="panel">
          <p className="kicker">▸ Deine Rechte</p>
          {stand.organisationen.length === 0 ? (
            <p className="leise" style={{ marginTop: "0.75rem" }}>
              Du bist in keiner Orga. Für deinen eigenen Hangar und dein Lager brauchst du
              keine Rechte — die gehören dir.
            </p>
          ) : (
            stand.organisationen.map((o) => (
              <div key={o.id} style={{ marginTop: "1.25rem" }}>
                <p style={{ fontSize: "1.05rem" }}>
                  {o.name}{" "}
                  <span className="leise">
                    {/* Eigentuemer, Rolle und Rang nebeneinander — sie bedeuten
                        Verschiedenes: Eigentuemer darf alles, die Rolle vergibt Rechte,
                        der Rang ist reine Auszeichnung. */}
                    {[
                      o.istEigentuemer ? "Eigentümer" : null,
                      o.rolle ?? (o.istEigentuemer ? null : "ohne Rolle"),
                      o.rang,
                    ]
                      .filter(Boolean)
                      .map((t) => `· ${t}`)
                      .join(" ")}
                  </span>
                </p>
                {o.status === "suspended" && (
                  <p className="warnung mono" style={{ fontSize: "0.72rem", marginTop: "0.25rem" }}>
                    Mitgliedschaft ruht — deine Rollenrechte gelten nicht.
                  </p>
                )}
                {o.rechte.length === 0 ? (
                  <p className="leise">Keine besonderen Rechte.</p>
                ) : (
                  <>
                    <p className="leise mono" style={{ fontSize: "0.68rem", marginTop: "0.35rem" }}>
                      {o.rechte.length} Rechte
                    </p>
                    {/* Nach Bereich gegliedert: zwei Dutzend Zeilen am Stueck liest
                        niemand, und man sieht nicht, ob etwas fehlt. */}
                    {nachGruppe(o.rechte).map(([gruppe, liste]) => (
                      <div key={gruppe} style={{ marginTop: "0.6rem" }}>
                        <p className="kicker" style={{ fontSize: "0.6rem", opacity: 0.75 }}>
                          {gruppe}
                        </p>
                        <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.1rem" }}>
                          {liste.map((r) => (
                            <li key={r.key} className="leise" style={{ lineHeight: 1.8 }}>
                              {r.text}{" "}
                              <span className="mono" style={{ opacity: 0.5 }}>{r.key}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))
          )}
          <p className="leise" style={{ marginTop: "1.25rem" }}>
            Diese Liste ist eine Anzeige. Ob eine Aktion erlaubt ist, entscheidet der Server im
            Moment der Aktion — verlierst du eine Rolle, gilt das sofort.
          </p>
        </div>
      )}

      {zustand.art === "fehler" && (
        <div className="panel">
          <p className="kicker fehler">▸ Nicht geklappt</p>
          <p className="weich" style={{ marginTop: "0.5rem" }}>{zustand.text}</p>
          <div className="reihe">
            <button onClick={anmelden} disabled={beschaeftigt}>
              Nochmal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
