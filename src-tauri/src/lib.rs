// Systemteil des Clients. Bewusst duenn: alles, was ohne Betriebssystem-Zugriff geht,
// liegt in der Oberflaeche. Hier steht, was der Browser nicht kann: Game.log lesen,
// Dateien im App-Ordner schreiben.
// Erkennt erhaltene Bauplaene in Game.log-Zeilen (Blaupausen-Tracker, scverse #498).
pub mod logparser;
// Findet die Log-Dateien und liest sie komplett (scverse #501).
pub mod logscan;
// Merkt sich gefundene und hochgeladene Blaupausen in bauplaene.json.
pub mod bestand;
// Stille Updates aus den GitHub-Releases.
mod update;

use std::sync::Mutex;
use tauri::Manager;

/// Serialisiert Lesen/Aendern/Schreiben der Bestandsdatei. Automatischer Durchgang und
/// Knopfdruck koennen sich ueberschneiden; ohne Sperre gewinnt der letzte Schreiber
/// und ein Upload-Stand ginge verloren.
pub(crate) struct BestandSperre(pub(crate) Mutex<()>);

fn bestand_pfad(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(bestand::pfad_in)
        .map_err(|e| format!("App-Datenordner nicht gefunden: {e}"))
}

/// Gemeinsamer Rahmen: sperren, lesen, aendern, schreiben, Stand zurueckgeben.
fn bestand_aendern(
    app: &tauri::AppHandle,
    aendern: impl FnOnce(&mut bestand::Bestand),
) -> Result<bestand::BestandAntwort, String> {
    let sperre = app.state::<BestandSperre>();
    let _g = sperre.0.lock().map_err(|_| "Bestand gesperrt (vorheriger Fehler).".to_string())?;
    let pfad = bestand_pfad(app)?;
    let (mut b, warnung) = bestand::lesen(&pfad);
    aendern(&mut b);
    bestand::schreiben(&pfad, &b)?;
    Ok(bestand::BestandAntwort { pfad: pfad.display().to_string(), bestand: b, scan: None, warnung })
}

/// Logs einlesen, aber nur was neu ist, und die Funde gleich in bauplaene.json merken.
/// `von_vorn` vergisst die Lesestellen (die Blaupausen bleiben) und liest alles erneut.
/// Laeuft in einem eigenen Thread: das erste Einlesen vieler Logs dauert, und auf dem
/// Hauptthread wuerde das Fenster einfrieren.
#[tauri::command]
async fn bauplaene_aktualisieren(
    app: tauri::AppHandle,
    ordner: Option<String>,
    jetzt: String,
    von_vorn: bool,
) -> Result<bestand::BestandAntwort, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sperre = app.state::<BestandSperre>();
        let _g = sperre.0.lock().map_err(|_| "Bestand gesperrt (vorheriger Fehler).".to_string())?;
        let pfad = bestand_pfad(&app)?;
        let (mut b, warnung) = bestand::lesen(&pfad);
        // Erst aufraeumen, dann lesen: nach einer verbesserten Erkennung sind die
        // Lesestellen ungueltig (sonst bleibt der alte Name fuer immer stehen).
        let hinweis = bestand::auf_parser_version_heben(&mut b, logparser::PARSER_VERSION);
        let bekannt = if von_vorn { Default::default() } else { b.dateien.clone() };
        let mut scan = logscan::scannen(ordner, &bekannt);
        bestand::funde_merken(
            &mut b,
            scan.bauplaene
                .iter()
                .map(|t| bestand::Fund { name: t.name.clone(), zeit: t.zeit.clone(), sprache: Some(t.sprache.to_string()) })
                .collect(),
            &jetzt,
        );
        // Lesestellen anderer Ordner (z. B. PTU, gerade nicht gefunden) nicht wegwerfen.
        b.dateien.extend(std::mem::take(&mut scan.merker));
        bestand::schreiben(&pfad, &b)?;
        Ok(bestand::BestandAntwort {
            pfad: pfad.display().to_string(),
            bestand: b,
            scan: Some(scan),
            // Beides kann gleichzeitig anfallen; der Hinweis zur neuen Erkennung
            // verdraengt keine Warnung ueber eine beschaedigte Datei.
            warnung: match (warnung, hinweis) {
                (Some(w), Some(h)) => Some(format!("{w} {h}")),
                (w, h) => w.or(h),
            },
        })
    })
    .await
    .map_err(|e| format!("Einlesen abgebrochen: {e}"))?
}

#[tauri::command]
fn bestand_lesen(app: tauri::AppHandle) -> Result<bestand::BestandAntwort, String> {
    let sperre = app.state::<BestandSperre>();
    let _g = sperre.0.lock().map_err(|_| "Bestand gesperrt (vorheriger Fehler).".to_string())?;
    let pfad = bestand_pfad(&app)?;
    let (b, warnung) = bestand::lesen(&pfad);
    Ok(bestand::BestandAntwort { pfad: pfad.display().to_string(), bestand: b, scan: None, warnung })
}

#[tauri::command]
fn bestand_rueckmeldung_merken(
    app: tauri::AppHandle,
    rueckmeldungen: Vec<bestand::Rueckmeldung>,
    jetzt: String,
) -> Result<bestand::BestandAntwort, String> {
    bestand_aendern(&app, |b| bestand::rueckmeldung_merken(b, rueckmeldungen, &jetzt))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Oeffnet Adressen im STANDARDBROWSER. Absichtlich kein eingebettetes Fenster:
        // der Nutzer muss bei der Anmeldung die Adresszeile pruefen koennen.
        .plugin(tauri_plugin_opener::init())
        // HTTP ueber den Rust-Prozess statt ueber den WebView. Grund ist NICHT Bequem-
        // lichkeit: der WebView unterliegt der Same-Origin-Regel, und CitizenHQ setzt
        // (zu Recht) keine CORS-Header fuer fremde Herkuenfte.
        .plugin(tauri_plugin_http::init())
        // Updates aus den GitHub-Releases, signiert (Schluessel in tauri.conf.json).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BestandSperre(Mutex::new(())))
        .setup(|app| {
            update::starten(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bauplaene_aktualisieren,
            bestand_lesen,
            bestand_rueckmeldung_merken
        ])
        .run(tauri::generate_context!())
        .expect("Tauri konnte nicht starten");
}
