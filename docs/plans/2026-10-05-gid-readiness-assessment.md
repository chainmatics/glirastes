# Wie gut wird Glirastes in Get It Done funktionieren?

Stand 2026-10-05. Grundlage sind zwei Messläufe auf Kopien von Get It Done (`origin/master` @296e98e) mit dem SDK-Stand der Foundation (064f8a9 bzw. 62a4eda, der Unterschied ist nur Doku), dazu ein Abgleich mit Roadmap und Spec. Einen echten Chat mit einem Modell und eine echte Datenbank gab es dabei nicht.

Ein paar Begriffe vorab:
- **Tool**: eine Funktion, die das Modell im Chat aufrufen darf, zum Beispiel „Aufgabe anlegen“.
- **aktiv / gesperrt**: Der Generator schaltet ein Tool nur frei, wenn er Eingaben, Rechte und Ziel sicher erkennt. Sonst steht es auf `needs_attention` und das Modell sieht es nicht.
- **Schema**: die Beschreibung der Eingaben eines Tools (Titel, Fälligkeit, Status …). Fehlt es oder ist es dünn, rät das Modell.
- **Brücke**: ein kleiner Baustein im GID-Code, über den der Chat Seiten öffnen und Filter setzen kann.

Status der vier Pläne laut Roadmap: **P04b** ist geschrieben, aber nicht ausgeführt. **P05** ist noch nicht geschrieben. **P07b** wurde am 2026-10-05 geschrieben und ist nicht ausgeführt. **P11** ist noch nicht geschrieben; sein Inhalt steht in Spec Abschnitt 5 („TP2“). Die Aussagen zu „nach den Plänen“ setzen also voraus, dass P05 und P11 so umgesetzt werden, wie die Spec sie beschreibt.

## 1. Gesamturteil

Wenn P05 und P11 die Spec umsetzen, erreicht der Chat in Get It Done voraussichtlich den heutigen Funktionsumfang: Aufgaben, Teams, Navigation, Filter und Rückfragen. Er ist dann strenger abgesichert und leichter zu pflegen, weil neue Routen automatisch zu Tools werden und jede Schreibaktion nachfragt. Dafür sind aber vier Punkte nötig, die heute in keinem der vier Pläne sicher stehen:
- das SDK-Paket reparieren, denn in der jetzigen Form ist es nicht installierbar,
- Labels, Bestätigungstexte und Ergebnis-Anzeigen von den alten Toolnamen lösen,
- den MCP-Katalog im SDK bauen,
- Admin-Tools in der Toolliste nach Rolle ausblenden.

Ob das Modell mit den neuen Tools so treffsicher arbeitet wie heute, ist nicht gemessen. Beim heutigen Stand der Beschreibungen und Module rechne ich ohne die Nacharbeit aus P05 eher mit einer schlechteren Tool-Auswahl.

## 2. Was sicher funktioniert

„Sicher“ heißt hier: auf echtem GID-Code in Kopien gemessen und reproduzierbar, aber ohne echten Chat.

- **Generator läuft stabil.** Auf GID gab es 0 Abstürze, und ein zweiter Lauf liefert dasselbe Ergebnis (0 hinzugefügt, 0 geändert, 0 entfernt). Aus 87 `route.ts` und 20 `page.tsx` entstehen 111 Tools: 105 Endpunkte, 1 Navigation, 5 Filter.
- **Abdeckung.** Von 73 bisherigen Endpunkt-Tools haben 72 eine passende Route mit passender Methode. Das fehlende (`get_saved_view`) ist schon auf master kaputt, weil es `GET /api/saved-views/:id` nicht gibt.
- **Der erzeugte Code passt zu GID.** `tsc` mit GIDs tsconfig meldet 0 Fehler (Next 16.1.6, zod 3.25.76, TS 5.9.3). Alle aktiven Tools werden zu AI-SDK-Tools (74 von 74 bzw. 83 von 83), alle Schema-Digests stimmen (83 von 83), und GIDs Zod-3-Schemas funktionieren, obwohl das SDK Zod 4.4.3 mitbringt. Einschränkung: Gemessen wurde nur mit einem reparierten Paket (siehe Risiko 1).
- **Rückfragen.** Alle 69 schreibenden und löschenden Tools fragen vor der Ausführung nach. Eine Lockerung auf Stufe 3 und eine Lockerung ohne Pin werden mit E-POLICY-002 abgelehnt; der Refresh schreibt dann nichts.
- **Lokale Regeln** (`tool-policy.json`): Deaktivieren, Ausschließen (`/api/mcp/**` entfernt zum Beispiel 10 Tools), Rollen (der Aufruf wird mit `principal_role_denied` abgelehnt) und eine Lockerung mit Pin bis Stufe 2 wirken wie vorgesehen.
- **Navigation und Filter.** Mit `useGlirastesNavigationBridge` sind alle 6 Tools aktiv, ohne die Brücke keins. Mit `stripSegments ['[locale]']` entstehen 17 saubere Ziele (`/tasks`, `/teams/:teamId` …).
- **Automatische Aktualisierung.** Eine neue Route mit Schema in einem Modul ohne Seiteneffekte wird sofort ein aktives Tool, und entfernte Routen verschwinden als Tool. `tools check` meldet Abweichungen mit Exit 1 und nennt die Pfade. Mit `CI=1` läuft die Prüfung ohne Netz und schreibt nichts, unter Node und Bun.
- **Dauer.** Ein Refresh dauert meist um 20 s, je nach Rechnerlast 14 bis 45 s. Die Integritätsprüfung braucht unter 1 s.
- **Anmeldung und Ausschlüsse.** `getSession` wird überall erkannt. Die 5 Fälle ohne Nachweis sind berechtigt (DSGVO-Consent, Graph-Reauthorize, MCP internal-execute). Die 17 Standardausschlüsse (Auth, STT, Webhooks, Health, Chat-Route) stimmen.
- **Alter Code.** Alle 40 alten SDK-Symbole, die GID importiert, gibt es mit gleichem Namen auch im neuen SDK. Die Props für @-Erwähnungen (`RichMentionInput`) sind vorhanden.

## 3. Was nach P05, P07b und P11 voraussichtlich funktioniert

| Fähigkeit | Heute gemessen | Nach den Plänen | Was dafür noch fehlt (Plan) |
|---|---|---|---|
| Aufgaben suchen und auflisten | `tasks_list` ist aktiv, kennt aber nur `view`; Filter nach Status, Priorität, Team, Person, Suche und Zeitraum fehlen | wie heute | Codemod `ai-tool.ts` → `contract.ts` mit denselben Zod-Schemas (Skill in P05, Lauf in P11) |
| Aufgaben anlegen, ändern, Status, zuweisen, Bulk; Team anlegen | gesperrt (19 der 72 alten Routen) | aktiv, mit Rückfrage | derselbe Codemod; Schemas müssen in Module ohne Seiteneffekte, denn in `route.ts` definierte Schemas sind nicht ladbar |
| Rückfragen vor dem Schreiben | funktioniert | funktioniert | Texte der Bestätigungskarten an die neuen Namen anpassen (in keinem Plan ausdrücklich, siehe Risiko 3) |
| Rollen | Aufruf wird abgelehnt, aber `allowedRoles` ist überall leer und Admin-Tools sind für alle sichtbar | Aufruf korrekt gesperrt | Codemod schreibt die rund 22 Rolleneinträge (P11); das Ausblenden in der Toolliste ist offen (Risiko 6) |
| Navigation | funktioniert mit Brücke | funktioniert | Brücke mit dem Router von next-intl, `stripSegments`, alte Aktion `navigate` entfernen (P11) |
| Filter | 16 Schlüssel, alle als Freitext | Auswahllisten für Status, Priorität, Zeitraum | nuqs-Parser typisieren, interne Schlüssel wie `collapsedGroups` ausblenden (P11) |
| Client-Aktionen (Dialoge öffnen usw.) | 0 erkannt wegen des alten Imports; nach Umstellung 17 erkannt, davon 5 aktiv | alle 17 aktiv | Importe auf `glirastes/react` umstellen, Zod-Vertrag für 12 Aktionen ergänzen (P11; für einen Fall gemessen, dass das freischaltet) |
| @-Erwähnungen | Grundlage vorhanden | zusätzlich aus dem Code abgeleitete Entitäten | P07b |
| /-Befehle | `/` fügt nur Text ein, das Modell führt aus | direkte Befehle ohne Modellaufruf, mit denselben Prüfungen wie ein Modell-Turn | P07b, Ersetzen der 8 fest eingebauten `UI_COMMANDS` (P11) |
| Spracheingabe | SDK-Hooks vorhanden, GIDs Deepgram-Proxy bleibt | wie heute | nur Live-Test |
| PII-Schutz | lokal ja, aus dem gepackten Paket nicht ladbar | ja | Paket reparieren (Risiko 1); Shield pro Request bauen, nicht auf Modulebene (P11) |
| Kosten pro Turn | Senke vorhanden, Kosten bleiben `null` | Kosten in USD | `usage: { include: true }` setzen und live prüfen (P11); Kosten-Dashboard erst mit P08c |
| Übersteuerung über die Platform | lokal ja, über die Platform nein | Lockerung bis Stufe 2 technisch möglich (P04b) | Verdrahtung `policyOverlay`, `platformRevisions`, `reportCapabilities` (P11), Citadel-Formular (P08c), Freigabe für Migration 0044 und Deploys |
| MCP-Server von GID | hängt an alten Registries (47 Testdateien) | bezieht den Katalog aus dem erzeugten Modul | `emit.mcpCatalog` im SDK bauen (Risiko 4); alte Pakete erst nach Paritätsnachweis entfernen |
| CI-Prüfung | technisch vorhanden | Prüfung in jedem PR | GID hat nur `deploy.yml`, P11 baut den Test-Workflow; das SDK muss installierbar sein |
| Antwortqualität | 53 Beschreibungen aus Vorlagen, Median 56 statt 288 Zeichen, 33 englische Texte in einer deutschen App, 60 abgeleitete statt 7 gepflegter Module | offen | Codemod übernimmt die deutschen Beschreibungen; Anreicherung und `tools eval` (P05); Live-Vergleich (Abschnitt 5) |

Nicht in den vier Plänen enthalten: das Kosten-Dashboard und das Platform-Formular (beide P08c) sowie die Pack-Prüfung (P13).

## 4. Risiken und Blocker

| Nr. | Problem | Folge | Gegenmaßnahme | Zuständig |
|---|---|---|---|---|
| 1 | **SDK-Paket kaputt.** In `package.json` schließt `files` die Pfade `dist/server/lancer`, `dist/codegen/format.*` und `dist/server/pii-shield/aegis-detector.*` aus, obwohl sie statisch importiert werden (selbst in `package.json` nachgeprüft). | Jeder `glirastes`-Befehl und `import 'glirastes/server'` brechen ab. Das erzeugte Modul und damit die Chat-Route würden beim Laden abstürzen, und der PII-Schutz fehlt. | Die drei Ausschlüsse streichen und einen Test ergänzen, der prüft, ob das gepackte Paket alle Importe enthält. | Die Pack-Prüfung steht erst in P13, das ist zu spät: Laut Spec nutzt P11 genau dieses Paket im Docker-Image. Als kleinen SDK-Fix vor P11 vorziehen. |
| 2 | **Kern-Schreibtools gesperrt, Filter gehen verloren.** Die Contract-Quelle `legacy-ai-tool` gibt es nur als Typname. | Der Chat kann weniger als heute. | Codemod mit denselben Zod-Schemas | P05 (Skill und Skript), P11 (Lauf) |
| 3 | **Alte Toolnamen.** 0 von 111 Modellnamen stimmen überein (`list_tasks` wird `tasks_list`). Rund 92 alte Namen hängen in `tool-labels.ts`, `approval-description.ts`, `module-meta.ts`, im System-Prompt, in `tool-result-handler.ts`, `ai-settings-tab.tsx`, den i18n-Dateien und den MCP-Paritätstests. | Labels fehlen, Bestätigungstexte werden generisch, Ergebnis-Anzeigen greifen nicht, Tests werden rot. | Die Spec bildet alte Namen nur für MCP ab. Zusätzlich die Anzeige-Dateien auf `definitionId` umstellen oder eine Zuordnung alt → neu pflegen. Die Fast-Path-Tabelle mit alten Namen zurücksetzen. | P11, muss dort ausdrücklich rein |
| 4 | **MCP-Katalog fehlt im SDK.** `emit.mcpCatalog` wird nur als Einstellung angenommen. | GIDs MCP-Server bricht, sobald die alten Registries entfernt sind. | `emit.mcpCatalog` bauen, Grants nach `definitionId` erhalten, `update_task_status` (fällt mit `update_task` auf dieselbe Route) zuordnen | `config.ts` verweist auf P11. Es ist aber SDK-Arbeit und muss in P05 oder P11 ausdrücklich als SDK-Aufgabe stehen. |
| 5 | **Zu viel freigeschaltet.** `@ai-ignore` (20 Routen) wird ignoriert. Aktiv sind unter anderem `GET /api/admin/graph-debug`, `/api/admin/tenants`, `/api/mcp/settings`, `/api/mcp/actions/open`, `DELETE /api/tenant/logo`, `GET /api/tasks/public/:publicId`. | Das Modell sieht interne Debug- und Admin-Endpunkte. | Ausschlüsse in `tool-policy.json` (`/api/mcp/**`, Admin-Debug, `performance-capture`, `tasks/interpret-filters`), Rollen per Codemod; im Generator `@ai-ignore` als Ausschluss werten | P11 (Policy), P05 (Generator) |
| 6 | **Admin-Tools für alle sichtbar.** Gemessen war `users_list` mit Policy „admin“ auch für die Rolle mitarbeiter sichtbar. | Das Modell bietet Admin-Funktionen an, der Aufruf scheitert erst danach. Heute blendet GID solche Tools pro Rolle aus. | `find_tools` in GID aktivieren (liefert laut Spec nur berechtigte Tools) oder die Toolliste vor dem Modell nach Rolle filtern | keinem Plan zugeordnet, Entscheidung in P11 |
| 7 | **Schema mit `anyOf` an der Wurzel** (`tasksInterpretFilters_create`, aktiv; nicht live geprüft) | OpenAI-kompatibles Function Calling lehnt solche Schemas meist ab. Dann scheitert jeder Chat-Turn mit 400. | Route ausschließen (sie ist intern) und im Generator prüfen, dass die Wurzel `type: object` ist | P11 (Ausschluss), P05 (Prüfung) |
| 8 | **Keine Rückmeldung in der UI nach Schreibaktionen.** `uiActionOnSuccess` (31 Tools: Toast, Liste aktualisieren, Navigation) hat kein Gegenstück. | Nach „Aufgabe anlegen“ im Chat kommt kein Toast, und die Liste zeigt den alten Stand. | `onToolResult`-Handler in GID oder eine Erweiterung im Generator | offen, steht nicht in Spec §5 |
| 9 | **Automatische Freigabe pro Nutzer** (`aiAutoApproveTools`, 10 Tools, darunter `remove_team_member` auf Stufe 3) | Die Einstellung wirkt nicht mehr und widerspricht der Regel „Stufe 3 fragt immer“. | Produktentscheidung: Funktion entfernen oder auf Platform-Lockerungen bis Stufe 2 (P04b) abbilden | Philipp |
| 10 | **Setup braucht Handarbeit.** `init` schreibt weder `tools.json` noch `prompt-bundle.json`, deshalb bricht `tools refresh` mit E-TOOLS-001 ab. `appId` muss vor dem ersten Commit die Platform-App-ID sein. | Mit einer falschen `appId` ändern sich später alle Tool-IDs. | `init` ergänzen und stille Änderungen verweigern | P05 (laut Roadmap), P11 |
| 11 | **Next 16.** Das SDK verlangt `next ^15` und ist nur mit 15.5.15 im Browser getestet. Turbopack mit SDK-CSS ist ungetestet, der Pilot erzwingt `--webpack`. | Mögliche Build- oder Darstellungsfehler | Peer-Bereich erweitern, Browsertest auf Next 16 | P11, Supportmatrix in P13 |
| 12 | **Deploy.** Das Image kopiert `.glirastes/` nicht, führt noch `ai:generate-tools` aus und hat keinen Schritt mit `integrity`. Für den Managed-Modus fehlt der Runtime-Sync. | Image ohne Tools | laut Spec P11 Punkte 4 und 7; das SDK aus einer Registry oder als repariertes Tarball | P11, Veröffentlichung P13 |
| 13 | **Kleinere Punkte** | Ohne `--strict` endet `tools check` mit Exit 0 trotz 41 Funden. Namen bekommen Hash-Suffixe (`teamsMembers_listGetR5DE6cvu`). Der PII-Shield auf master hat eine Race über gleichzeitige Requests. Der Abstand zum Pilot beträgt 90 Commits voraus und 121 zurück, 85 Dateien sind auf beiden Seiten geändert. | `ci.strict` setzen, Namen über Resolutions korrigieren, Shield pro Request bauen, P11 setzt laut Spec frisch auf master an und nutzt den Pilot nur als Vorlage | P11 |

## 5. Was erst ein Live-Test zeigt

Dafür sind Freigaben nötig: der **OpenRouter-Key von GID** (mit Budgetgrenze), eine **Wegwerf-Postgres** (lokal oder als eigener Neon-Branch), abgeschaltete oder gemockte Aufrufe an Graph, Postmark und Queues, und für STT zusätzlich der Deepgram-Key.

- **Tool-Auswahl:** Trifft das Modell mit den neuen Namen, Beschreibungen und Modulen die richtigen Tools? Das ist die wichtigste offene Frage. Vorschlag: ein fester Satz typischer deutscher Anfragen (etwa 30), gestellt an den heutigen und an den neuen Stand, mit Vergleich der Trefferquote.
- **Schemas und Tool-Menge:** Akzeptiert OpenRouter alle Schemas (`anyOf`, Risiko 7) und über 80 Tools pro Anfrage? Wie hoch sind Latenz und Tokenkosten pro Turn?
- **Schreiben gegen die Datenbank:** Aufgabe anlegen, ändern, zuweisen, Bulk, jeweils mit echten Sessions für mitarbeiter, teamleiter und admin. Dabei auch Rückfrage-Karte, Bestätigen und Ablehnen in der Oberfläche prüfen.
- **Kosten:** Kommen mit `usage: { include: true }` die USD-Kosten an, oder bleibt der Wert `null`?
- **Next 16 im Betrieb:** `next dev` und `next build` mit Turbopack, SDK-CSS, Browser-Brücke, Client-Aktionen ohne Doppelauslösung, /-Direktbefehle aus P07b.
- **Docker-Image** mit dem Paket aus Registry oder repariertem Tarball im `integrity`-Modus.
- **Deepgram live.**

Ohne Freigabe möglich und trotzdem noch offen: die MCP-Paritätstests nach der Migration und `next build` auf master mit Glirastes.

---

**Hinweise zu den Zahlen.** Die beiden Läufe unterscheiden sich in der Konfiguration, nicht im Befund:
- Unverändertes master: 65 aktive Tools. Mit `stripSegments` und `bodyReaders`: 72. Mit Brücke und umgestellten Importen jeweils 11 mehr (76 bzw. 83).
- Rollen: Ein Lauf zählt 20 Tools nur für admin und 2 für teamleiter+admin, der andere 23 plus 2.
- Alte Toolnamen: 92 bzw. 93.
- Ein Lauf meldete P07b als nicht geschrieben. Der Plan liegt inzwischen vor (`2026-10-05-mvp-plan-07b-mentions-commands.md`).

Rohdaten liegen unter `gid-probe/dry/` (Kennzahlen in `SUMMARY-numbers.json`) und `gid-probe/capreview/`.
