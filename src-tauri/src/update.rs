// Automatische Updates ohne Nachfrage (Owner, 15.09.2026: "so brauchen wir die nicht
// staendig fragen ob sie updaten koennen").
//
// Ablauf: beim Start und dann stuendlich nachsehen (latest.json im neuesten GitHub-Release),
// neue Version im Hintergrund laden, dann warten, bis gerade kein Einlesen laeuft, und still
// installieren. Windows: der Installer laeuft im Modus "quiet" (tauri.conf.json) und beendet
// die App dafuer selbst. Linux (AppImage): Datei wird ersetzt, danach Neustart.
//
// Sicherheit: jedes Update ist mit dem Updater-Schluessel signiert, der oeffentliche Teil
// steht in tauri.conf.json. Ein Update ohne passende Signatur installiert das Plugin nicht.
//
// Fehler (kein Netz, GitHub down) sind kein Grund, den Nutzer zu stoeren: sie gehen nach
// stderr und als Ereignis an die Oberflaeche, der naechste Versuch kommt eine Stunde spaeter.
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const TAKT: Duration = Duration::from_secs(60 * 60);
/// Wie oft nachgesehen wird, ob das Einlesen fertig ist, bevor installiert wird.
const WARTE_TAKT: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone)]
#[serde(tag = "art", rename_all = "camelCase")]
pub enum UpdateStand {
    Laedt { version: String },
    Installiert { version: String },
    Fehler { text: String },
}

fn melden(app: &AppHandle, stand: UpdateStand) {
    if let UpdateStand::Fehler { text } = &stand {
        eprintln!("[update] {text}");
    }
    let _ = app.emit("update", stand);
}

pub fn starten(app: AppHandle) {
    // Beim Entwickeln nicht die installierte Version aus dem Release ueberschreiben lassen.
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = einmal(&app).await {
                melden(&app, UpdateStand::Fehler { text: format!("Update fehlgeschlagen: {e}") });
            }
            tokio_sleep(TAKT).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    // Kein eigenes tokio im Cargo.toml noetig: der Schlaf laeuft in einem Blocking-Thread.
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

async fn einmal(app: &AppHandle) -> Result<(), String> {
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let version = update.version.clone();
    melden(app, UpdateStand::Laedt { version: version.clone() });
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| format!("Download {version}: {e}"))?;

    // Nicht mitten im Einlesen installieren: auf Windows beendet der Installer die App,
    // und eine halb geschriebene bauplaene.json soll es nicht geben. Waehrend installiert wird,
    // haelt dieser Block die Bestandssperre, also startet auch kein neues Einlesen. Die Sperre wird nur OHNE await dazwischen gehalten (ein MutexGuard darf nicht ueber
    // ein await). Installieren ist synchron, passt also komplett in den gesperrten Block.
    loop {
        let sperre = app.state::<crate::BestandSperre>();
        let ergebnis = match sperre.0.try_lock() {
            Ok(_g) => {
                melden(app, UpdateStand::Installiert { version: version.clone() });
                Some(update.install(&bytes).map_err(|e| format!("Installieren {version}: {e}")))
            }
            Err(_) => None,
        };
        match ergebnis {
            Some(Ok(())) => break,
            Some(Err(e)) => return Err(e),
            None => tokio_sleep(WARTE_TAKT).await,
        }
    }
    // Windows kommt hier nicht mehr an (Installer hat die App beendet), Linux schon.
    app.restart();
}
