// Anmeldung gegen CitizenHQ (Device Authorization Flow).
//
// Der Ablauf steht in AGENTS.md und ist serverseitig fertig — hier wird er nur
// bedient. Wichtig und leicht zu übersehen: der Server nimmt ausschließlich
// application/json, form-urlencoded lehnt er mit 415 ab.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const BASIS = "https://citizenhq.space";
const CLIENT_ID = "citizenhq-desktop";

export interface GeraeteCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

async function post<T>(pfad: string, koerper: unknown): Promise<{ ok: boolean; status: number; daten: T }> {
  const antwort = await tauriFetch(`${BASIS}${pfad}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(koerper),
  });
  // Auch Fehler tragen einen Körper (error/error_description) — der wird gebraucht,
  // um authorization_pending von einem echten Abbruch zu unterscheiden.
  const daten = (await antwort.json().catch(() => ({}))) as T;
  return { ok: antwort.ok, status: antwort.status, daten };
}

/** Schritt 1: Code anfordern. */
export async function codeAnfordern(scope = "hangar"): Promise<GeraeteCode> {
  const { ok, daten } = await post<GeraeteCode & { message?: string }>("/api/auth/device/code", {
    client_id: CLIENT_ID,
    scope,
  });
  if (!ok || !daten.device_code) {
    throw new Error(daten.message ?? "Der Server hat keinen Code ausgegeben.");
  }
  return daten;
}

export type PollErgebnis =
  | { art: "wartet" }
  | { art: "langsamer" }
  | { art: "fertig"; token: string }
  | { art: "abbruch"; grund: string };

/** Schritt 3: einmal nach dem Token fragen. Der Aufrufer wiederholt das im Takt. */
export async function tokenHolen(deviceCode: string): Promise<PollErgebnis> {
  const { ok, daten } = await post<{
    access_token?: string;
    session?: { token?: string };
    token?: string;
    error?: string;
    error_description?: string;
  }>("/api/auth/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: CLIENT_ID,
  });

  if (ok) {
    const token = daten.access_token ?? daten.token ?? daten.session?.token;
    if (!token) return { art: "abbruch", grund: "Antwort ohne Token." };
    return { art: "fertig", token };
  }

  switch (daten.error) {
    case "authorization_pending":
      return { art: "wartet" };
    case "slow_down":
      return { art: "langsamer" };
    case "access_denied":
      return { art: "abbruch", grund: "Im Browser abgelehnt." };
    case "expired_token":
      return { art: "abbruch", grund: "Der Code ist abgelaufen. Bitte neu anmelden." };
    case "invalid_grant":
      // NICHT als "abgelaufen" ausgeben: invalid_grant kommt auch, wenn der Code schon
      // benutzt wurde oder nie existierte. Wer "abgelaufen" liest, wartet beim naechsten
      // Mal schneller — und sucht den Fehler an der falschen Stelle.
      return { art: "abbruch", grund: "Der Code wurde nicht angenommen (falsch, schon benutzt oder abgelaufen)." };
    default:
      return { art: "abbruch", grund: daten.error_description ?? daten.error ?? "Unbekannter Fehler." };
  }
}

/** Prüft das Token gegen die Sitzung — die einzige ehrliche Art zu sagen "angemeldet". */
export async function werBinIch(token: string): Promise<{ name: string; email?: string } | null> {
  try {
    const antwort = await tauriFetch(`${BASIS}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!antwort.ok) return null;
    const daten = (await antwort.json()) as { user?: { name?: string; email?: string } } | null;
    if (!daten?.user) return null;
    return { name: daten.user.name ?? "Pilot", email: daten.user.email };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- Rechte (#325)

export interface OrgaRechte {
  id: number;
  name: string;
  slug: string;
  rolle: string | null;
  rang: string | null;
  status: string | null;
  istEigentuemer: boolean;
  /** Beschriftet vom Server — der Client fuehrt keine eigene Liste mehr. Eine
   *  Liste, die hier gepflegt wird, zeigt nach jedem neuen Recht zu wenig an. */
  rechte: { key: string; text: string; gruppe: string }[];
}

export interface MeinStand {
  nutzer: { id: string; name?: string; email?: string; rolle: string };
  organisationen: OrgaRechte[];
}

/** Wer bin ich, und was darf ich?
 *
 *  Zur ANZEIGE. Der Client darf daraus nicht schliessen, dass eine Aktion gelingt —
 *  das entscheidet der Server bei der Aktion. Rechte, die hier zwischengespeichert
 *  wuerden, waeren beim naechsten Rollenwechsel falsch. */
export async function meinStand(token: string): Promise<MeinStand | null> {
  const antwort = await tauriFetch(`${BASIS}/api/client/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!antwort.ok) return null;
  return (await antwort.json()) as MeinStand;
}

/** Rechte nach Bereich gruppiert — in der Reihenfolge, in der sie ankommen. */
export function nachGruppe(
  rechte: { key: string; text: string; gruppe: string }[],
): [string, { key: string; text: string }[]][] {
  const karte = new Map<string, { key: string; text: string }[]>();
  for (const r of rechte) {
    const liste = karte.get(r.gruppe) ?? [];
    liste.push({ key: r.key, text: r.text });
    karte.set(r.gruppe, liste);
  }
  return [...karte.entries()];
}

// -------------------------------------------------------------- Hangar (#325)

export interface HangarSchiff {
  slug: string;
  name: string;
  hersteller: string | null;
  bild: string | null;
  anzahl: number;
  status: string;
  /** Beschriftung vom Server — der Client führt kein eigenes Vokabular. */
  statusText: string;
  notiz: string | null;
  /** ISO-Zeitstempel oder null; die Anzeige übersetzt in die lokale Zeit. */
  bis: string | null;
  freigegebenAn: { id: number; name: string }[];
}

export interface HangarStand {
  schiffe: HangarSchiff[];
  statusWerte: { key: string; text: string }[];
}

export interface SuchTreffer {
  slug: string;
  name: string;
  hersteller: string | null;
  bild: string | null;
}

/** Antwort auspacken und im Fehlerfall den GRUND werfen, nicht bloß "ging nicht".
 *  Der Server schickt zu jedem 4xx eine `error_description` in Klartext — die
 *  wegzuwerfen und "Fehler" anzuzeigen, macht aus einem lösbaren Problem
 *  ("Flotte voll") ein rätselhaftes. */
async function auspacken<T>(antwort: Response): Promise<T> {
  const daten = (await antwort.json().catch(() => ({}))) as T & {
    error_description?: string;
    error?: string;
  };
  if (!antwort.ok) {
    if (antwort.status === 401) throw new Error("ABGEMELDET");
    throw new Error(daten.error_description ?? daten.error ?? `Server meldet ${antwort.status}.`);
  }
  return daten;
}

export async function hangarLesen(token: string): Promise<HangarStand> {
  return auspacken<HangarStand>(
    await tauriFetch(`${BASIS}/api/client/hangar`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

/** Eine Änderung am Hangar. Der Server schickt den NEUEN Stand zurück — der
 *  Client rechnet sich nie selbst aus, was seine Änderung bewirkt hat. */
export async function hangarAendern(
  token: string,
  rumpf: { aktion: "hinzufuegen" | "entfernen" | "status"; slug: string; status?: string; notiz?: string; bis?: string },
): Promise<HangarSchiff[]> {
  const daten = await auspacken<{ schiffe: HangarSchiff[] }>(
    await tauriFetch(`${BASIS}/api/client/hangar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(rumpf),
    }),
  );
  return daten.schiffe;
}

export async function schiffeSuchen(token: string, q: string): Promise<SuchTreffer[]> {
  const daten = await auspacken<{ schiffe: SuchTreffer[] }>(
    await tauriFetch(`${BASIS}/api/client/schiffe?q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  return daten.schiffe;
}

// ----------------------------------------------------------- Blaupausen (#500)

export interface BauplanBesitz {
  uuid: string;
  name: string;
  quelle: "manual" | "log" | string;
  erhaltenAm: string | null;
}

export interface BauplanStand {
  gesamt: number;
  bauplaene: BauplanBesitz[];
}

/** Antwort auf eine Meldung. Die Namen, die der Server nicht zuordnen konnte, kommen
 *  zurueck, damit sie sichtbar werden statt still zu fehlen. */
export interface MeldeErgebnis {
  neu: number;
  schonDa: number;
  unbekannt: string[];
  mehrdeutig: string[];
}

export async function bauplaeneLesen(token: string): Promise<BauplanStand> {
  return auspacken<BauplanStand>(
    await tauriFetch(`${BASIS}/api/client/blaupausen`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

/** Schickt ALLE gefundenen Namen. Der Server schreibt nichts doppelt, der Client
 *  muss sich also nicht merken, was er schon geschickt hat. */
export async function bauplaeneMelden(
  token: string,
  bauplaene: { name: string; zeit: string | null }[],
): Promise<MeldeErgebnis> {
  return auspacken<MeldeErgebnis>(
    await tauriFetch(`${BASIS}/api/client/blaupausen`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ bauplaene }),
    }),
  );
}
