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
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Wie viele verdaechtige Zeilen hoechstens zurueckkommen. Es geht um Beispiele,
/// nicht um eine vollstaendige Liste.
const MAX_VERDAECHTIG: usize = 20;

const KANAELE: [&str; 5] = ["LIVE", "PTU", "EPTU", "HOTFIX", "TECH-PREVIEW"];

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

pub fn scannen(eigener_ordner: Option<String>) -> ScanErgebnis {
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

    for o in &ordner {
        for pfad in log_dateien(o) {
            let anzeige = pfad.display().to_string();
            let mut stand = DateiStand { pfad: anzeige.clone(), zeilen: 0, treffer: 0, fehler: None };
            let datei = match File::open(&pfad) {
                Ok(f) => f,
                Err(e) => {
                    stand.fehler = Some(e.to_string());
                    dateien.push(stand);
                    continue;
                }
            };
            // Neuer Parser je Datei: die Wiederholungs-Sperre gilt innerhalb einer Sitzung.
            let mut parser = BauplanParser::default();
            let mut leser = BufReader::new(datei);
            let mut puffer = Vec::new();
            loop {
                puffer.clear();
                match leser.read_until(b'\n', &mut puffer) {
                    Ok(0) => break,
                    Ok(_) => {}
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

        let r = scannen(Some(dir.display().to_string()));
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(r.dateien.len(), 2);
        assert_eq!(r.funde_gesamt, 3);
        let namen: Vec<_> = r.bauplaene.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(namen, ["Arrow", "Sedulity (Ind/2/B)"]);
        assert_eq!(r.bauplaene[0].zeit.as_deref(), Some("2026-09-01T10:00:00.000Z"));
        assert_eq!(r.verdaechtig.len(), 1);
    }
}
