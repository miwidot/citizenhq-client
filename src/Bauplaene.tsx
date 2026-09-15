// Blaupausen aus der Game.log (scverse #501): einlesen, merken, hochladen.
//
// Die App merkt sich alles in bauplaene.json im App-Datenordner (src-tauri/src/bestand.rs):
// - welche Blaupausen gefunden wurden (bleiben, auch wenn das Spiel alte Logs loescht),
// - welche davon schon erfolgreich hochgeladen sind,
// - wie weit jede Log-Datei gelesen ist.
// Beim Start steht der Stand deshalb sofort da, ohne Scan. "Neue Logs einlesen" liest nur,
// was seit dem letzten Mal dazugekommen ist, und "Hochladen" schickt nur, was noch offen ist.
//
// Hochgeladen wird NUR, wenn der Nutzer es sieht und will: per Knopf, oder mit dem sichtbaren
// Schalter "Automatisch", standardmaessig aus (AGENTS.md: keine Uebertragung ohne Zustimmung).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bauplaeneLesen, bauplaeneMelden, BASIS, type BauplanStand } from "./hq";

type DateiStand = { pfad: string; zeilen: number; treffer: number; fehler: string | null; art: "unveraendert" | "weiter" | "neu" };
type ScanErgebnis = {
  ordner: string[];
  dateien: DateiStand[];
  bauplaene: { name: string }[];
  fundeGesamt: number;
  verdaechtig: string[];
};
type Eintrag = {
  zeit: string | null;
  sprache: string | null;
  gefunden: string;
  hochgeladen: string | null;
  status: "ok" | "unbekannt" | "mehrdeutig" | null;
};
type BestandAntwort = {
  pfad: string;
  bestand: { format: number; bauplaene: Record<string, Eintrag> };
  scan: ScanErgebnis | null;
  warnung: string | null;
};

const ORDNER = "chq.spielordner";
const AUTO = "chq.auto-upload";
// Alle 60 s nachsehen, wenn "Automatisch" an ist. Dank der Lesestellen liest ein Durchgang
// nur die neuen Zeilen der laufenden Game.log und faellt beim Spielen nicht auf.
const TAKT_MS = 60_000;
// So viel schickt ein Upload hoechstens; der Server nimmt bis 3000.
const MAX_JE_UPLOAD = 2000;

const zahl = (n: number) => new Intl.NumberFormat("de-DE").format(n);
const dateiname = (pfad: string) => pfad.split(/[\\/]/).pop() ?? pfad;
const speicherLesen = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const speicherSetzen = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* Nur Bequemlichkeit: ohne Speicher gilt die Einstellung bis zum Schliessen. */
  }
};
const zeitText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "";
const fehlerText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Bauplaene({
  token,
  zurAnmeldung,
  aufAbmeldung,
}: {
  token: string | null;
  zurAnmeldung: () => void;
  aufAbmeldung: () => void;
}) {
  const [ordner, setOrdner] = useState(() => speicherLesen(ORDNER) ?? "");
  const [auto, setAuto] = useState(() => speicherLesen(AUTO) === "1");
  const [stand, setStand] = useState<BestandAntwort | null>(null);
  const [scan, setScan] = useState<ScanErgebnis | null>(null);
  const [server, setServer] = useState<BauplanStand | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState<"scan" | "upload" | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ordnerOffen, setOrdnerOffen] = useState(false);
  const [dateienOffen, setDateienOffen] = useState(false);
  const [filter, setFilter] = useState<"alle" | "offen" | "problem">("alle");
  const beschaeftigt = useRef(false);

  // Gespeicherten Stand sofort zeigen, ohne Logs anzufassen.
  useEffect(() => {
    invoke<BestandAntwort>("bestand_lesen")
      .then(setStand)
      .catch((e) => setFehler(`Gespeicherter Stand nicht lesbar: ${fehlerText(e)}`));
  }, []);

  const serverLaden = useCallback(async () => {
    if (!token) return setServer(null);
    try {
      setServer(await bauplaeneLesen(token));
    } catch (e) {
      if ((e as Error).message === "ABGEMELDET") aufAbmeldung();
      else setFehler(fehlerText(e));
    }
  }, [token, aufAbmeldung]);

  useEffect(() => {
    void serverLaden();
  }, [serverLaden]);

  const einlesen = useCallback(
    async (vonVorn = false): Promise<BestandAntwort | null> => {
      setLaeuft("scan");
      setFehler(null);
      try {
        const r = await invoke<BestandAntwort>("bauplaene_aktualisieren", {
          ordner: ordner.trim() || null,
          jetzt: new Date().toISOString(),
          vonVorn,
        });
        setStand(r);
        setScan(r.scan);
        return r;
      } catch (e) {
        setFehler(`Logs lesen ging nicht: ${fehlerText(e)}`);
        return null;
      } finally {
        setLaeuft(null);
      }
    },
    [ordner],
  );

  const hochladen = useCallback(
    async (quelle?: BestandAntwort | null) => {
      const s = quelle ?? stand;
      if (!token || !s) return;
      // Nur, was noch nicht erfolgreich oben ist. Nicht zugeordnete gehen erneut mit:
      // der Server kann sie inzwischen kennen.
      const offen = Object.entries(s.bestand.bauplaene)
        .filter(([, e]) => !e.hochgeladen)
        .slice(0, MAX_JE_UPLOAD);
      if (offen.length === 0) {
        setMeldung("Alles schon hochgeladen.");
        return;
      }
      setLaeuft("upload");
      setFehler(null);
      try {
        const r = await bauplaeneMelden(
          token,
          offen.map(([name, e]) => ({ name, zeit: e.zeit })),
        );
        const unbekannt = new Set(r.unbekannt);
        const mehrdeutig = new Set(r.mehrdeutig);
        const neu = await invoke<BestandAntwort>("bestand_rueckmeldung_merken", {
          rueckmeldungen: offen.map(([name]) => ({
            name,
            status: unbekannt.has(name) ? "unbekannt" : mehrdeutig.has(name) ? "mehrdeutig" : "ok",
          })),
          jetzt: new Date().toISOString(),
        });
        setStand(neu);
        const problem = r.unbekannt.length + r.mehrdeutig.length;
        setMeldung(
          `${r.neu} neu eingetragen, ${r.schonDa} waren schon da` +
            (problem ? `, ${problem} nicht zugeordnet.` : ".") +
            ` ${new Date().toLocaleTimeString("de-DE")}`,
        );
        await serverLaden();
      } catch (e) {
        if ((e as Error).message === "ABGEMELDET") aufAbmeldung();
        else setFehler(`Hochladen ging nicht: ${fehlerText(e)}`);
      } finally {
        setLaeuft(null);
      }
    },
    [token, stand, serverLaden, aufAbmeldung],
  );

  // Automatisch: einlesen und hochladen im Takt. Laeuft ein Durchgang noch, faellt der
  // naechste aus, statt sich zu stapeln.
  const durchgang = useRef<() => Promise<void>>(async () => {});
  durchgang.current = async () => {
    if (beschaeftigt.current) return;
    beschaeftigt.current = true;
    try {
      const r = await einlesen();
      if (r) await hochladen(r);
    } finally {
      beschaeftigt.current = false;
    }
  };
  useEffect(() => {
    if (!auto || !token) return;
    void durchgang.current();
    const id = window.setInterval(() => void durchgang.current(), TAKT_MS);
    return () => window.clearInterval(id);
  }, [auto, token]);

  const eintraege = useMemo(
    () =>
      Object.entries(stand?.bestand.bauplaene ?? {}).sort(([, a], [, b]) =>
        (b.zeit ?? b.gefunden).localeCompare(a.zeit ?? a.gefunden),
      ),
    [stand],
  );
  const anzahlOffen = eintraege.filter(([, e]) => !e.hochgeladen).length;
  const anzahlProblem = eintraege.filter(([, e]) => e.status === "unbekannt" || e.status === "mehrdeutig").length;
  const liste = eintraege.filter(([, e]) =>
    filter === "alle"
      ? true
      : filter === "offen"
        ? !e.hochgeladen
        : e.status === "unbekannt" || e.status === "mehrdeutig",
  );
  const gelesen = scan?.dateien.filter((d) => d.art !== "unveraendert") ?? [];
  const dateiFehler = scan?.dateien.filter((d) => d.fehler) ?? [];

  return (
    <div className="spalte">
      <div className="kacheln">
        <div className="kachel">
          <span className="kachel-wert">{stand ? zahl(eintraege.length) : "…"}</span>
          <span className="leise">gefunden und gespeichert</span>
        </div>
        <div className="kachel">
          <span className="kachel-wert">
            {server ? zahl(server.bauplaene.length) : "…"}
            {server && <span className="leise"> / {zahl(server.gesamt)}</span>}
          </span>
          <span className="leise">{token ? "auf CitizenHQ" : "auf CitizenHQ (nicht angemeldet)"}</span>
        </div>
        <div className="kachel">
          <span className={"kachel-wert" + (anzahlOffen > 0 ? " marke" : "")}>{stand ? zahl(anzahlOffen) : "…"}</span>
          <span className="leise">noch nicht hochgeladen</span>
        </div>
      </div>

      <div className="panel">
        <div className="reihe" style={{ marginTop: 0, alignItems: "center" }}>
          <button onClick={() => void einlesen()} disabled={laeuft !== null}>
            {laeuft === "scan" ? "Lese Logs …" : "Neue Logs einlesen"}
          </button>
          {token ? (
            <button className="haupt" onClick={() => void hochladen()} disabled={laeuft !== null || anzahlOffen === 0}>
              {laeuft === "upload" ? "Lade hoch …" : anzahlOffen ? `${zahl(anzahlOffen)} hochladen` : "Alles hochgeladen"}
            </button>
          ) : (
            <button className="haupt" onClick={zurAnmeldung}>
              Zum Hochladen anmelden
            </button>
          )}
          <label className={"schalter" + (token ? "" : " aus")}>
            <input
              type="checkbox"
              checked={auto && Boolean(token)}
              disabled={!token}
              onChange={(e) => {
                setAuto(e.target.checked);
                speicherSetzen(AUTO, e.target.checked ? "1" : "0");
              }}
            />
            Automatisch alle 60 s
          </label>
        </div>

        <p className="leise" style={{ marginTop: "0.75rem" }}>
          Gelesen wird nur, was seit dem letzten Mal neu in Game.log und logbackups steht.
          Hochgeladen werden nur die Namen der Blaupausen und wann du sie bekommen hast, an{" "}
          {BASIS.replace("https://", "")}.
        </p>

        {scan && (
          <p className="leise" style={{ marginTop: "0.35rem" }}>
            {gelesen.length === 0
              ? `Nichts Neues in ${zahl(scan.dateien.length)} Dateien.`
              : `${zahl(gelesen.reduce((s, d) => s + d.zeilen, 0))} neue Zeilen aus ${zahl(gelesen.length)} von ${zahl(scan.dateien.length)} Dateien gelesen, ${zahl(scan.bauplaene.length)} Blaupausen darin.`}
          </p>
        )}
        {meldung && <p className="gut" style={{ marginTop: "0.5rem" }}>{meldung}</p>}
        {stand?.warnung && <p className="warnung" style={{ marginTop: "0.5rem" }}>{stand.warnung}</p>}
        {fehler && <p className="fehler" style={{ marginTop: "0.5rem" }}>{fehler}</p>}

        <div className="reihe" style={{ gap: "1.25rem" }}>
          <button className="link" style={{ marginTop: 0 }} onClick={() => setOrdnerOffen((o) => !o)}>
            {ordnerOffen ? "Einstellungen ausblenden" : `Spielordner: ${ordner || "automatisch suchen"}`}
          </button>
        </div>
        {ordnerOffen && (
          <div style={{ marginTop: "0.5rem" }}>
            <label className="leise" style={{ display: "block" }}>
              Ordner, in dem die Game.log liegt. Leer lassen, dann wird gesucht.
              <input
                value={ordner}
                onChange={(e) => {
                  setOrdner(e.target.value);
                  speicherSetzen(ORDNER, e.target.value);
                }}
                placeholder="C:\Program Files\Roberts Space Industries\StarCitizen\LIVE"
                className="eingabe"
              />
            </label>
            {stand && (
              <p className="leise mono zeile" title={stand.pfad}>
                Gespeichert in {stand.pfad}
              </p>
            )}
            <div className="reihe">
              <button className="stumm" onClick={() => void einlesen(true)} disabled={laeuft !== null}>
                Alle Logs komplett neu einlesen
              </button>
            </div>
            <p className="leise" style={{ marginTop: "0.35rem" }}>
              Vergisst nur, wie weit die Logs gelesen sind. Gespeicherte Blaupausen bleiben.
            </p>
          </div>
        )}
      </div>

      {scan && scan.dateien.length === 0 && (
        <div className="panel warnung">
          {scan.ordner.length === 0
            ? "Keinen Star-Citizen-Ordner gefunden. Trag unter Spielordner den Ordner ein, in dem die Game.log liegt."
            : `In ${scan.ordner.join(", ")} liegt keine Game.log und kein logbackups-Ordner.`}
        </div>
      )}

      {(anzahlProblem > 0 || dateiFehler.length > 0 || (scan?.verdaechtig.length ?? 0) > 0) && (
        <div className="panel">
          <p className="kicker warnung">Nicht sauber gelesen</p>
          {dateiFehler.map((d) => (
            <p key={d.pfad} className="warnung">
              {dateiname(d.pfad)}: {d.fehler}
            </p>
          ))}
          {anzahlProblem > 0 && (
            <p className="leise" style={{ marginTop: "0.5rem" }}>
              {anzahlProblem} Namen kennt CitizenHQ nicht eindeutig. Sie gehen beim nächsten
              Hochladen erneut mit. Bis dahin kannst du sie auf der Webseite von Hand abhaken.
            </p>
          )}
          {scan && scan.verdaechtig.length > 0 && (
            <>
              <p className="leise" style={{ marginTop: "0.5rem" }}>
                Diese Zeilen klingen nach Blaupause, wurden aber nicht erkannt. Schick sie uns, dann
                passen wir das an.
              </p>
              {scan.verdaechtig.map((z, i) => (
                <p key={i} className="mono zeile">{z}</p>
              ))}
            </>
          )}
        </div>
      )}

      {eintraege.length > 0 && (
        <div className="panel">
          <div className="reihe" style={{ marginTop: 0, justifyContent: "space-between", alignItems: "baseline" }}>
            <p className="leise">{zahl(eintraege.length)} Blaupausen gespeichert</p>
            <div className="umschalter">
              {(
                [
                  ["alle", "Alle"],
                  ["offen", `Nicht hochgeladen (${anzahlOffen})`],
                  ["problem", `Nicht zugeordnet (${anzahlProblem})`],
                ] as const
              ).map(([wert, text]) => (
                <button key={wert} aria-pressed={filter === wert} onClick={() => setFilter(wert)}>
                  {text}
                </button>
              ))}
            </div>
          </div>
          <ul className="liste">
            {liste.map(([name, e]) => {
              const art = e.status === "unbekannt" || e.status === "mehrdeutig" ? "problem" : e.hochgeladen ? "da" : "neu";
              return (
                <li key={name}>
                  <span>{name}</span>
                  <span className="leise mono">
                    {zeitText(e.zeit)}{" "}
                    <span className={"etikett " + art}>
                      {art === "da" ? "hochgeladen" : art === "problem" ? "nicht zugeordnet" : "offen"}
                    </span>
                  </span>
                </li>
              );
            })}
            {liste.length === 0 && <li className="leise">Nichts in diesem Filter.</li>}
          </ul>
          {scan && scan.dateien.length > 0 && (
            <>
              <button className="link" onClick={() => setDateienOffen((o) => !o)}>
                {dateienOffen ? "Dateien ausblenden" : "Dateien vom letzten Einlesen zeigen"}
              </button>
              {dateienOffen &&
                scan.dateien.map((d) => (
                  <p key={d.pfad} className="leise mono zeile" title={d.pfad}>
                    {dateiname(d.pfad)}:{" "}
                    {d.art === "unveraendert"
                      ? "unverändert, übersprungen"
                      : `${d.art === "weiter" ? "weitergelesen" : "neu gelesen"}, ${zahl(d.zeilen)} Zeilen, ${d.treffer} Treffer`}
                  </p>
                ))}
            </>
          )}
        </div>
      )}

      {stand && eintraege.length === 0 && !scan && (
        <div className="panel">
          <p className="weich">Noch nichts gespeichert. Lies einmal deine Logs ein, danach geht es schnell.</p>
        </div>
      )}
    </div>
  );
}
