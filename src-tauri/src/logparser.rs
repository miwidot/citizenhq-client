// Erkennt in der Game.log, dass der Spieler einen Bauplan erhalten hat.
//
// So sieht die Zeile aus (echt, deutsches Spiel):
//
//   <SHUDEvent_OnNotification> Added notification "Bauplan erhalten: Sedulity (Ind/2/B): " [88] ...
//
// Erkennbar ist sie NUR am lokalisierten Hinweistext. Es gibt keine ID und keine GUID:
// [88] ist der Queue-Index, die MissionId ist Null. Herausholen laesst sich also nur
// der Name, und der steht in Spielsprache: Basisname plus Klassen-Notation in Klammern.
//
// Der englische Text ist BELEGT, nicht geraten. Lokalisierungsschluessel
//   crafting_hud_notification_received_blueprint = "Received Blueprint: %s"
// (scunpacked-data labels.json, 4.10.0-LIVE.12519617). Vermutet worden waren
// "Blueprint acquired" und "Blueprint received"; beide haetten nie getroffen.
//
// Andere Spielsprachen (Franzoesisch, Spanisch …) erkennt der Parser nicht. Das ist
// bewusst: ihre Texte sind nicht belegt, und ein geratener Text faellt nie auf.

/// In welcher Spielsprache der Name im Log stand. Entscheidet spaeter, ob er vor dem
/// Nachschlagen uebersetzt werden muss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sprache {
    De,
    En,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bauplan {
    pub name: String,
    pub sprache: Sprache,
}

const MELDUNG: &str = "Added notification \"";

/// Die belegten Hinweistexte je Sprache. Ohne das Leerzeichen dahinter: wie viel
/// Platz nach dem Doppelpunkt steht, entscheidet das Spiel, nicht wir.
const TEXTE: [(&str, Sprache); 2] = [
    ("Bauplan erhalten:", Sprache::De),
    ("Received Blueprint:", Sprache::En),
];

/// Wird beim Aendern der Erkennung HOCHGEZAEHLT.
///
/// Die App merkt sich gefundene Bauplaene und Lesestellen in bauplaene.json. Ohne
/// diese Zahl bliebe ein mit einer kaputten Fassung gelesener Name fuer immer so
/// stehen: die Log gilt als gelesen, also wird sie nie wieder angefasst.
///
/// 1 -> 2 (19.09.2026): Namen mit Anfuehrungszeichen wurden abgeschnitten.
pub const PARSER_VERSION: u32 = 2;

/// Wo der Name endet: am ersten `"`, vor dem (nach Leerzeichen) ein `:` steht.
///
/// NICHT einfach am ersten `"`. Genau daran ist die erste Fassung gescheitert:
/// aus `R97 "Kismet" Shotgun: ` wurde `R97`. Namen mit Anfuehrungszeichen sind im
/// Spiel normal (Waffen, Ruestungen), und der Fehler faellt nicht auf — der Name
/// sieht plausibel aus, nur eben falsch.
///
/// Das Spiel schliesst die Meldung mit `: "` ab. Dieses Paar ist das Ende, nicht
/// jedes Anfuehrungszeichen. Gesucht wird das ERSTE passende, damit der Name so
/// kurz wie moeglich bleibt (bei einer Zeile mit mehreren Meldungen).
fn name_ende(inhalt: &str) -> Option<usize> {
    let bytes = inhalt.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'"' {
            continue;
        }
        let davor = inhalt[..i].trim_end();
        if davor.ends_with(':') && davor.len() > 1 {
            return Some(i);
        }
    }
    // Kein `: "`: aeltere oder andere Meldungen enden direkt am `"`
    // ("Bauplan erhalten: Arrow"). Dann gilt das erste Anfuehrungszeichen.
    inhalt.find('"')
}

/// Eine einzelne Log-Zeile pruefen. `None`, wenn sie keinen Bauplan meldet.
pub fn bauplan_aus_zeile(zeile: &str) -> Option<Bauplan> {
    let rest = &zeile[zeile.find(MELDUNG)? + MELDUNG.len()..];
    let (text, sprache) = TEXTE.iter().find(|(text, _)| rest.starts_with(text))?;
    let inhalt = &rest[text.len()..];
    let roh = &inhalt[..name_ende(inhalt)?];
    // Das Spiel haengt ": " an ("Sedulity (Ind/2/B): "), nicht immer.
    let name = roh.trim().trim_end_matches(':').trim();
    if name.is_empty() {
        return None;
    }
    Some(Bauplan { name: name.to_string(), sprache: *sprache })
}

/// Liest Zeilen nacheinander und meldet jeden Bauplan einmal.
///
/// Das Spiel schreibt denselben Hinweis oft mehrfach direkt hintereinander (Queue).
/// Unterdrueckt wird nur die unmittelbare Wiederholung; derselbe Bauplan spaeter noch
/// einmal wird wieder gemeldet. Ob er dann schon bekannt ist, entscheidet nicht der
/// Parser, sondern wer die Meldung verarbeitet.
#[derive(Default)]
pub struct BauplanParser {
    zuletzt: Option<String>,
}

impl BauplanParser {
    pub fn zeile(&mut self, zeile: &str) -> Option<Bauplan> {
        let bauplan = bauplan_aus_zeile(zeile)?;
        if self.zuletzt.as_deref() == Some(bauplan.name.as_str()) {
            return None;
        }
        self.zuletzt = Some(bauplan.name.clone());
        Some(bauplan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DE_ECHT: &str = "<2026-09-15T12:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Bauplan erhalten: Sedulity (Ind/2/B): \" [88] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000]";
    // Aus dem belegten Lokalisierungstext gebaut, nicht aus einer echten englischen Log.
    const EN: &str = "<2026-09-15T12:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Received Blueprint: Sedulity (Ind/2/B): \" [88] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000]";

    #[test]
    fn deutsche_zeile() {
        assert_eq!(
            bauplan_aus_zeile(DE_ECHT),
            Some(Bauplan { name: "Sedulity (Ind/2/B)".into(), sprache: Sprache::De })
        );
    }

    #[test]
    fn englische_zeile() {
        assert_eq!(
            bauplan_aus_zeile(EN),
            Some(Bauplan { name: "Sedulity (Ind/2/B)".into(), sprache: Sprache::En })
        );
    }

    #[test]
    fn name_ohne_angehaengten_doppelpunkt() {
        let z = "Added notification \"Bauplan erhalten: Arrow\" [3]";
        assert_eq!(bauplan_aus_zeile(z).map(|b| b.name), Some("Arrow".into()));
    }

    #[test]
    fn vermuteter_englischer_text_trifft_nicht() {
        let z = "Added notification \"Blueprint acquired: Sedulity (Ind/2/B): \" [88]";
        assert_eq!(bauplan_aus_zeile(z), None);
    }

    #[test]
    fn andere_meldungen_und_leere_namen() {
        assert_eq!(bauplan_aus_zeile("Added notification \"Auftrag angenommen: Foo\" [1]"), None);
        assert_eq!(bauplan_aus_zeile("Added notification \"Bauplan erhalten: \" [1]"), None);
        assert_eq!(bauplan_aus_zeile("irgendeine andere Zeile"), None);
        // Abgeschnittene Zeile ohne schliessendes Anfuehrungszeichen: kein Treffer, kein Absturz.
        assert_eq!(bauplan_aus_zeile("Added notification \"Bauplan erhalten: Sedul"), None);
    }

    #[test]
    fn name_mit_anfuehrungszeichen_bleibt_ganz() {
        // Der Fehler der ersten Fassung: hier kam nur "R97" heraus.
        let z = "<2026-09-18T12:00:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification \"Bauplan erhalten: R97 \"Kismet\" Shotgun: \" [4] to queue.";
        assert_eq!(bauplan_aus_zeile(z).map(|b| b.name), Some("R97 \"Kismet\" Shotgun".into()));
    }

    #[test]
    fn klammern_und_zahlen_im_namen() {
        let z = "Added notification \"Bauplan erhalten: R97 Shotgun Magazine (18 Schuss): \" [4]";
        assert_eq!(
            bauplan_aus_zeile(z).map(|b| b.name),
            Some("R97 Shotgun Magazine (18 Schuss)".into())
        );
    }

    #[test]
    fn unmittelbare_wiederholung_nur_einmal() {
        let mut p = BauplanParser::default();
        assert!(p.zeile(DE_ECHT).is_some());
        assert!(p.zeile(DE_ECHT).is_none());
        assert!(p.zeile("Added notification \"Bauplan erhalten: Arrow\" [3]").is_some());
        assert!(p.zeile(DE_ECHT).is_some(), "spaeter erneut: wieder melden");
    }
}
