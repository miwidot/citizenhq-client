// Lokaler Bestand: welche Blaupausen die App schon gefunden und hochgeladen hat.
//
// Warum eine eigene Datei und nicht nur die Logs: Star Citizen loescht alte Logs aus
// logbackups. Was einmal gefunden wurde, darf dadurch nicht verschwinden. Und der
// Upload schickt nur, was noch nicht erfolgreich oben ist.
//
// Liegt im App-Datenordner (Windows: %APPDATA%\space.citizenhq.client\bauplaene.json),
// menschenlesbar, damit man sie sichern und reinschauen kann.
//
// Schreiben geht ueber eine Temp-Datei + Umbenennen: ein Absturz mitten im Schreiben
// darf die Datei nicht halb leer zuruecklassen. Ist die Datei trotzdem kaputt, wird
// sie beiseite gelegt (nicht ueberschrieben) und das gemeldet.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const DATEI: &str = "bauplaene.json";
const FORMAT: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Eintrag {
    /// Frueheste Zeit aus der Log (ISO, UTC), falls bekannt.
    pub zeit: Option<String>,
    pub sprache: Option<String>,
    /// Wann die App den Eintrag zuerst gesehen hat.
    pub gefunden: String,
    /// Wann er erfolgreich hochgeladen wurde; None = noch offen.
    pub hochgeladen: Option<String>,
    /// Antwort des Servers: "ok", "unbekannt", "mehrdeutig"; None = noch nie geschickt.
    pub status: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bestand {
    pub format: u32,
    /// Mit welcher Fassung der Erkennung die Namen hier gelesen wurden
    /// (logparser::PARSER_VERSION). 0 = eine Fassung vor dieser Zaehlung.
    #[serde(default)]
    pub parser_version: u32,
    pub bauplaene: BTreeMap<String, Eintrag>,
    /// Was je Log-Datei schon gelesen ist, damit der naechste Scan nur Neues liest.
    #[serde(default)]
    pub dateien: BTreeMap<String, crate::logscan::DateiMerker>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestandAntwort {
    pub pfad: String,
    pub bestand: Bestand,
    /// Nur nach einem Scan gesetzt.
    pub scan: Option<crate::logscan::ScanErgebnis>,
    /// Gesetzt, wenn eine kaputte Datei beiseite gelegt wurde.
    pub warnung: Option<String>,
}

#[derive(Deserialize)]
pub struct Fund {
    pub name: String,
    pub zeit: Option<String>,
    pub sprache: Option<String>,
}

#[derive(Deserialize)]
pub struct Rueckmeldung {
    pub name: String,
    pub status: String,
}

pub fn lesen(pfad: &Path) -> (Bestand, Option<String>) {
    let text = match fs::read_to_string(pfad) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (Bestand { format: FORMAT, parser_version: crate::logparser::PARSER_VERSION, ..Default::default() }, None)
        }
        Err(e) => return (Bestand { format: FORMAT, ..Default::default() }, Some(format!("{} nicht lesbar: {e}", pfad.display()))),
    };
    match serde_json::from_str::<Bestand>(&text) {
        Ok(b) => (b, None),
        Err(e) => {
            let beiseite = pfad.with_extension(format!("kaputt-{}.json", std::process::id()));
            let verschoben = fs::rename(pfad, &beiseite).is_ok();
            (
                Bestand { format: FORMAT, ..Default::default() },
                Some(format!(
                    "{} war beschaedigt ({e}). {}",
                    pfad.display(),
                    if verschoben {
                        format!("Gesichert als {}, neu angefangen.", beiseite.display())
                    } else {
                        "Konnte nicht beiseite gelegt werden.".into()
                    }
                )),
            )
        }
    }
}

pub fn schreiben(pfad: &Path, b: &Bestand) -> Result<(), String> {
    if let Some(ordner) = pfad.parent() {
        fs::create_dir_all(ordner).map_err(|e| format!("Ordner {} anlegen: {e}", ordner.display()))?;
    }
    let tmp = pfad.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(b).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| format!("{} schreiben: {e}", tmp.display()))?;
    fs::rename(&tmp, pfad).map_err(|e| format!("{} ersetzen: {e}", pfad.display()))
}

/// Neue Funde aufnehmen. Bestehende Eintraege behalten Upload-Stand; die Log-Zeit wird
/// nur frueher, nie spaeter.
pub fn funde_merken(b: &mut Bestand, funde: Vec<Fund>, jetzt: &str) {
    b.format = FORMAT;
    for f in funde {
        let name = f.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        match b.bauplaene.get_mut(&name) {
            Some(e) => {
                if let Some(z) = f.zeit {
                    if e.zeit.as_ref().map_or(true, |alt| &z < alt) {
                        e.zeit = Some(z);
                    }
                }
                if e.sprache.is_none() {
                    e.sprache = f.sprache;
                }
            }
            None => {
                b.bauplaene.insert(
                    name,
                    Eintrag { zeit: f.zeit, sprache: f.sprache, gefunden: jetzt.into(), hochgeladen: None, status: None },
                );
            }
        }
    }
}

/// Antwort des Servers eintragen. "ok" gilt als hochgeladen; unbekannt/mehrdeutig
/// bleiben offen, damit sie nach einer Server-Korrektur erneut geschickt werden.
pub fn rueckmeldung_merken(b: &mut Bestand, r: Vec<Rueckmeldung>, jetzt: &str) {
    for m in r {
        if let Some(e) = b.bauplaene.get_mut(m.name.trim()) {
            e.hochgeladen = (m.status == "ok").then(|| jetzt.to_string()).or(e.hochgeladen.take());
            e.status = Some(m.status);
        }
    }
}

/// Nach einer Verbesserung der Erkennung aufraeumen.
///
/// WARUM DAS NOETIG IST: die App merkt sich, wie weit jede Log gelesen ist. Ohne
/// diesen Schritt bliebe ein mit einer kaputten Fassung gelesener Name fuer immer
/// stehen — die Datei gilt als gelesen, also wird sie nie wieder angefasst.
///
/// Was passiert: die Lesestellen fallen weg (alle Logs werden neu gelesen), und
/// Eintraege, die der Server NICHT sauber zuordnen konnte, fliegen raus. Genau das
/// sind die Verstuemmelten ("R97" statt `R97 "Kismet" Shotgun`) — ein abgeschnittener
/// Name trifft keine Blaupause. Eintraege mit Status "ok" bleiben: sie sind zugeordnet,
/// und wer sie loeschte, wuerde sie beim naechsten Hochladen erneut melden.
///
/// Was es NICHT tut: die Datei loeschen. Wer seine alten Logs nicht mehr hat, wuerde
/// damit seinen ganzen Stand verlieren.
pub fn auf_parser_version_heben(b: &mut Bestand, version: u32) -> Option<String> {
    if b.parser_version >= version {
        return None;
    }
    let vorher = b.bauplaene.len();
    b.bauplaene.retain(|_, e| e.status.as_deref() == Some("ok"));
    let verworfen = vorher - b.bauplaene.len();
    let dateien = b.dateien.len();
    b.dateien.clear();
    let alt = b.parser_version;
    b.parser_version = version;
    Some(format!(
        "Erkennung verbessert (Fassung {alt} -> {version}): {dateien} Log-Datei(en) werden neu \
         gelesen, {verworfen} nicht zugeordnete(r) Eintrag/Eintraege verworfen."
    ))
}

pub fn pfad_in(ordner: PathBuf) -> PathBuf {
    ordner.join(DATEI)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fund(name: &str, zeit: Option<&str>) -> Fund {
        Fund { name: name.into(), zeit: zeit.map(Into::into), sprache: Some("de".into()) }
    }

    #[test]
    fn merken_hochladen_und_wieder_lesen() {
        let dir = std::env::temp_dir().join(format!("chq-bestand-{}", std::process::id()));
        let pfad = pfad_in(dir.clone());
        let (mut b, w) = lesen(&pfad);
        assert!(w.is_none() && b.bauplaene.is_empty());

        funde_merken(&mut b, vec![fund("Arrow", Some("2026-09-10T10:00:00Z")), fund("Foo", None)], "T1");
        // spaeterer Fund aendert die Zeit nicht, frueherer schon
        funde_merken(&mut b, vec![fund("Arrow", Some("2026-09-12T10:00:00Z"))], "T2");
        funde_merken(&mut b, vec![fund("Arrow", Some("2026-09-01T10:00:00Z"))], "T3");
        assert_eq!(b.bauplaene["Arrow"].zeit.as_deref(), Some("2026-09-01T10:00:00Z"));
        assert_eq!(b.bauplaene["Arrow"].gefunden, "T1");

        rueckmeldung_merken(
            &mut b,
            vec![
                Rueckmeldung { name: "Arrow".into(), status: "ok".into() },
                Rueckmeldung { name: "Foo".into(), status: "unbekannt".into() },
            ],
            "T4",
        );
        schreiben(&pfad, &b).unwrap();
        let (b2, _) = lesen(&pfad);
        assert_eq!(b2.bauplaene["Arrow"].hochgeladen.as_deref(), Some("T4"));
        assert_eq!(b2.bauplaene["Foo"].hochgeladen, None);
        assert_eq!(b2.bauplaene["Foo"].status.as_deref(), Some("unbekannt"));

        // neuer Scan setzt einen hochgeladenen Eintrag nicht zurueck
        let mut b3 = b2.clone();
        funde_merken(&mut b3, vec![fund("Arrow", None)], "T5");
        assert_eq!(b3.bauplaene["Arrow"].hochgeladen.as_deref(), Some("T4"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn neue_parser_version_raeumt_auf() {
        let mut b = Bestand { format: FORMAT, parser_version: 1, ..Default::default() };
        funde_merken(&mut b, vec![fund("R97", None), fund("Arrow", None)], "T1");
        rueckmeldung_merken(
            &mut b,
            vec![
                Rueckmeldung { name: "R97".into(), status: "unbekannt".into() },
                Rueckmeldung { name: "Arrow".into(), status: "ok".into() },
            ],
            "T2",
        );
        b.dateien.insert("Game.log".into(), Default::default());

        let text = auf_parser_version_heben(&mut b, 2).expect("Aufraeumen erwartet");
        assert!(text.contains("1 -> 2"), "{text}");
        // Der verstuemmelte Name ist weg, der zugeordnete bleibt.
        assert!(!b.bauplaene.contains_key("R97"));
        assert!(b.bauplaene.contains_key("Arrow"));
        // Lesestellen weg: alle Logs werden neu gelesen.
        assert!(b.dateien.is_empty());
        assert_eq!(b.parser_version, 2);
        // Zweiter Aufruf macht nichts mehr.
        assert!(auf_parser_version_heben(&mut b, 2).is_none());
    }

    #[test]
    fn kaputte_datei_wird_beiseite_gelegt() {
        let dir = std::env::temp_dir().join(format!("chq-bestand-kaputt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pfad = pfad_in(dir.clone());
        fs::write(&pfad, "{ halb").unwrap();
        let (b, w) = lesen(&pfad);
        assert!(b.bauplaene.is_empty());
        assert!(w.unwrap().contains("beschaedigt"));
        assert!(!pfad.exists(), "kaputte Datei darf nicht liegen bleiben und ueberschrieben werden");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).ok();
    }
}
