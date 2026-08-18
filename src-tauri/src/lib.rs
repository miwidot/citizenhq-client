// Systemteil des Clients. Bewusst duenn: alles, was ohne Betriebssystem-Zugriff geht,
// liegt in der Oberflaeche. Hier kommt spaeter dazu, was der Browser nicht kann —
// Game.log lesen, Tray, Autostart, Token im Schluesselbund.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Oeffnet Adressen im STANDARDBROWSER. Absichtlich kein eingebettetes Fenster:
        // der Nutzer muss bei der Anmeldung die Adresszeile pruefen koennen.
        .plugin(tauri_plugin_opener::init())
        // HTTP ueber den Rust-Prozess statt ueber den WebView. Grund ist NICHT Bequem-
        // lichkeit: der WebView unterliegt der Same-Origin-Regel, und CitizenHQ setzt
        // (zu Recht) keine CORS-Header fuer fremde Herkuenfte. Aus Rust heraus gibt es
        // diese Beschraenkung nicht — und das Token muss spaeter ohnehin dorthin, wo
        // die Seite es nicht auslesen kann.
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("Tauri konnte nicht starten");
}
