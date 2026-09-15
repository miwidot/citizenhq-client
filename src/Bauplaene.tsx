// Blaupausen aus der Game.log (scverse #501): einlesen, zeigen, hochladen.
//
// Hochgeladen wird NUR, wenn der Nutzer es sieht und will: per Knopf, oder mit dem
// Schalter "Automatisch", der sichtbar im Reiter steht und standardmaessig aus ist
// (AGENTS.md: keine Uebertragung ohne Zustimmung).
//
// Der Server ist die Wahrheit, was schon auf CitizenHQ steht. Der Client merkt sich
// nicht, was er geschickt hat; er schickt bei jedem Hochladen alles, der Server
// schreibt nichts doppelt.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bauplaeneLesen, bauplaeneMelden, BASIS, type BauplanStand, type MeldeErgebnis } from "./hq";

type Treffer = { name: string; sprache: "de" | "en"; zeit: string | null; datei: string };
type DateiStand = { pfad: string; zeilen: number; treffer: number; fehler: string | null };
type ScanErgebnis = {
  ordner: string[];
  dateien: DateiStand[];
  bauplaene: Treffer[];
  fundeGesamt: number;
  verdaechtig: string[];
};

const ORDNER = "chq.spielordner";
const AUTO = "chq.auto-upload";
// Alle 60 s neu einlesen, wenn "Automatisch" an ist. Oft genug, dass eine neue
// Blaupause kurz nach dem Erhalt auftaucht; selten genug, dass das Lesen der Logs
// beim Spielen nicht auffaellt.
const TAKT_MS = 60_000;

const zahl = (n: number) => new Intl.NumberFormat("de-DE").format(n);
const dateiname = (pfad: string) => pfad.split(/[\\/]/).pop() ?? pfad;
const lesen = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const zeitText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "";

export function Bauplaene({
  token,
  zurAnmeldung,
  aufAbmeldung,
}: {
  token: string | null;
  zurAnmeldung: () => void;
  aufAbmeldung: () => void;
}) {
  const [ordner, setOrdner] = useState(() => lesen(ORDNER) ?? "");
  const [auto, setAuto] = useState(() => lesen(AUTO) === "1");
  const [scan, setScan] = useState<ScanErgebnis | null>(null);
  const [server, setServer] = useState<BauplanStand | null>(null);
  const [meldung, setMeldung] = useState<MeldeErgebnis | null>(null);
  const [zuletzt, setZuletzt] = useState<Date | null>(null);
  const [laeuft, setLaeuft] = useState<"scan" | "upload" | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [ordnerOffen, setOrdnerOffen] = useState(false);
  const [dateienOffen, setDateienOffen] = useState(false);
  const [filter, setFilter] = useState<"alle" | "neu" | "problem">("alle");
  const beschaeftigt = useRef(false);

  const serverLaden = useCallback(async () => {
    if (!token) return setServer(null);
    try {
      setServer(await bauplaeneLesen(token));
    } catch (e) {
      if ((e as Error).message === "ABGEMELDET") aufAbmeldung();
      else setFehler((e as Error).message);
    }
  }, [token, aufAbmeldung]);

  useEffect(() => {
    void serverLaden();
  }, [serverLaden]);

  const einlesen = useCallback(async (): Promise<ScanErgebnis | null> => {
    setLaeuft("scan");
    setFehler(null);
    try {
      const r = await invoke<ScanErgebnis>("bauplaene_scannen", { ordner: ordner.trim() || null });
      setScan(r);
      return r;
    } catch (e) {
      setFehler(`Logs lesen ging nicht: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setLaeuft(null);
    }
  }, [ordner]);

  const hochladen = useCallback(
    async (quelle?: ScanErgebnis | null) => {
      const s = quelle ?? scan;
      if (!token || !s || s.bauplaene.length === 0) return;
      setLaeuft("upload");
      setFehler(null);
      try {
        const r = await bauplaeneMelden(
          token,
          s.bauplaene.map((b) => ({ name: b.name, zeit: b.zeit })),
        );
        setMeldung(r);
        setZuletzt(new Date());
        await serverLaden();
      } catch (e) {
        if ((e as Error).message === "ABGEMELDET") aufAbmeldung();
        else setFehler(`Hochladen ging nicht: ${(e as Error).message}`);
      } finally {
        setLaeuft(null);
      }
    },
    [token, scan, serverLaden, aufAbmeldung],
  );

  // Automatisch: einlesen und hochladen im Takt. Laeuft ein Durchgang noch, faellt
  // der naechste aus, statt sich zu stapeln.
  useEffect(() => {
    if (!auto || !token) return;
    const durchgang = async () => {
      if (beschaeftigt.current) return;
      beschaeftigt.current = true;
      try {
        const r = await einlesen();
        if (r) await hochladen(r);
      } finally {
        beschaeftigt.current = false;
      }
    };
    void durchgang();
    const id = window.setInterval(durchgang, TAKT_MS);
    return () => window.clearInterval(id);
    // einlesen/hochladen absichtlich nicht als Abhaengigkeit: sonst startet jede
    // neue Antwort den Takt neu und liest sofort wieder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, token]);

  const autoSetzen = (an: boolean) => {
    setAuto(an);
    try {
      localStorage.setItem(AUTO, an ? "1" : "0");
    } catch {
      /* Nur Bequemlichkeit: ohne Speicher gilt der Schalter bis zum Schliessen. */
    }
  };
  const ordnerSpeichern = (wert: string) => {
    setOrdner(wert);
    try {
      localStorage.setItem(ORDNER, wert);
    } catch {
      /* siehe oben */
    }
  };

  // Status je Name: auf CitizenHQ, nicht zuordenbar, oder noch nicht hochgeladen.
  const aufServer = useMemo(
    () => new Set((server?.bauplaene ?? []).map((b) => b.name.toLowerCase())),
    [server],
  );
  const probleme = useMemo(
    () => new Set([...(meldung?.unbekannt ?? []), ...(meldung?.mehrdeutig ?? [])]),
    [meldung],
  );
  const status = (name: string): "da" | "problem" | "neu" => {
    if (probleme.has(name)) return "problem";
    // Die Log schreibt "Sedulity (Ind/2/B)", der Server fuehrt "Sedulity".
    const basis = name.replace(/\s*\([^()]*\/[^()]*\)\s*$/, "").toLowerCase();
    return aufServer.has(basis) ? "da" : "neu";
  };

  const liste = (scan?.bauplaene ?? []).filter((b) => filter === "alle" || status(b.name) === filter);
  const anzahlNeu = (scan?.bauplaene ?? []).filter((b) => status(b.name) === "neu").length;
  const zeilen = scan?.dateien.reduce((s, d) => s + d.zeilen, 0) ?? 0;
  const dateiFehler = scan?.dateien.filter((d) => d.fehler) ?? [];

  return (
    <div className="spalte">
      <div className="kacheln">
        <div className="kachel">
          <span className="kachel-wert">{scan ? zahl(scan.bauplaene.length) : "?"}</span>
          <span className="leise">in deinen Logs</span>
        </div>
        <div className="kachel">
          <span className="kachel-wert">
            {server ? zahl(server.bauplaene.length) : "?"}
            {server && <span className="leise"> / {zahl(server.gesamt)}</span>}
          </span>
          <span className="leise">auf CitizenHQ</span>
        </div>
        <div className="kachel">
          <span className={"kachel-wert" + (anzahlNeu > 0 ? " marke" : "")}>{scan ? zahl(anzahlNeu) : "?"}</span>
          <span className="leise">noch nicht hochgeladen</span>
        </div>
      </div>

      <div className="panel">
        <div className="reihe" style={{ marginTop: 0, alignItems: "center" }}>
          <button onClick={() => void einlesen()} disabled={laeuft !== null}>
            {laeuft === "scan" ? "Lese Logs …" : scan ? "Neu einlesen" : "Logs einlesen"}
          </button>
          {token ? (
            <button
              className="haupt"
              onClick={() => void hochladen()}
              disabled={laeuft !== null || !scan || scan.bauplaene.length === 0}
            >
              {laeuft === "upload" ? "Lade hoch …" : "Hochladen"}
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
              onChange={(e) => autoSetzen(e.target.checked)}
            />
            Automatisch alle 60 s
          </label>
        </div>

        <p className="leise" style={{ marginTop: "0.75rem" }}>
          Gelesen werden Game.log und die alten Logs in logbackups. Hochgeladen werden nur die
          Namen der Blaupausen und wann du sie bekommen hast, an {BASIS.replace("https://", "")}.
          {zuletzt && ` Zuletzt hochgeladen ${zuletzt.toLocaleTimeString("de-DE")}.`}
        </p>

        {meldung && (
          <p className="gut" style={{ marginTop: "0.5rem" }}>
            {meldung.neu} neu eingetragen, {meldung.schonDa} waren schon da
            {meldung.unbekannt.length + meldung.mehrdeutig.length > 0 &&
              `, ${meldung.unbekannt.length + meldung.mehrdeutig.length} nicht zugeordnet`}
            .
          </p>
        )}
        {fehler && <p className="fehler" style={{ marginTop: "0.5rem" }}>{fehler}</p>}

        <button className="link" onClick={() => setOrdnerOffen((o) => !o)}>
          {ordnerOffen ? "Spielordner ausblenden" : `Spielordner: ${ordner || "automatisch suchen"}`}
        </button>
        {ordnerOffen && (
          <label className="leise" style={{ display: "block", marginTop: "0.5rem" }}>
            Ordner, in dem die Game.log liegt. Leer lassen, dann wird gesucht.
            <input
              value={ordner}
              onChange={(e) => ordnerSpeichern(e.target.value)}
              placeholder="C:\Program Files\Roberts Space Industries\StarCitizen\LIVE"
              className="eingabe"
            />
          </label>
        )}
      </div>

      {scan && scan.dateien.length === 0 && (
        <div className="panel warnung">
          {scan.ordner.length === 0
            ? "Keinen Star-Citizen-Ordner gefunden. Trag unter Spielordner den Ordner ein, in dem die Game.log liegt."
            : `In ${scan.ordner.join(", ")} liegt keine Game.log und kein logbackups-Ordner.`}
        </div>
      )}

      {scan && (scan.verdaechtig.length > 0 || probleme.size > 0 || dateiFehler.length > 0) && (
        <div className="panel">
          <p className="kicker warnung">Nicht sauber gelesen</p>
          {dateiFehler.map((d) => (
            <p key={d.pfad} className="warnung">
              {dateiname(d.pfad)}: {d.fehler}
            </p>
          ))}
          {probleme.size > 0 && (
            <p className="leise" style={{ marginTop: "0.5rem" }}>
              {probleme.size} Namen kennt CitizenHQ nicht eindeutig. Sie stehen in der Liste mit
              „nicht zugeordnet“. Hak sie auf der Webseite von Hand ab.
            </p>
          )}
          {scan.verdaechtig.length > 0 && (
            <>
              <p className="leise" style={{ marginTop: "0.5rem" }}>
                Diese Zeilen klingen nach Blaupause, wurden aber nicht erkannt. Schick sie uns,
                dann passen wir das an.
              </p>
              {scan.verdaechtig.map((z, i) => (
                <p key={i} className="mono zeile">{z}</p>
              ))}
            </>
          )}
        </div>
      )}

      {scan && scan.bauplaene.length > 0 && (
        <div className="panel">
          <div className="reihe" style={{ marginTop: 0, justifyContent: "space-between", alignItems: "baseline" }}>
            <p className="leise">
              {zahl(scan.fundeGesamt)} Meldungen in {zahl(scan.dateien.length)} Dateien, {zahl(zeilen)} Zeilen
            </p>
            <div className="umschalter">
              {(
                [
                  ["alle", "Alle"],
                  ["neu", "Nicht hochgeladen"],
                  ["problem", "Nicht zugeordnet"],
                ] as const
              ).map(([wert, text]) => (
                <button key={wert} aria-pressed={filter === wert} onClick={() => setFilter(wert)}>
                  {text}
                </button>
              ))}
            </div>
          </div>
          <ul className="liste">
            {liste.map((b) => {
              const st = status(b.name);
              return (
                <li key={b.name}>
                  <span>{b.name}</span>
                  <span className="leise mono" title={b.datei}>
                    {zeitText(b.zeit)}{" "}
                    <span className={"etikett " + st}>
                      {st === "da" ? "auf CitizenHQ" : st === "problem" ? "nicht zugeordnet" : "neu"}
                    </span>
                  </span>
                </li>
              );
            })}
            {liste.length === 0 && <li className="leise">Nichts in diesem Filter.</li>}
          </ul>
          <button className="link" onClick={() => setDateienOffen((o) => !o)}>
            {dateienOffen ? "Dateien ausblenden" : "Gelesene Dateien zeigen"}
          </button>
          {dateienOffen &&
            scan.dateien.map((d) => (
              <p key={d.pfad} className="leise mono zeile" title={d.pfad}>
                {dateiname(d.pfad)}: {zahl(d.zeilen)} Zeilen, {d.treffer} Treffer
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
