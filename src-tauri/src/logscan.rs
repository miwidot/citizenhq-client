// Sucht die Game.log-Dateien von Star Citizen und liest daraus die erhaltenen Bauplaene
// (scverse #501). Nur lesen, nichts hochladen: das kommt mit der Client-API (#500).
//
// Gelesen werden Game.log UND logbackups/*.log. Das Spiel verschiebt die Log beim
// naechsten Start nach logbackups; wer nur Game.log liest, sieht nur die letzte Sitzung.
//
// Zum Pruefen, ob der Parser sauber trifft, sammelt der Scan zusaetzlich "verdaechtige"
// Zeilen: Hinweise, die nach Bauplan klingen, die der Parser aber NICHT erkannt hat.
// Tauchen dort welche auf, stimmt der erkannte Text nicht (andere Sprache, neues Format).
use crate::logparser::{BauplanParser, Sprache};
use serde::Serialize;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Wie viele verdaechtige Zeilen hoechstens zurueckkommen. Es geht um Beispiele,
/// nicht um eine vollstaendige Liste.
const MAX_VERDAECHTIG: usize = 20;

const KANAELE: [&str; 5] = ["LIVE", "PTU", "EPTU", "HOTFIX", "TECH-PREVIEW"];

/// Was von einer Datei schon gelesen wurde. Damit ein neuer Scan nur liest, was neu ist:
/// Backup-Logs aendern sich nie mehr und werden uebersprungen, die laufende Game.log
/// wird ab `gelesen` weitergelesen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DateiMerker {
    pub groesse: u64,
    pub geaendert_ms: u64,
    /// Bis zu diesem Byte gelesen (immer an einem Zeilenende).
    pub gelesen: u64,
    /// Die ersten Bytes der Datei. Startet das Spiel neu, entsteht eine NEUE Game.log
    /// unter demselben Namen; waechst sie ueber die alte Lesestelle hinaus, sagt die
    /// Groesse allein das nicht. Die erste Zeile (mit Startzeit) schon.
    #[serde(default)]
    pub kopf: String,
}

const KOPF_BYTES: usize = 256;

fn kopf_lesen(pfad: &Path) -> String {
    use std::io::Read;
    let mut puffer = vec![0u8; KOPF_BYTES];
    let n = File::open(pfad).and_then(|mut f| f.read(&mut puffer)).unwrap_or(0);
    String::from_utf8_lossy(&puffer[..n]).into_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Treffer {
    pub name: String,
    pub sprache: &'static str,
    /// Zeitstempel aus der Zeile, so wie das Spiel ihn schreibt (UTC, ISO).
    pub zeit: Option<String>,
    pub datei: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateiStand {
    pub pfad: String,
    pub zeilen: usize,
    pub treffer: usize,
    pub fehler: Option<String>,
    /// unveraendert (uebersprungen), weiter (ab letzter Stelle), neu (von vorn)
    pub art: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanErgebnis {
    pub ordner: Vec<String>,
    pub dateien: Vec<DateiStand>,
    /// Jeder Bauplan einmal, mit dem fruehesten Fund.
    pub bauplaene: Vec<Treffer>,
    /// Alle Funde, auch mehrfache (derselbe Bauplan in mehreren Sitzungen).
    pub funde_gesamt: usize,
    pub verdaechtig: Vec<String>,
    /// Stand je Datei nach diesem Scan, zum Speichern fuer den naechsten.
    #[serde(skip)]
    pub merker: BTreeMap<String, DateiMerker>,
}

/// Kandidaten fuer den Spielordner (der Ordner, in dem Game.log liegt).
fn standard_ordner() -> Vec<PathBuf> {
    let mut basen: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    for lw in b'C'..=b'Z' {
        let lw = lw as char;
        for rest in [
            r"Program Files\Roberts Space Industries\StarCitizen",
            r"Roberts Space Industries\StarCitizen",
            r"Games\Roberts Space Industries\StarCitizen",
            r"StarCitizen",
        ] {
            basen.push(PathBuf::from(format!(r"{lw}:\{rest}")));
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // Linux: Wine-/Proton-Praefixe der ueblichen Installer (LUG-Helper, Lutris).
        for praefix in [
            "Games/star-citizen",
            ".wine",
            "Games/lutris/star-citizen",
        ] {
            basen.push(
                home.join(praefix)
                    .join("drive_c/Program Files/Roberts Space Industries/StarCitizen"),
            );
        }
    }
    basen
        .into_iter()
        .flat_map(|b| KANAELE.iter().map(move |k| b.join(k)))
        .filter(|p| p.join("Game.log").is_file() || p.join("logbackups").is_dir())
        .collect()
}

fn log_dateien(ordner: &Path) -> Vec<PathBuf> {
    let mut dateien = Vec::new();
    if let Ok(eintraege) = std::fs::read_dir(ordner.join("logbackups")) {
        let mut backups: Vec<PathBuf> = eintraege
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("log")))
            .collect();
        // Die Dateinamen enthalten Datum und Uhrzeit; sortiert ergibt das die Reihenfolge.
        backups.sort();
        dateien.extend(backups);
    }
    let aktuell = ordner.join("Game.log");
    if aktuell.is_file() {
        dateien.push(aktuell);
    }
    dateien
}

/// `<2026-09-15T12:00:00.000Z> ...` -> `2026-09-15T12:00:00.000Z`
fn zeitstempel(zeile: &str) -> Option<String> {
    let rest = zeile.strip_prefix('<')?;
    let ende = rest.find('>')?;
    let t = &rest[..ende];
    (t.len() >= 19 && t.as_bytes()[4] == b'-').then(|| t.to_string())
}

fn klingt_nach_bauplan(zeile: &str) -> bool {
    zeile.contains("Added notification")
        && (zeile.contains("Bauplan") || zeile.to_ascii_lowercase().contains("blueprint"))
}

pub fn scannen(eigener_ordner: Option<String>, bekannt: &BTreeMap<String, DateiMerker>) -> ScanErgebnis {
    let ordner: Vec<PathBuf> = match eigener_ordner.map(|s| s.trim().to_string()) {
        Some(s) if !s.is_empty() => {
            let p = PathBuf::from(&s);
            // Auch die Game.log selbst darf angegeben werden, dann zaehlt ihr Ordner.
            let p = if p.is_file() { p.parent().map(Path::to_path_buf).unwrap_or(p) } else { p };
            vec![p]
        }
        _ => standard_ordner(),
    };

    let mut dateien = Vec::new();
    let mut erste: BTreeMap<String, Treffer> = BTreeMap::new();
    let mut funde_gesamt = 0;
    let mut verdaechtig = Vec::new();
    let mut merker = BTreeMap::new();

    for o in &ordner {
        for pfad in log_dateien(o) {
            let anzeige = pfad.display().to_string();
            let meta = std::fs::metadata(&pfad).ok();
            let groesse = meta.as_ref().map_or(0, |m| m.len());
            let geaendert_ms = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            let alt = bekannt.get(&anzeige);
            let kopf = kopf_lesen(&pfad);

            // Unveraendert: ueberspringen. Gewachsen: ab der letzten Stelle weiter.
            // Kleiner geworden: neue Datei unter altem Namen (neue Sitzung), von vorn.
            let (start, art) = match alt {
                Some(a) if a.kopf == kopf && a.groesse == groesse && a.geaendert_ms == geaendert_ms && a.gelesen == groesse => {
                    merker.insert(anzeige.clone(), a.clone());
                    dateien.push(DateiStand { pfad: anzeige, zeilen: 0, treffer: 0, fehler: None, art: "unveraendert" });
                    continue;
                }
                // Anfang gleich und nicht geschrumpft: dieselbe Datei, gewachsen. Die
                // ersten 256 Bytes muessen dafuer schon vollstaendig gelesen sein.
                Some(a) if a.kopf == kopf && groesse >= a.gelesen && a.gelesen as usize >= KOPF_BYTES => (a.gelesen, "weiter"),
                _ => (0, "neu"),
            };
            let mut stand = DateiStand { pfad: anzeige.clone(), zeilen: 0, treffer: 0, fehler: None, art };
            let mut datei = match File::open(&pfad) {
                Ok(f) => f,
                Err(e) => {
                    stand.fehler = Some(e.to_string());
                    dateien.push(stand);
                    continue;
                }
            };
            if start > 0 {
                if let Err(e) = datei.seek(SeekFrom::Start(start)) {
                    stand.fehler = Some(format!("Springen an Byte {start}: {e}"));
                    dateien.push(stand);
                    continue;
                }
            }
            let mut gelesen = start;
            // Neuer Parser je Datei: die Wiederholungs-Sperre gilt innerhalb einer Sitzung.
            let mut parser = BauplanParser::default();
            let mut leser = BufReader::new(datei);
            let mut puffer = Vec::new();
            loop {
                puffer.clear();
                match leser.read_until(b'\n', &mut puffer) {
                    Ok(0) => break,
                    // Halbe letzte Zeile (das Spiel schreibt gerade): nicht zaehlen, beim
                    // naechsten Mal ab ihrem Anfang neu lesen.
                    Ok(_) if puffer.last() != Some(&b'\n') => break,
                    Ok(n) => gelesen += n as u64,
                    Err(e) => {
                        stand.fehler = Some(format!("abgebrochen nach Zeile {}: {e}", stand.zeilen));
                        break;
                    }
                }
                stand.zeilen += 1;
                // Die Log ist nicht garantiert sauberes UTF-8; kaputte Bytes duerfen die
                // Zeile nicht verwerfen.
                let zeile = String::from_utf8_lossy(&puffer);
                if !klingt_nach_bauplan(&zeile) {
                    continue;
                }
                match parser.zeile(&zeile) {
                    Some(b) => {
                        stand.treffer += 1;
                        funde_gesamt += 1;
                        let zeit = zeitstempel(&zeile);
                        erste.entry(b.name.clone()).or_insert(Treffer {
                            name: b.name,
                            sprache: match b.sprache {
                                Sprache::De => "de",
                                Sprache::En => "en",
                            },
                            zeit,
                            datei: anzeige.clone(),
                        });
                    }
                    None => {
                        // Unmittelbare Wiederholungen liefern auch None, sind aber kein
                        // Problem. Nur Zeilen, die der Parser grundsaetzlich nicht erkennt.
                        if crate::logparser::bauplan_aus_zeile(&zeile).is_none()
                            && verdaechtig.len() < MAX_VERDAECHTIG
                        {
                            verdaechtig.push(zeile.trim().to_string());
                        }
                    }
                }
            }
            if stand.fehler.is_none() {
                merker.insert(anzeige, DateiMerker { groesse, geaendert_ms, gelesen, kopf });
            }
            dateien.push(stand);
        }
    }

    let mut bauplaene: Vec<Treffer> = erste.into_values().collect();
    bauplaene.sort_by(|a, b| a.zeit.cmp(&b.zeit));

    ScanErgebnis {
        ordner: ordner.iter().map(|p| p.display().to_string()).collect(),
        dateien,
        bauplaene,
        funde_gesamt,
        verdaechtig,
        merker,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liest_game_log_und_backups() {
        let dir = std::env::temp_dir().join(format!("chq-logscan-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("logbackups")).unwrap();
        std::fs::write(
            dir.join("logbackups/Game Build(1) 01 Sep 26 (10 00 00).log"),
            "<2026-09-01T10:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Bauplan erhalten: Arrow: \" [1] to queue.\n",
        )
        .unwrap();
        // Unsauberes Byte in einer anderen Zeile darf nichts kaputtmachen.
        let mut aktuell = b"kaputt \xff\n".to_vec();
        aktuell.extend_from_slice(
            b"<2026-09-15T12:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Received Blueprint: Sedulity (Ind/2/B): \" [88] to queue.\n\
<2026-09-15T12:00:01.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Bauplan erhalten: Arrow: \" [2] to queue.\n\
<2026-09-15T12:00:02.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Blueprint acquired: Foo\" [3] to queue.\n",
        );
        std::fs::write(dir.join("Game.log"), aktuell).unwrap();

        let r = scannen(Some(dir.display().to_string()), &BTreeMap::new());

        // Zweiter Scan mit Merker: nichts neu gelesen
        let r2 = scannen(Some(dir.display().to_string()), &r.merker);
        assert!(r2.dateien.iter().all(|d| d.art == "unveraendert"), "{:?}", r2.dateien.iter().map(|d| d.art).collect::<Vec<_>>());
        assert_eq!(r2.funde_gesamt, 0);

        // Game.log waechst: nur der neue Teil wird gelesen
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("Game.log")).unwrap();
        f.write_all(b"<2026-09-15T13:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Bauplan erhalten: Neu: \" [9] to queue.\n<2026-09-15T13:00:01.000Z> halbe Zeile ohne Ende").unwrap();
        drop(f);
        let r3 = scannen(Some(dir.display().to_string()), &r.merker);
        let log = r3.dateien.iter().find(|d| d.pfad.ends_with("Game.log")).unwrap();
        assert_eq!(log.art, "weiter");
        assert_eq!(log.zeilen, 1, "nur die neue ganze Zeile, die halbe nicht");
        assert_eq!(r3.bauplaene.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["Neu"]);

        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(r.dateien.len(), 2);
        assert_eq!(r.funde_gesamt, 3);
        let namen: Vec<_> = r.bauplaene.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(namen, ["Arrow", "Sedulity (Ind/2/B)"]);
        assert_eq!(r.bauplaene[0].zeit.as_deref(), Some("2026-09-01T10:00:00.000Z"));
        assert_eq!(r.verdaechtig.len(), 1);
    }
}
