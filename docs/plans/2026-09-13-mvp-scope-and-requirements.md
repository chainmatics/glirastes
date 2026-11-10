# Glirastes MVP: Produktumfang und Anforderungen

Version: 1.2 · Stand: 2026-09-13

Status: Festgehaltenes Zielbild aus der Produktabstimmung mit Philip. Kein Nachweis vollständiger Implementierung und keine Releasefreigabe.

## 1. Ziel und Nutzer

Glirastes macht vorhandene App-Funktionen über einen Chat bedienbar. Entwickler pflegen keinen zweiten Tool-Katalog. Ein vorhandener Coding-Agent übernimmt die Einrichtung und unterstützt Änderungen. Die optionale Plattform ergänzt Übersicht und Betrieb.

Primärer Nutzer: Entwickler einer bestehenden App, zunächst Get It Done. Er kennt seine Anwendung und verwendet einen Coding-Agenten. Er will Chat-Funktionen ohne eigene zweite Integrationsschicht bereitstellen.

Sekundäre Nutzer: App-Anwender, die Aufgaben per Chat erledigen, und Betreiber, die Fehler, Versionen und Kosten verstehen müssen.

Problem: Der Pilot funktioniert mit vorbereiteten Integrationsartefakten. Frische Einrichtung, Aktualisierung bei Codeänderungen und UI-Parität sind noch nicht durchgängig nachgewiesen. Die bisherige Einrichtung unterbricht den Ablauf zwischen Installation, Assessment und Anwendung.

### Verbindliche Bedienungspriorität aus dem aktiven Goal

Ein Vibecoder ohne Glirastes-Spezialwissen muss die Einrichtung und den normalen Betrieb verstehen. Sichtbare Komplexität reduzieren, ohne vereinbarte Funktionen zu verlieren. Sprache, Defaults, Fortschritt und Rückmeldungen sollen Sicherheit im Umgang vermitteln und Freude machen; Dekoration allein erfüllt das nicht.

Die Plattform beantwortet zuerst fünf Nutzerfragen: Ist meine App verbunden? Was kann mein Chat? Sind meine Änderungen verfügbar? Was kostet die Nutzung? Wie behebe ich ein Problem oder gehe zurück?

Manifeste, Digests, Pins und interne Statuscodes sind keine Voraussetzung für den Hauptablauf. Diagnose und erweiterte Einstellungen bleiben erreichbar. Jeder Fehler nennt eine konkrete, sichere nächste Aktion. Der Status unterscheidet lokale Prüfung, Synchronisierung, Aktivierung und erfolgreiche Ausführung; kein dekoratives „bereit“, wenn nur eine Teilprüfung bestanden wurde.

Abnahme: Neue Nutzer bearbeiten Einrichtung, Statusprüfung, Änderungsübernahme, Nutzungsübersicht und Rollback anhand der Oberfläche ohne mündliche Hilfe. Für jeden Ablauf werden Erfolg, Hilfebedarf, Fehlversuche und Sackgassen protokolliert. Automatisierte Browserchecks ergänzen diese Beobachtung, ersetzen aber keinen tatsächlichen Nutzertest. Sicherheitsrelevante Bestätigungen bleiben wirksam; doppelte rein technische Bedienhandlungen werden zusammengeführt.

## 2. Produktprinzipien und Grenzen

1. Der Code des jeweiligen Deployments ist die Quelle ausführbarer Fähigkeiten.
2. Einmalige Integration darf der Coding-Agent schreiben; Entwickler müssen sie nicht manuell nachbauen.
3. Generierte Anbindungen sind erlaubt. Eine unabhängig manuell gepflegte zweite Funktionsbeschreibung ist kein Ziel.
4. Runtime und App-Daten bleiben in der Kundenumgebung. Plattformbetrieb ist optional.
5. Wenige passende Tools statt vollständiger Schemas bei jeder Anfrage. Bei relevanter Unklarheit nachfragen.
6. Vorhandene App-Berechtigungen gelten weiter. Vereinfachte Bedienung ist keine Freigabe zum Entfernen technischer Schutzmechanismen.
7. Get It Done ist Referenz, keine Sonderlösung. Drei unterschiedliche Integrationsformen müssen denselben Kern und Einrichtungsworkflow verwenden können.

„Lokal“ bedeutet Ausführung innerhalb der Kundenumgebung, nicht zwingend auf einem Laptop. Ein gewählter Cloud-Modellprovider kann Kontext erhalten. Das ist von der inhaltsfreien Glirastes-Plattformverbindung zu unterscheiden.

### Bestätigte Erweiterung: generisches Web-App-Fundament

Philip hat die Erweiterung auf einen framework- und sprachübergreifenden Kern mit drei Referenzintegrationen bestätigt. Diese Entscheidung ersetzt die frühere Beschränkung der MVP-Abnahme auf Next.js und ein zweites Projekt desselben Stacks.

- Setup-Agenten erkennen Frontend, Backend, Sprache, Projektstruktur und vorhandene API-Verträge getrennt. Gemischte Stacks sind vorgesehen.
- Tool-Beschreibung, Ausführung, UI-Aktionen und Plattform-Metadaten verwenden gemeinsame Verträge. Framework-Anbindungen bleiben schlank; keine eigene vollständige Runtime je Sprache.
- Bestehende HTTP-APIs und gegebenenfalls OpenAPI-Beschreibungen dienen als Integrationsquellen. Fehlende Spezifikationen erzwingen keine manuelle Zweitpflege. Der Agent kann Anbindungen aus Code ableiten; deren Prüfung bleibt notwendig.
- Frontend-Aktionen umfassen Navigation, Filter, Auswahl und aktuellen Kontext. Ein allgemeiner API-Katalog allein erfüllt diese Anforderung nicht.
- Die React-UI bleibt erhalten. Zusätzlich gehört ein frameworkunabhängiger Einbettungsweg zur MVP-Abnahme. Web Components sind ein technischer Kandidat, keine bereits implementierte oder abschließend gewählte Lösung.
- Für Nicht-Node-Backends ist ein separater Runtime-Prozess innerhalb der Kundenumgebung eine mögliche Anbindung. Zusätzliche Prozesse, Hosting-Anforderungen und Start-/Deployment-Schritte müssen sichtbar sein. Keine verdeckte Plattform-Ausführung.

Architektur-Zielmatrix: React/Next.js, Vue/Nuxt, Angular, Svelte/SvelteKit und klassische HTML-/JavaScript-Frontends; JavaScript/TypeScript, Python, PHP, C#/.NET, Java/Kotlin, Go und Ruby auf der Backend-Seite. Dies ist keine Zusage fertiger Adapter, universeller Quellcodeparser oder eigener nativer SDKs für alle Sprachen.

Die veröffentlichte Supportmatrix unterscheidet **erkannt**, **integriert**, **automatisch geprüft** und **offiziell unterstützt**. Ein Coding-Agent, der die Sprache versteht, ist allein kein Supportnachweis.

| MVP-Referenz | Nachweis |
| --- | --- |
| Get It Done / Next.js | Integrierte Fullstack-App; aktuelle Hauptbranch-Funktionen und Foundation-Verhalten erhalten. |
| React mit getrenntem Backend, vorgesehen Omnify/NestJS | App-übergreifender Kern sowie getrennte UI-/Backend-Integration. Umsetzung nur in einem zuvor geklärten isolierten Checkout. |
| Kleine Nicht-React-/Nicht-TypeScript-Referenz, etwa Vue/Python | Frameworkunabhängige Chat-Einbettung, sprachunabhängige Backend-Anbindung und deklarierte Runtime-Voraussetzungen. Konkretes Framework-Paar im technischen Plan festlegen. |

Alle drei bestehen Einrichtung, erfolgreiche Tool-Aktion und Add/Change/Delete von Endpunkt, Navigation und Filter. Authentifizierung, Streaming, Fehler, Cleanup und Build-/Deployment-Zuordnung werden pro Integrationsform geprüft. Bei bestehenden Apps wird zusätzlich eine frische Einrichtung ohne versteckte Glirastes-Vorbereitung reproduziert.

## 3. Bestandsentscheidung

### Behalten und konsolidieren

| Bestand | Entscheidung |
| --- | --- |
| Gemeinsame lokale Runtime und AI-SDK-Engine | Weiterverwenden; keine getrennten Free-/Pro-Ausführungspfade. |
| Intent-Routing und bestehendes `find_tools` | Weiterverwenden; Trefferqualität und Aktivierung überprüfen. |
| React-Chat, Sessions, Tool-Ergebnisse und Erweiterungspunkte | Zur gemeinsamen Standard-UI ausbauen und frameworkunabhängig einbettbar machen. |
| Zentrale STT-Steuerung | Behalten; genau eine Recording-State-Machine und ein Mikrofonstream. |
| Scanner, Schemas, Fingerprints und lokale Bindings | Grundlage für Codeabgleich und überprüfbare Agentenergebnisse. |
| Setup-, Framework-, UI- und Tool-Pflege-Skills | Behalten und zu einem durchgängigen Workflow verbinden. |
| Sync, Revisionen, lokale Prompt-Bundles und Deployment-Zuordnung | Behalten; Plattform ergänzt Verwaltung, nicht Tool-Ausführung. |
| Principal-/Scope-Prüfungen, Budgets, Timeouts, Loop-Schutz und Turn-Pinning | Behalten; keine kostenpflichtige Sicherheitsbasis. |
| Bestehende Kompatibilitätspfade | Bewahren, soweit nicht ihre konkrete Ablösung bereits freigegeben ist. |

Diese Einordnung beschreibt Wiederverwendung, nicht eine erneute Vollabnahme. Referenz des SDK-Bestands: Commit `d697bc7`.

### Neu oder durchgängig fertigzustellen

| ID | Must-Rang | Fähigkeit und Abnahme |
| --- | --- | --- |
| FR-1 | 1 | **Agentengeführte Einrichtung:** Ein dokumentierter Einstieg führt vom frischen unterstützten Projekt bis zur erfolgreichen Chat-Tool-Aktion. Der Agent erkennt Framework, Projektstruktur, Authentifizierung und vorhandene Fähigkeiten. Er erzeugt die Anbindung und prüft sie. Keine vorbereiteten Glirastes-Artefakte im Ausgangsprojekt. |
| FR-2 | 2 | **Aktualität bei Codeänderungen:** Endpunkt, Navigation und Filter jeweils hinzufügen, ändern und entfernen. Nach dem vorgesehenen lokalen Build-/CI-Ablauf entsprechen verfügbare Tools dem Code. Keine manuelle Tool-Katalogpflege. Entfernte Funktionen sind nicht ausführbar. Nicht unterstützte Änderungen werden sichtbar, statt einen veralteten Erfolg zu melden. |
| FR-3 | 3 | **Routing, Suche und Klärung:** Bekannte Absicht nutzt wenige passende Tools. Fehlende Vorauswahl kann `find_tools` ergänzen. Mehrdeutige Aufgaben erzeugen eine gezielte Rückfrage; die Antwort ergänzt den ursprünglichen Auftrag. Tests enthalten deutsche/englische Begriffe, Synonyme, Nulltreffer und fehlende Berechtigungen. |
| FR-4 | 4 | **Gemeinsame Chat-UI:** Streaming, stabile Sessions, Sidebar/Floating/mobile Darstellung, Tool-Aktivität und Fehlerzustände funktionieren ohne projektspezifischen Chat-Neubau. `/`-Befehle und `@`-Suche besitzen generische Anschlüsse an App-Daten. Eine eigene kompakte Ergebnis-Komponente lässt sich lokal einbinden. |
| FR-5 | 5 | **STT-Parität:** Push-to-talk, sichtbarer Interim-Text, verlustfreie Finalisierung und Bearbeitung vor dem Senden. Stop, Cancel, Retry, Routenwechsel und Unmount hinterlassen keinen Mikrofonstream. Kein automatisches Absenden durch die bloße Finalisierung. |
| FR-6 | 6 | **Einfacher Plattformbetrieb:** App verbinden, Setup-Status verstehen, Tools suchen, Details prüfen, Revision erkennen und Konfiguration zurückrollen. Entwicklung, Staging und Produktion dürfen unterschiedliche Codestände haben. Jede Instanz verwendet nur lokal vorhandene, kompatible Fähigkeiten. |
| FR-7 | 7 | **Technische Transparenz:** Tokens, Kostenschätzung, Latenz, Fehler und Tool-Nutzung sind App, Umgebung, Build, Instanz und Revision zuordenbar. Unbekannte Preise/Tokenwerte sind nicht null. Plattformdaten enthalten keine fachlichen Inhalte oder Roh-Credentials. |
| FR-8 | 8 | **Wiederverwendbarkeit und Referenzmigration:** Get It Done integriert den aktuellen Upstream-Hauptbranch ohne Verlust neuer App-Funktionen. Nach Paritätsnachweis verschwinden dort die abgelösten Agentic-Abhängigkeiten. Die drei Referenzintegrationen aus Abschnitt 2 bestehen Einrichtung und Änderungstests ohne GID-Sonderlogik oder getrennte Runtime-Kerne. |

FR-1/2/8 unterstützen den Entwickler. FR-3/4/5 unterstützen den App-Anwender. FR-6/7 unterstützen den Betreiber.

### Bestehendes Verhalten ändern

- Den normalen Setup-Pfad nicht zwischen „Skills installieren“, „Agent separat ausführen“ und „Setup erneut starten“ abbrechen lassen. Wiederaufnahme nach echten Fehlern bleibt möglich.
- Beim Einsatz eines vorhandenen Coding-Agenten keinen zusätzlichen OpenRouter-Key für das Setup voraussetzen. Der Modellzugang des App-Chats bleibt eine getrennte Konfiguration.
- Framework-Erkennung des Agenten nicht mit universeller Framework-Unterstützung gleichsetzen. Die drei Integrationsformen aus Abschnitt 2 gehören zum MVP. Nicht geprüfte Stacks klar benennen; AI-SDK bleibt die erste gemeinsame Referenz-Engine.
- Keine Pflicht-Decorators oder `ai-ignore`-Kommentare für neue Integrationen. Vorhandene Altpfade nicht beiläufig entfernen.
- Die bestehende einfache Textsuche in `find_tools` auf den Abnahmekorpus ausrichten. Ein zusätzlicher Embedding-Dienst oder separater Such-Agent ist keine vorausgesetzte Lösung.
- Im Normalfall keinen separaten Planner-/Klärungs-Modellaufruf erzwingen. Vorhandenen App-Kontext nutzen; zusätzliche Runden durch messbaren Nutzen rechtfertigen.
- Plattform-Setup von langen Pflichtfeldlisten auf eine lesbare Übersicht mit aufklappbaren Details reduzieren. Keine drei manuell duplizierten Tool-Konfigurationen für drei Umgebungen.
- Keine pauschale Approval-Pflicht für jede Aktion als Produktstandard. Bestehende Sicherheitsvorgaben bleiben wirksam; konkrete Default-Änderungen benötigen eine überprüfte Policy-Zuordnung.
- Landingpage, Beispiele, Paketoberfläche und Tarife auf den tatsächlich freigegebenen Umfang abstimmen. Hero-Glyphen lesbar machen; Root-Animation ruhig und mit Reduced-Motion-Variante gestalten.

## 4. SDK lokal, Plattform Free und Pro

| Bereich | SDK lokal | Plattform Free | Plattform Pro |
| --- | --- | --- | --- |
| Einrichtung, Discovery, Routing, `find_tools`, Rückfragen | Vollständig | Identische lokale Funktion | Identische lokale Funktion |
| Chat, STT, Commands, Mentions, lokale Renderer | Vollständig | Identische lokale Funktion | Identische lokale Funktion |
| Authentifizierung und technische Basisschutzmechanismen | Enthalten | Enthalten | Enthalten |
| Betrieb ohne Plattformkonto | Ja | Nein | Nein |
| Verwalteter Plattformumfang | Keiner; lokale Apps/Deployments nicht künstlich beschränkt | Eine App und eine Umgebung pro Organisation | Mehrere Apps und Umgebungen; Teamzugriff |
| Änderungskontrolle | Lokale Dateien, Git und eigene CI/CD | Sync, signierte Revisionen, Status, grundlegende Historie und Rollback | Umgebungsübergreifende Übersicht und Verwaltung; erweiterte Historie |
| Metriken | Lokale technische Events zur eigenen Auswertung | Basisdashboard für Tokens, Kostenschätzung, Latenz und Fehler | Längere Historie und Vergleiche nach Umgebung, Version, Modell und Tool |

Automatische Aktualität und eigene CI/CD-Pipelines sind keine Pro-Funktionen. Alle Varianten verwenden dieselbe lokale Ausführung ohne notwendigen Plattform-Roundtrip pro Turn. Bei vorübergehendem Plattformausfall gelten bestehende Cache-/Lease-Grenzen; das ist kein unbegrenztes Offline-Versprechen.

Konkrete Preise, Historienlängen und Telemetrie-Kontingente sind offen. Eigene Modell-, Coding-Agent- und STT-Kosten sind nicht im kostenlosen SDK enthalten. Automatische Bezahlung und ein neues Billing-System sind keine Voraussetzung für die technische MVP-Abnahme; kommerzielles Pro benötigt vor Verkauf einen klaren Bereitstellungsprozess.

## 5. Für das MVP aus dem sichtbaren Angebot nehmen

„Herausnehmen“ bedeutet hier: aus Standardnavigation, Onboarding, öffentlichen Beispielen und MVP-Versprechen entfernen beziehungsweise dort nicht anbieten. Es ist keine pauschale Löschfreigabe.

| Thema | MVP-Behandlung | Was ausdrücklich erhalten bleibt |
| --- | --- | --- |
| MCP-/Skill-Generator als Produkt | Nicht anbieten; Roadmap | Mitgelieferte Setup-/Pflege-Skills sind MVP-Kern. |
| LangGraph, universelle Parser und vollständige native SDKs für jede Sprache | Keine neue MVP-Supportzusage | Generische Verträge und drei Referenzintegrationen sind MVP. Die begrenzte NestJS/Omnify-Referenz ist nicht mehr pauschal zurückgestellt. Bestehende Exporte nicht ungeprüft reaktivieren. |
| Zusätzliche Engines, Remote-Aegis und eigenständige Lancer-Oberfläche | Nicht Teil des MVP-Angebots | Gemeinsame Runtime und notwendige interne Implementierung. |
| Enterprise-Governance, komplexe Approvals und Policy-Editoren | Aus dem normalen Einstieg heraushalten | App-Autorisierung, gezielte nötige Bestätigungen, Signatur- und Scope-Prüfungen. |
| Canary, komplexe Promotions, A/B-Evaluation und automatische Promptoptimierung | Roadmap | Revisionen, kompatible Hot Updates, Turn-Pinning und Rollback. |
| Verwalteter Widget-Katalog, visueller Editor, automatisch erzeugte UI | Roadmap | Lokale Renderer-Schnittstelle für eigene App-Komponenten. |
| Erweiterte Alerts, Exporte und Analyseplattform | Spätere Pro-Erweiterung | MVP-Basismetriken und einfache Vergleiche. |
| TTS und Duplex-Voice | Nicht Bestandteil dieses MVP | STT inklusive Bearbeitung vor dem Senden. |

Nicht exportierte Foundation-Flächen bleiben zunächst nicht exportiert. Vor weiteren Paket-Ausschlüssen Importgraph, öffentliche Verträge und Verbraucher prüfen. Keine pauschale Entfernung aus SDK oder Platform.

Die bereits bestätigte Get-It-Done-Ablösung ist getrennt: Legacy-Abhängigkeiten erst nach neuer Integration und erfolgreicher Paritätsprüfung entfernen. Keine externen Pushes, Hauptbranch-Merges, Releases, Paketveröffentlichungen oder Deployments ohne ausdrückliche Freigabe.

## 6. Abnahme und Qualitätsanforderungen

- **Einrichtung:** Ziel unter fünf Minuten bis zu einer erfolgreichen Tool-Aktion in einer neuen unterstützten App. Ausgangszustand, vorhandener Agent und verfügbare Provider-Zugänge dokumentieren. Download-, Agenten- und Nutzereingabezeiten getrennt ausweisen; keine versteckten Vorbereitungen.
- **Änderungskorpus:** Für Endpunkt, Navigation und Filter jeweils Add/Change/Delete prüfen. Nach einem fehlerhaften Scan keine veraltete Integration als aktuell melden. Ein Skill allein ist kein Aktualitätsnachweis.
- **Frameworkbreite:** Den Einrichtungs- und Änderungskorpus für alle drei Integrationsformen aus Abschnitt 2 ausführen. Ein zusätzlicher Runtime-Prozess zählt zu den offenzulegenden Voraussetzungen und zur Einrichtungsmessung. Im Nicht-React-Fall auch Styling, Events, Tastaturbedienung und Unmount der Chat-Einbettung prüfen.
- **Suche:** Relevante Treffer aktivieren; keine unberechtigten oder im Deployment fehlenden Tools liefern. Plattformkonfiguration erzeugt keinen fehlenden Anwendungscode.
- **Klärung:** Fehlende Zielperson/Zielobjekt gezielt erfragen. Ursprünglichen Auftrag erhalten. Bei ableitbarer Absicht ohne unnötige Rückfrage ausführen.
- **Versionsgrenzen:** Zwei laufende Umgebungen mit unterschiedlichen Fähigkeiten prüfen. Kompatible Konfigurations-/Prompt-Updates während eines Turns verändern dessen gepinnten Stand nicht. Kritische Sperren bleiben wirksam.
- **Datengrenzen:** Ausgehende Plattform-Payloads auf technische Felder beschränken. Keine Prompts, Chat-Inhalte, Tool-Argumente/-Ergebnisse oder Secrets übertragen. Telemetrie bleibt außerhalb des kritischen Turn-Pfads.
- **Performance:** Vergleichskorpus mit identischem Modell, Einstellungen und App-Daten vor/nach Änderungen. Erfolgsquote, erste sichtbare Antwort, End-to-End-Zeit, Modellrunden und Tokens erfassen. Zusätzliche Discovery-/Klärungsrunden gesondert ausweisen. Keine allgemeine Prozentersparnis ohne Messung.
- **UI/STT:** Browser-, Tastatur-, mobile und Mikrofon-Lifecycle-Tests. Get-It-Done-Parität anhand konkreter Flows, nicht allein anhand vorhandener Komponenten.
- **Release:** Relevante Unit-, Integrations-, Security-, Browser- und Migrationstests grün. Typecheck, Produktionsbuild, Bundle-/Paketprüfung und Rollback-Nachweis. Installationsbeispiel gegen den tatsächlich zu veröffentlichenden Paketstand prüfen.
- **Landingpage:** Lesbare Hero-Glyphen auf Desktop und Mobil, kein Textverlust durch Animation, Reduced Motion, funktionierende Links und korrekte Feature-/Tarifversprechen.

Numerische Laufzeit-/Bundle-Budgets über das bestehende Unter-fünf-Minuten-Ziel hinaus sind vor der jeweiligen Abnahme anhand reproduzierbarer Baselines festzulegen. Diese Produktabgrenzung ist noch kein vollständiger technischer Ausführungsplan.

## 7. Reihenfolge und offene Details

Priorität: gemeinsame Integrationsverträge und Referenzmatrix festlegen; Get It Done mit aktuellem Upstream abgleichen; agentengeführte Einrichtung und Day-2-Änderungen in allen drei Integrationsformen beweisen; Routing/Chat-Parität schließen; Plattformbetrieb und Metriken vereinfachen; öffentliche Darstellung auf den belegten Stand bringen.

Es gibt keinen neuen Termin oder Releaseauftrag. Ziel ist der Einsatz in mehreren Ziel-Apps ohne Sonderintegration.

| Offener Punkt | Zuständigkeit und Zeitpunkt |
| --- | --- |
| Preis, Aufbewahrung und Telemetrie-Kontingente | Produktentscheidung mit Philip vor öffentlicher Tarifzusage; blockiert lokale Integration nicht. |
| Konkrete Agenten-Start-/Wiederaufnahmeverfahren | Technisch pro unterstütztem Agenten testen; keine automatische Übernahme von Credentials oder verdeckte Providerwechsel. |
| Nicht-React-Einbettung, Nicht-Node-Runtime und drittes Framework-Paar | Im technischen Plan anhand der gemeinsamen Verträge und repräsentativer Tests bestimmen. Betriebsvoraussetzungen offenlegen; keine neuen Produktfunktionen daraus ableiten. |
| Performance- und Bundle-Grenzwerte | Aus vorhandenen und neuen Baselines ableiten und vor Abnahme festschreiben. |
| Konkrete Approval-Defaults und auszublendende Plattform-Routen | Bestand und Sicherheitswirkung prüfen; keine neue Berechtigungsentscheidung aus diesem Dokument ableiten. |

## 8. Verknüpfte Quellen

- [Bestätigte MVP-Richtung](2026-09-13-focused-mvp-design.md)
- [Implementierter erster SDK-Abschnitt und Testevidenz](2026-09-13-focused-routing-implementation.md)
- [Produkt-/DX-/Landingpage-Audit](/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/docs/plans/2026-09-13-glirastes-product-dx-and-landing-audit.md)
- [Kanonischer Pilot-Arbeitsstand](/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md)

Dieses Dokument konkretisiert den Produktumfang nach der anschließenden Diskussion über Setup-Agenten, `find_tools`, Tarife und generische Web-App-Unterstützung. Version 1.1 ergänzt die ausdrücklich bestätigten drei Referenzintegrationen. Frühere Test-/Betriebsevidenz bleibt zeitgebunden. Die alten Anforderungen bedeuten nicht, dass zurückgestellte Sonderfeatures jetzt umgesetzt werden müssen.
