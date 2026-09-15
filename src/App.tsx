// Gerüst des Clients: Kopfzeile mit Konto, Reiter, eine Ansicht zur Zeit.
//
// Bis 15.09.2026 stand alles untereinander auf einer Seite (Anmeldung, Blaupausen,
// Hangar, Rechte). Owner: zu lang. Jetzt Reiter; Blaupausen zuerst, weil das die
// Aufgabe ist, für die man die App startet.
//
// Anmeldung (Device Authorization Flow, #325) und Rechteanzeige sind unverändert
// übernommen und liegen im Reiter "Konto".
import { Hangar } from "./Hangar";
import { Bauplaene } from "./Bauplaene";
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
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

type Reiter = "blaupausen" | "hangar" | "konto";

// Vom Updater im Rust-Teil (src-tauri/src/update.rs). Nur Anzeige: Updates laufen ohne
// Nachfrage, der Nutzer soll aber sehen, warum die App gleich neu startet.
type UpdateStand =
  | { art: "laedt"; version: string }
  | { art: "installiert"; version: string }
  | { art: "fehler"; text: string };

const SPEICHER = "chq.token";

export default function App() {
  const [zustand, setZustand] = useState<Zustand>({ art: "start" });
  const [reiter, setReiter] = useState<Reiter>("blaupausen");
  // Rechte werden bei jedem Start FRISCH geholt und nicht gespeichert: eine
  // zwischengespeicherte Rolle waere beim naechsten Wechsel falsch.
  const [stand, setStand] = useState<MeinStand | null>(null);
  const [beschaeftigt, setBeschaeftigt] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStand | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
    const aus = listen<UpdateStand>("update", (e) => setUpdate(e.payload));
    return () => {
      void aus.then((f) => f());
    };
  }, []);
  // Wird auf true gesetzt, sobald der Nutzer abbricht; laufende Abfragen sehen das.
  const abbrechen = useRef(false);

  // Beim Start pruefen, ob ein Token vom letzten Mal noch gilt. Ein gespeichertes Token
  // heisst NICHT "angemeldet"; nur der Server kann das beantworten (das Geraet kann im
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

      // Bewusst der Standardbrowser, kein eingebettetes Fenster: der Nutzer muss die
      // Adresszeile sehen koennen.
      void openUrl(code.verification_uri_complete ?? code.verification_uri).catch(() => {
        /* Oeffnet er nicht, steht die Adresse ja im Fenster. */
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
          // Zurueck dorthin, wofuer man sich angemeldet hat.
          setReiter("blaupausen");
          return;
        }
        if (r.art === "abbruch") {
          setZustand({ art: "fehler", text: r.grund });
          return;
        }
        // slow_down heisst: Abstand erhoehen. Ignoriert man das, sperrt der Server.
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

  const abmelden = useCallback(() => {
    localStorage.removeItem(SPEICHER);
    setStand(null);
    setZustand({ art: "start" });
  }, []);

  const token = zustand.art === "angemeldet" ? zustand.token : null;

  const REITER: { key: Reiter; text: string }[] = [
    { key: "blaupausen", text: "Blaupausen" },
    { key: "hangar", text: "Hangar" },
    { key: "konto", text: "Konto" },
  ];

  return (
    <div className="app">
      <header className="kopf">
        <span className="logo">
          CITIZEN<span className="marke">HQ</span>
        </span>
        <nav className="reiter">
          {REITER.map((r) => (
            <button key={r.key} aria-current={reiter === r.key} onClick={() => setReiter(r.key)}>
              {r.text}
            </button>
          ))}
        </nav>
        {update && update.art !== "fehler" && (
          <span className="leise" role="status">
            {update.art === "laedt"
              ? `Update ${update.version} wird geladen`
              : `Update ${update.version} wird installiert, die App startet neu`}
          </span>
        )}
        <button className="konto-chip" onClick={() => setReiter("konto")}>
          <span className={"punkt" + (token ? " an" : "")} />
          {zustand.art === "angemeldet" ? zustand.name : "Nicht angemeldet"}
        </button>
      </header>

      <main className="inhalt">
        {reiter === "blaupausen" && (
          <Bauplaene token={token} zurAnmeldung={() => setReiter("konto")} aufAbmeldung={abmelden} />
        )}

        {reiter === "hangar" &&
          (token ? (
            <Hangar token={token} aufAbmeldung={abmelden} />
          ) : (
            <div className="panel">
              <p className="weich">Für deinen Hangar musst du angemeldet sein.</p>
              <div className="reihe">
                <button className="haupt" onClick={() => setReiter("konto")}>
                  Anmelden
                </button>
              </div>
            </div>
          ))}

        {reiter === "konto" && (
          <div className="spalte">
            {zustand.art === "start" && (
              <div className="panel">
                <p className="weich">
                  Melde dich an, damit die App deine Blaupausen und deinen Hangar auf CitizenHQ
                  pflegen kann.
                </p>
                <p className="leise" style={{ marginTop: "0.75rem" }}>
                  Du bestätigst im Browser auf{" "}
                  <span className="mono">{BASIS.replace("https://", "")}</span>. Dein Passwort
                  sieht diese App nie.
                </p>
                <div className="reihe">
                  <button className="haupt" onClick={anmelden} disabled={beschaeftigt}>
                    {beschaeftigt ? "…" : "Anmelden"}
                  </button>
                </div>
              </div>
            )}

            {zustand.art === "wartet" && (
              <div className="panel">
                <p className="kicker">Code im Browser eingeben</p>
                <p className="code">{zustand.code.user_code}</p>
                <p className="leise" style={{ textAlign: "center" }}>
                  {zustand.code.verification_uri.replace("https://", "")}, noch{" "}
                  {Math.floor(zustand.restSek / 60)}:{String(zustand.restSek % 60).padStart(2, "0")}
                </p>
                <p className="leise" style={{ marginTop: "1rem" }}>
                  Der Browser sollte sich geöffnet haben. Falls nicht, ruf die Adresse selbst auf
                  und gib den Code ein.
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

            {zustand.art === "fehler" && (
              <div className="panel">
                <p className="kicker fehler">Nicht geklappt</p>
                <p className="weich" style={{ marginTop: "0.5rem" }}>{zustand.text}</p>
                <div className="reihe">
                  <button onClick={anmelden} disabled={beschaeftigt}>
                    Nochmal
                  </button>
                </div>
              </div>
            )}

            {zustand.art === "angemeldet" && (
              <div className="panel">
                <p className="kicker gut">Verbunden</p>
                <p style={{ fontSize: "1.3rem", marginTop: "0.5rem" }}>{zustand.name}</p>
                {zustand.email && <p className="leise">{zustand.email}</p>}
                {stand && (
                  <p className="leise" style={{ marginTop: "0.35rem" }}>
                    Konto-Rolle: <span className="mono">{stand.nutzer.rolle}</span>
                  </p>
                )}
                <p className="leise" style={{ marginTop: "1rem" }}>
                  Den Zugriff kannst du jederzeit im Profil unter „Verbundene Geräte“ entziehen.
                </p>
                <div className="reihe">
                  <button className="stumm" onClick={abmelden}>
                    Abmelden
                  </button>
                </div>
              </div>
            )}

            {zustand.art === "angemeldet" && stand && (
              <div className="panel">
                <p className="kicker">Deine Rechte</p>
                {stand.organisationen.length === 0 ? (
                  <p className="leise" style={{ marginTop: "0.75rem" }}>
                    Du bist in keiner Orga. Für deinen eigenen Hangar brauchst du keine Rechte, der
                    gehört dir.
                  </p>
                ) : (
                  stand.organisationen.map((o) => (
                    <div key={o.id} style={{ marginTop: "1.25rem" }}>
                      <p style={{ fontSize: "1.05rem" }}>
                        {o.name}{" "}
                        <span className="leise">
                          {/* Eigentuemer, Rolle und Rang bedeuten Verschiedenes: Eigentuemer
                              darf alles, die Rolle vergibt Rechte, der Rang ist Auszeichnung. */}
                          {[
                            o.istEigentuemer ? "Eigentümer" : null,
                            o.rolle ?? (o.istEigentuemer ? null : "ohne Rolle"),
                            o.rang,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </p>
                      {o.status === "suspended" && (
                        <p className="warnung mono" style={{ fontSize: "0.72rem", marginTop: "0.25rem" }}>
                          Mitgliedschaft ruht, deine Rollenrechte gelten nicht.
                        </p>
                      )}
                      {o.rechte.length === 0 ? (
                        <p className="leise">Keine besonderen Rechte.</p>
                      ) : (
                        nachGruppe(o.rechte).map(([gruppe, liste]) => (
                          <div key={gruppe} style={{ marginTop: "0.6rem" }}>
                            <p className="kicker" style={{ fontSize: "0.6rem", opacity: 0.75 }}>
                              {gruppe}
                            </p>
                            <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.1rem" }}>
                              {liste.map((r) => (
                                <li key={r.key} className="leise" style={{ lineHeight: 1.8 }}>
                                  {r.text}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))
                      )}
                    </div>
                  ))
                )}
                <p className="leise" style={{ marginTop: "1.25rem" }}>
                  Diese Liste ist nur eine Anzeige. Ob eine Aktion erlaubt ist, entscheidet der
                  Server in dem Moment. Verlierst du eine Rolle, gilt das sofort.
                </p>
              </div>
            )}
            <p className="leise" style={{ textAlign: "center" }}>
              CitizenHQ-App {version ?? ""}. Updates kommen automatisch.
              {update?.art === "fehler" && ` Letzte Prüfung ging nicht: ${update.text}`}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
