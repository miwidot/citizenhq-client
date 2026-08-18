// Der eigene Hangar im Client (#325 Stufe 2).
//
// Grundsatz für die ganze Ansicht: der Server ist die Wahrheit. Jede Änderung
// schickt der Client hin und übernimmt die Liste, die zurückkommt — er rechnet
// nie selbst aus, wie der Hangar nach seiner Änderung aussieht. Das kostet eine
// Antwort mehr und erspart die Klasse von Fehlern, bei denen die Anzeige etwas
// behauptet, das in der Datenbank nie passiert ist.
import { useEffect, useState } from "react";
import {
  hangarLesen,
  hangarAendern,
  schiffeSuchen,
  type HangarSchiff,
  type SuchTreffer,
} from "./hq";

type Zustand =
  | { art: "laedt" }
  | { art: "fehler"; text: string }
  | { art: "da"; schiffe: HangarSchiff[]; statusWerte: { key: string; text: string }[] };

export function Hangar({ token, aufAbmeldung }: { token: string; aufAbmeldung: () => void }) {
  const [zustand, setZustand] = useState<Zustand>({ art: "laedt" });
  const [beschaeftigt, setBeschaeftigt] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    hangarLesen(token)
      .then((s) => {
        if (!abgebrochen) setZustand({ art: "da", schiffe: s.schiffe, statusWerte: s.statusWerte });
      })
      .catch((e: Error) => {
        if (abgebrochen) return;
        // Ein abgelaufenes oder entzogenes Token ist kein Anzeigefehler, sondern
        // das Ende der Sitzung — dann gehört der Nutzer zurück zur Anmeldung,
        // nicht vor eine Fehlermeldung, die er nicht beheben kann.
        if (e.message === "ABGEMELDET") aufAbmeldung();
        else setZustand({ art: "fehler", text: e.message });
      });
    return () => {
      abgebrochen = true;
    };
  }, [token, aufAbmeldung]);

  async function aendern(
    rumpf: Parameters<typeof hangarAendern>[1],
    schluessel: string,
  ): Promise<void> {
    setBeschaeftigt(schluessel);
    setMeldung(null);
    try {
      const schiffe = await hangarAendern(token, rumpf);
      setZustand((z) => (z.art === "da" ? { ...z, schiffe } : z));
    } catch (e) {
      const text = (e as Error).message;
      if (text === "ABGEMELDET") aufAbmeldung();
      else setMeldung(text);
    } finally {
      setBeschaeftigt(null);
    }
  }

  if (zustand.art === "laedt") {
    return (
      <div className="panel">
        <p className="kicker">▸ Hangar</p>
        <p className="leise" style={{ marginTop: "0.75rem" }}>Wird geladen …</p>
      </div>
    );
  }

  if (zustand.art === "fehler") {
    return (
      <div className="panel">
        <p className="kicker fehler">▸ Hangar</p>
        <p className="weich" style={{ marginTop: "0.5rem" }}>{zustand.text}</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <p className="kicker">▸ Dein Hangar</p>
      <p className="leise mono" style={{ fontSize: "0.68rem", marginTop: "0.35rem" }}>
        {zustand.schiffe.length === 0
          ? "noch leer"
          : `${zustand.schiffe.reduce((n, s) => n + s.anzahl, 0)} Schiffe`}
      </p>

      <SchiffSuche
        token={token}
        vorhanden={zustand.schiffe.map((s) => s.slug)}
        beschaeftigt={beschaeftigt}
        aufWahl={(slug) => aendern({ aktion: "hinzufuegen", slug }, `add:${slug}`)}
        aufAbmeldung={aufAbmeldung}
      />

      {meldung && (
        <p className="warnung mono" style={{ fontSize: "0.72rem", marginTop: "0.75rem" }}>
          {meldung}
        </p>
      )}

      {zustand.schiffe.map((s) => (
        <SchiffZeile
          key={s.slug}
          schiff={s}
          statusWerte={zustand.statusWerte}
          beschaeftigt={beschaeftigt}
          aufAendern={aendern}
        />
      ))}

      <p className="leise" style={{ marginTop: "1.25rem" }}>
        Änderungen hier sind dieselben wie auf der Webseite — derselbe Hangar, dasselbe
        Protokoll. Im Protokoll steht „Desktop-Client", damit du später erkennst, wo eine
        Änderung herkam.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ Ein Schiff

function SchiffZeile({
  schiff,
  statusWerte,
  beschaeftigt,
  aufAendern,
}: {
  schiff: HangarSchiff;
  statusWerte: { key: string; text: string }[];
  beschaeftigt: string | null;
  aufAendern: (rumpf: Parameters<typeof hangarAendern>[1], schluessel: string) => Promise<void>;
}) {
  const [offen, setOffen] = useState(false);
  const [notiz, setNotiz] = useState(schiff.notiz ?? "");
  const laeuft = beschaeftigt?.endsWith(schiff.slug) ?? false;

  return (
    <div
      style={{
        marginTop: "0.9rem",
        paddingTop: "0.9rem",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        opacity: laeuft ? 0.5 : 1,
      }}
    >
      <div className="reihe" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <p style={{ fontSize: "1.02rem" }}>
          {schiff.name}
          {schiff.anzahl > 1 && <span className="leise"> ×{schiff.anzahl}</span>}{" "}
          <span className="leise">{schiff.hersteller ?? ""}</span>
        </p>
        <button className="stumm" onClick={() => setOffen((o) => !o)} disabled={laeuft}>
          {offen ? "Zu" : "Ändern"}
        </button>
      </div>

      <p className="leise mono" style={{ fontSize: "0.7rem" }}>
        {schiff.statusText}
        {schiff.notiz ? ` · ${schiff.notiz}` : ""}
        {schiff.bis ? ` · bis ${new Date(schiff.bis).toLocaleDateString()}` : ""}
      </p>

      {schiff.freigegebenAn.length > 0 && (
        <p className="leise mono" style={{ fontSize: "0.66rem", opacity: 0.7 }}>
          sichtbar für {schiff.freigegebenAn.map((o) => o.name).join(", ")}
        </p>
      )}

      {offen && (
        <div style={{ marginTop: "0.6rem" }}>
          {schiff.anzahl > 1 && (
            <p className="warnung mono" style={{ fontSize: "0.66rem", marginBottom: "0.4rem" }}>
              Du hast {schiff.anzahl} davon — der Status gilt für alle.
            </p>
          )}
          <div className="reihe" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
            {statusWerte.map((w) => (
              <button
                key={w.key}
                className={w.key === schiff.status ? "" : "stumm"}
                disabled={laeuft}
                onClick={() =>
                  aufAendern(
                    { aktion: "status", slug: schiff.slug, status: w.key, notiz, bis: schiff.bis ?? "" },
                    `status:${schiff.slug}`,
                  )
                }
              >
                {w.text}
              </button>
            ))}
          </div>
          <input
            value={notiz}
            maxLength={191}
            placeholder="Notiz, z. B. verliehen an …"
            onChange={(e) => setNotiz(e.target.value)}
            style={{ marginTop: "0.5rem", width: "100%" }}
          />
          <div className="reihe" style={{ marginTop: "0.5rem" }}>
            <button
              className="stumm"
              disabled={laeuft || notiz === (schiff.notiz ?? "")}
              onClick={() =>
                aufAendern(
                  { aktion: "status", slug: schiff.slug, status: schiff.status, notiz, bis: schiff.bis ?? "" },
                  `status:${schiff.slug}`,
                )
              }
            >
              Notiz speichern
            </button>
            <button
              className="stumm"
              disabled={laeuft}
              // Zweistufig statt Rückfrage-Dialog: ein systemeigener confirm()
              // blockiert im WebView alles Weitere, und ein aus Versehen
              // entferntes Schiff ist über die Webseite ohnehin wiederherstellbar
              // (die Orga-Freigaben bleiben erhalten).
              onClick={() => aufAendern({ aktion: "entfernen", slug: schiff.slug }, `del:${schiff.slug}`)}
            >
              Aus dem Hangar nehmen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- Suche

function SchiffSuche({
  token,
  vorhanden,
  beschaeftigt,
  aufWahl,
  aufAbmeldung,
}: {
  token: string;
  vorhanden: string[];
  beschaeftigt: string | null;
  aufWahl: (slug: string) => void;
  aufAbmeldung: () => void;
}) {
  const [q, setQ] = useState("");
  const [treffer, setTreffer] = useState<SuchTreffer[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setTreffer([]);
      return;
    }
    // Kurz warten statt bei jedem Tastendruck zu fragen: sonst schickt ein
    // getippter Schiffsname zehn Abfragen los, von denen neun schon veraltet
    // sind, wenn sie ankommen.
    let abgebrochen = false;
    const t = setTimeout(() => {
      schiffeSuchen(token, q.trim())
        .then((r) => !abgebrochen && setTreffer(r))
        .catch((e: Error) => {
          if (abgebrochen) return;
          if (e.message === "ABGEMELDET") aufAbmeldung();
          else setTreffer([]);
        });
    }, 250);
    return () => {
      abgebrochen = true;
      clearTimeout(t);
    };
  }, [q, token, aufAbmeldung]);

  return (
    <div style={{ marginTop: "0.9rem" }}>
      <input
        value={q}
        placeholder="Schiff suchen und hinzufügen …"
        onChange={(e) => setQ(e.target.value)}
        style={{ width: "100%" }}
      />
      {treffer.length > 0 && (
        <ul style={{ margin: "0.4rem 0 0", paddingLeft: 0, listStyle: "none" }}>
          {treffer.map((t) => {
            const schonDa = vorhanden.includes(t.slug);
            return (
              <li key={t.slug} className="reihe" style={{ justifyContent: "space-between", padding: "0.2rem 0" }}>
                <span className="leise">
                  {t.name} <span style={{ opacity: 0.6 }}>{t.hersteller ?? ""}</span>
                </span>
                <button
                  className="stumm"
                  disabled={schonDa || beschaeftigt === `add:${t.slug}`}
                  onClick={() => {
                    aufWahl(t.slug);
                    setQ("");
                  }}
                >
                  {schonDa ? "schon da" : "+ Hangar"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
