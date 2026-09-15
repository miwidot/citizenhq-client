// Blaupausen aus der Game.log (scverse #501), erste Stufe: nur lesen und anzeigen.
//
// Hochgeladen wird hier noch NICHTS. Das kommt mit /api/client/blaupausen (#500) und
// dann nur mit sichtbarem Schalter. Diese Ansicht ist zum Pruefen, ob der Parser die
// eigenen Logs sauber liest, und funktioniert deshalb auch ohne Anmeldung.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Treffer = { name: string; sprache: "de" | "en"; zeit: string | null; datei: string };
type DateiStand = { pfad: string; zeilen: number; treffer: number; fehler: string | null };
type ScanErgebnis = {
  ordner: string[];
  dateien: DateiStand[];
  bauplaene: Treffer[];
  fundeGesamt: number;
  verdaechtig: string[];
};

const zahl = (n: number) => new Intl.NumberFormat("de-DE").format(n);

function dateiname(pfad: string) {
  return pfad.split(/[\\/]/).pop() ?? pfad;
}

export function Bauplaene() {
  const [ordner, setOrdner] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<ScanErgebnis | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [dateienOffen, setDateienOffen] = useState(false);

  const scannen = async () => {
    setLaeuft(true);
    setFehler(null);
    try {
      setErgebnis(await invoke<ScanErgebnis>("bauplaene_scannen", { ordner: ordner.trim() || null }));
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft(false);
    }
  };

  const zeilenGesamt = ergebnis?.dateien.reduce((s, d) => s + d.zeilen, 0) ?? 0;
  const dateiFehler = ergebnis?.dateien.filter((d) => d.fehler) ?? [];

  return (
    <div className="panel">
      <p className="kicker">▸ Blaupausen aus der Game.log</p>
      <p className="leise" style={{ marginTop: "0.5rem" }}>
        Liest deine Game.log und die alten Logs in logbackups und zeigt, welche Blaupausen
        darin stehen. Es wird noch nichts hochgeladen.
      </p>

      <label className="leise" style={{ display: "block", marginTop: "1rem" }}>
        Spielordner (leer lassen, dann wird gesucht)
        <input
          value={ordner}
          onChange={(e) => setOrdner(e.target.value)}
          placeholder="C:\Program Files\Roberts Space Industries\StarCitizen\LIVE"
          className="eingabe"
        />
      </label>

      <div className="reihe">
        <button onClick={scannen} disabled={laeuft}>
          {laeuft ? "Lese Logs …" : ergebnis ? "Neu einlesen" : "Logs einlesen"}
        </button>
      </div>

      {fehler && <p className="warnung" style={{ marginTop: "1rem" }}>{fehler}</p>}

      {ergebnis && ergebnis.dateien.length === 0 && (
        <p className="warnung" style={{ marginTop: "1rem" }}>
          {ergebnis.ordner.length === 0
            ? "Keinen Star-Citizen-Ordner gefunden. Trag oben den Ordner ein, in dem die Game.log liegt."
            : `In ${ergebnis.ordner.join(", ")} liegt keine Game.log und kein logbackups-Ordner.`}
        </p>
      )}

      {ergebnis && ergebnis.dateien.length > 0 && (
        <>
          <p style={{ marginTop: "1.25rem", fontSize: "1.4rem" }}>
            {zahl(ergebnis.bauplaene.length)} Blaupausen
          </p>
          <p className="leise">
            {zahl(ergebnis.fundeGesamt)} Meldungen in {zahl(ergebnis.dateien.length)} Dateien,{" "}
            {zahl(zeilenGesamt)} Zeilen gelesen
          </p>
          <p className="leise mono" style={{ fontSize: "0.68rem", marginTop: "0.25rem" }}>
            {ergebnis.ordner.join(" | ")}
          </p>

          {dateiFehler.length > 0 && (
            <div className="warnung" style={{ marginTop: "0.75rem" }}>
              {dateiFehler.map((d) => (
                <p key={d.pfad}>
                  {dateiname(d.pfad)}: {d.fehler}
                </p>
              ))}
            </div>
          )}

          {ergebnis.verdaechtig.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <p className="kicker" style={{ color: "var(--amber)" }}>
                ▸ Nicht erkannt ({ergebnis.verdaechtig.length})
              </p>
              <p className="leise">
                Diese Zeilen klingen nach Blaupause, der Parser hat sie aber nicht gelesen.
                Schick sie uns, dann passen wir ihn an.
              </p>
              {ergebnis.verdaechtig.map((z, i) => (
                <p key={i} className="mono zeile">{z}</p>
              ))}
            </div>
          )}

          <ul className="liste">
            {ergebnis.bauplaene.map((b) => (
              <li key={b.name}>
                <span>{b.name}</span>
                <span className="leise mono" title={b.datei}>
                  {b.sprache.toUpperCase()} {b.zeit ? b.zeit.slice(0, 16).replace("T", " ") : ""}
                </span>
              </li>
            ))}
          </ul>

          <div className="reihe">
            <button className="stumm" onClick={() => setDateienOffen((o) => !o)}>
              {dateienOffen ? "Dateien ausblenden" : "Gelesene Dateien zeigen"}
            </button>
          </div>
          {dateienOffen &&
            ergebnis.dateien.map((d) => (
              <p key={d.pfad} className="leise mono zeile" title={d.pfad}>
                {dateiname(d.pfad)}: {zahl(d.zeilen)} Zeilen, {d.treffer} Treffer
              </p>
            ))}
        </>
      )}
    </div>
  );
}
