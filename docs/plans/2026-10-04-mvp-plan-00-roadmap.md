# Glirastes MVP-Abschluss – Roadmap der Umsetzungspläne

> **For agentic workers:** Dieses Dokument ist der Einstieg. Jeder Teilplan wird mit superpowers:subagent-driven-development (empfohlen) oder superpowers:executing-plans Task für Task umgesetzt. Teilpläne mit „ausgeschrieben“ sind vollständig; Teilpläne mit „wird geschrieben vor Start“ entstehen mit superpowers:writing-plans, sobald ihre Vorgänger abgeschlossen sind, damit sie gegen den dann tatsächlichen Code geschrieben werden.

**Goal:** Das generische Glirastes-Web-App-MVP gemäß Spec fertigstellen und abnehmen.

**Architecture:** Dreizehn Teilpläne über drei Repos (SDK, Platform, Get It Done). SDK-Arbeit läuft in eigenen Worktrees, die von `codex/glirastes-foundation-runtime` abzweigen. Die Platform-Arbeit zweigt von `codex/glirastes-foundation-control-plane` ab, die Get-It-Done-Migration von `origin/master`. Nach jedem Teilplan gibt es ein grünes Gate und einen Checkpoint-Bericht.

**Tech Stack:** TypeScript (NodeNext), Bun, Vitest, Zod v4 (SDK), Next.js 15/16, React 19, NestJS 11, Drizzle/Postgres, AI SDK v6, OpenRouter, Playwright (System-Chrome).

**Spec:** [2026-10-04-mvp-completion-design.md](2026-10-04-mvp-completion-design.md) (v1.3, freigegeben am 2026-10-04)

## Global Constraints

- Keine Pushes, Hauptbranch-Merges, npm-Veröffentlichungen, Deployments oder Änderungen an der Live-Landingpage ohne ausdrückliche Freigabe von Philipp.
- Omnify wird nicht gelesen und nicht verändert.
- TDD: erst fehlschlagender Test, dann minimale Implementierung; Commits klein, Conventional Commits, ohne KI-Attribution.
- Schutzmechanismen nicht schwächen; Kompatibilitätscode nicht pauschal löschen; GID-Agentic-Abhängigkeiten erst nach Paritätsnachweis entfernen.
- Sämtliche agentischen Aufgaben werden über ausgelieferte Skills gelöst; die CLI ruft nie ein Modell.
- Neue Tools sind sofort aktiv; GET ohne Rückfrage, POST/PUT/PATCH mit Rückfrage, Stufe 3 (`delete`, `financial`, `external`) immer mit Rückfrage; das Strengste gewinnt.
- Der OpenRouter-Key der Zielapp ist nur der Chat-Modellzugang; Secrets werden nie gelesen, ausgegeben oder in Artefakte geschrieben.
- Live-Aufrufe an OpenRouter/Deepgram nur nach Freigabe; bis dahin `MockLanguageModelV3` bzw. Fake-Media-Device.

## Review Focus

- Ein Refresh auf einem Repo mit einem unbekannten Handler-Muster darf weder Tools still verlieren noch einen veralteten Erfolg melden (P03, P05).
- Eine Platform-Übersteuerung darf nie ein Tool aktivieren, das im deployten Code fehlt, oder Stufe 3 lockern (P02, P08).
- Merge-Konflikte in generierten `.glirastes`-Dateien müssen sich durch erneuten Refresh deterministisch auflösen lassen (P03).
- Nach dem Entfernen einer Route darf ein Direktaufruf des alten Tools nicht mehr funktionieren, auch nicht über alte Overrides oder Pins (P02, P03).
- Der Pro-Job darf nur erlaubte Pfade ändern und nie in eine Commit-Schleife geraten (P10).

---

## Teilpläne

| Nr. | Teilplan | Repo / Worktree (Branch) | Abhängig von | Status |
| --- | --- | --- | --- | --- |
| P01 | [Sicherung und Hygiene](2026-10-04-mvp-plan-01-hygiene.md) | SDK, Platform, GID – jeweils bestehende Foundation-Worktrees | – | ausgeschrieben |
| P02 | [Tool-Policy und Laufzeit-Durchsetzung](2026-10-04-mvp-plan-02-tool-policy.md) | SDK `.worktrees/mvp-tools` (`codex/mvp-tools`) | P01 | ausgeschrieben |
| P03 | [Generator-Kern, Next.js-Endpunkte, CLI refresh/check/status](2026-10-04-mvp-plan-03-tools-generator-next.md) | SDK `mvp-tools` | P02 | ausgeschrieben |
| P04 | [Navigation, Filter, UI-Aktionen](2026-10-05-mvp-plan-04-navigation-filters-ui.md), `glirastes/browser`; SDK-Hälfte des Policy-Vertrags mit P08b (`RuntimePolicyRevision.toolOverrides` Standard `[]`, Overlay übernimmt Delta-Beschreibung, Artifact-`provenance`/`exclusions` mit Platform-Grenzen, `schemaSource`-Werte, Schema-Module ohne ESM-Zyklus) | SDK `mvp-tools` | P03 | ausgeschrieben |
| P04b | [Platform-Lockerungen bis Stufe 2 (D16)](2026-10-05-mvp-plan-04b-platform-relaxations.md) plus Paket-Korrektur (alle importierten Module im Paket) | SDK `mvp-tools` | P04 | ausgeschrieben |
| P05 | [Agentische Arbeit per Skills](2026-10-05-mvp-plan-05-agentic-skills.md): Arbeitslisten, einheitliche Prüfung, `tools eval`, Stufe-2-Datenmodell, sieben Skills, `init`-Anpassungen | SDK `mvp-tools` | P04b | ausgeschrieben (30 Tasks) |
| P06 | Referenz-Fixtures React+NestJS und Vue+FastAPI inkl. Änderungskorpus (18 Tests) | SDK `mvp-tools` | P05, P07 (Einbettung) | wird geschrieben vor Start |
| P07 | [Routing, Suche, Rückfragen, Chat-UI, Einbettung, STT](2026-10-04-mvp-plan-07-routing-chat-stt.md) | SDK `.worktrees/mvp-chat` (`codex/mvp-chat`) | P01 | ausgeschrieben |
| P07b | [Generisches @- und /-System](2026-10-05-mvp-plan-07b-mentions-commands.md) (Spec 6a, freigegeben): deklarative Entitäten/Befehle, direkte `ui`/`tool`-Befehle ohne Modellaufruf, Ableitung aus dem Code, React + `<glirastes-chat>` | SDK `mvp-chat` (parallel zu P04b/P05) | P07, P04, P09 | ausgeschrieben (17 Tasks) |
| P08a | [Platform-Hygiene](2026-10-04-mvp-plan-08a-platform-hygiene.md): Migrationsjournal, API-Typecheck, Citadel-ESLint, Pairing-Key-Sicherheit, Pairing-Robustheit, Aegis-Folgepunkte | Platform `.worktrees/mvp-platform` (`codex/mvp-platform`) | P01 | ausgeschrieben |
| P08b | [Platform-Backend](2026-10-05-mvp-plan-08b-platform-backend.md): begrenzte Overrides (0044), Deltas, Policy-only-Revisionen, richtungsabhängige Freigabe, Capability-Report und -Ansicht, Pro-Schalter, App-Scope-Lücken | Platform `mvp-platform` | P08a, P02 | ausgeschrieben |
| P08c | Citadel-UI im Living-Network-Design (nach Mockup-Freigabe): fünf Fragen, „Was kann mein Chat?“, Kosten, Verbinden, Historie; Regel-Formular einschränkend plus Lockern der Rückfrage bis Stufe 2 (D16), nur Abweichungen; Deutsch und Englisch; [Design](2026-10-05-citadel-living-network-design.md) | Platform `mvp-platform` | P08b, P08d, P09 Teil B, Design-Freigabe (erteilt 2026-10-05) | Design-Spec ausgeschrieben, Plan folgt |
| P08d | [Platform-Nachtrag](2026-10-05-mvp-plan-08d-platform-addendum.md) (erledigt, Gate grün): HEAD als Methode, nur Abweichungen speichern und signieren, gesperrtes Speichern, PGlite-Tests für P08b-SQL, Deploys tragen die aktuellen Entscheidungen, erneutes Anwenden nach Rollback, Rollout-Reihenfolge | Platform `mvp-platform` | P08b | ausgeschrieben |
| P09 | [Metriken (FR-7)](2026-10-05-mvp-plan-09-metrics.md): Event v2 + Senke im SDK, Ingest, Aggregation, Abfrage-API (Ansichten in P08c) | SDK `mvp-chat` (parallel zu P04) + Platform `mvp-platform` (nach P08b) | P08b | ausgeschrieben |
| P10 | Pro: Managed Tool-Generierung (Job-API, OpenRouter-Provisioning, Skill-Runner, CI-Workflow) | Platform + SDK | P05, P08 | wird geschrieben vor Start |
| P11 | Get It Done auf aktuellem `master` mit Foundation | GID `.worktrees/glirastes-mvp` (`codex/glirastes-mvp` von `origin/master`) | P05 (Generator + Migrations-Skill), P07 | wird geschrieben vor Start |
| P12 | Landingpage: Inhalte an das MVP anpassen (Inhaltsprüfung 2026-10-05), Preise (Entscheidung Philipp 2026-10-05): Free 0 €, Pro 49 € pro Monat, Enterprise „Talk to us“ ohne Preis, Euro statt USD, Hero-Animation als scharfe Code-Version (Prototyp in Arbeit) | Platform `mvp-platform` | P11, P08 belegt | wird geschrieben vor Start |
| P13 | Abnahme und Release-Vorbereitung (0.5.0, CHANGELOG, Pack-Prüfung, Supportmatrix, Nutzertest-Protokoll) | alle | alle | wird geschrieben vor Start |

## Reihenfolge und Parallelität

```
P01 ──┬── P02 ── P03 ── P04 ──┬── P05 ──┬── P06 ──┐
      │                       │         ├── P10 ──┤
      ├── P07 (parallel) ─────┘(Merge)  └── P11 ──┼── P12 ── P13
      └── P08 (Hygiene sofort; Overrides nach P02) ── P09 ──┘
```

- P07 läuft ab P01 parallel zu P02–P05 in einem eigenen Worktree und fasst `src/codegen` und `src/contracts/tool-policy.ts` nicht an.
- P08-Hygiene (Journal, Typecheck, ESLint, Pairing-Key) kann parallel zu P02 beginnen; der Override-Teil wartet auf die P02-Verträge.
- Zusammenführung der SDK-Worktrees: nach P04 und P07 werden `codex/mvp-tools` und `codex/mvp-chat` lokal in `codex/glirastes-foundation-runtime` gemergt und `mvp-tools` danach auf diesen Stand gebracht (lokale Feature-Branch-Merges, kein Hauptbranch, kein Push), damit P05 `createToolSearchIndex` nutzen kann. Merge-Checkliste (aus dem Pre-Flight-Scan): `src/runtime/tool-discovery.ts` P07-Datei behalten und die P02-Bedingung `riskTier(policy.riskClass) < riskTier(manifestTool.riskClass)` samt Import wieder einsetzen (Gate: P02-Test in `tool-discovery.test.ts`); `package.json` `build` als Vereinigung beider Änderungen; `src/runtime/index.ts` und `src/public-subpaths.test.ts` als Vereinigung; danach alle Gates.

## Gates und Checkpoints

Nach jedem Teilplan:

1. SDK: `bun run typecheck`, `bun run typecheck:tests` (ab P01), `bun run test`, `bun run build`; bei UI-Änderungen zusätzlich die Browser-Tests.
2. Platform: Citadel `tsc` + Vitest, DB `bun test`, API Vitest; ab P08 auch API-Typecheck.
3. GID: `node_modules/.bin/tsc --noEmit`, `node scripts/run-vitest.mjs`, `eslint .` (ab P01), `next build --webpack` ohne Hook.
4. Whole-Branch-Review durch einen frischen Reviewer, danach Checkpoint-Bericht an Philipp (was ist fertig, was ist offen, welche Freigaben anstehen).

## Offene Punkte aus der Planprüfung (Zuordnung)

| Punkt | Zuständiger Teilplan |
| --- | --- |
| `src/sync/local-deployment-validator.ts` lehnt eine ganze Platform-Deployment ab, wenn sie ein Tool ohne lokales Binding freischaltet; laut Spec 4.9 soll das Tool ignoriert werden (`platform-tool-not-in-code`) | P04 (vorgezogen, der gemeinsame Vertrag hängt daran) |
| `tools refresh --watch` | P05 |
| Hinweis „N Tools brauchen eine bessere Beschreibung“ am Ende jedes Refresh | P05 |
| Emit-Option für generierte `.ts`-Module mit NodeNext-Importendungen | P06 |
| `ToolContract.runtime` ist Pflichtfeld; P04 und P06 müssen es liefern | P04, P06 |
| Tool-Policy-Einträge für ausgeschlossene Routen werden zusätzlich als `policy-entry-orphaned` gemeldet | P05 |
| `typecheck:tests` als Schritt in `.github/workflows/ci.yml` des SDK | P13 |
| Signiertes Delta-Feld `RuntimePolicyRevision.toolOverrides` plus Overlay-Adapter im SDK (P02-Overlay nutzt übergangsweise volle Policy-Kopien) | P08, vor P11 |
| ~~Platform-„Lockern“ im Managed-Modus nur als wirksam anzeigen, wenn ein committeter lokaler Eintrag existiert~~ ersetzt durch D16 (Entscheidung Philipp 2026-10-05): die Runtime übernimmt signierte, an die Risikoklasse gepinnte Platform-Lockerungen der Rückfrage bis Stufe 2; eine explizite lokale Härtung gewinnt; der Code-Bericht markiert jedes explizite lokale `true` als `local-policy` (gemeinsame Golden Vectors); `capabilities` meldet die Lockerung als wirksam, sobald der Runner D16 kann | SDK: P04-Nachtrag (ändert P04 Ziel 1 und Tasks 1–3, meldet die Fähigkeit bei der Registrierung); Platform: API-Tasks von P08c (Capability-Ansicht meldet die Lockerung als wirksam, wenn der Runner sie kann) |
| CLI `tools policy <show\|disable\|enable\|confirm\|relax\|raise\|roles\|describe\|exclude\|include\|accept\|reset> <tool> [wert] [--reason]` (Spec 4.2; Spec 4.5 Lebenszyklus: codebedingte Absenkung gehalten, „bis `tools policy accept` sie übernimmt“; Spec 4.12 Zusatzkorpus „Absenkung gehalten bis accept“). P02 hält die Absenkung per Ratsche (`resolveToolPolicy`, Warnung `risk-lower-available`) und verweist die CLI nur auf einen „späteren SDK-Plan“; ohne diese Zeile hat die Freigabe der Ratsche keinen Zuständigen. Vertrag für `accept`: schreibt `acceptedRisk[stableKey] = { riskClass: <riskClass der Warnung risk-lower-available>, toolId: <aktuelle toolId> }`, nie `deriveToolPolicyDefaults().riskClass` und nie die Code-`defaults` aus `tool-contracts.json` (die Ratsche vergleicht exakt mit der geschichteten Klasse aus Code-Defaults plus lokalen/Platform-Anhebungen) | P05, vor P06 (Änderungskorpus) und P11 |
| Warnung `risk-lower-available` trägt seit P02 Task 6 (`7ddd963`) das Feld `riskClass`, die Klasse für `accept`; der Text von P02 (Task 6/7) und P03 zeigt noch die alte Form ohne `riskClass`. P03 gibt die Klasse im Hinweis (`risk-lower-available`-Remediation) und in `policyWarningMessage` aus und gibt die Code-`defaults` nicht als Akzeptanzklasse aus; der Platform-Port erzeugt und liest `riskClass` (Paritätsvektoren `tool-policy.v1.json`) | P03, P08 |
| Managed-Modus: `createLocalRuntimeSource` verlangt seit dem P02-Final-Review zusätzlich zu `policyOverlay` den Getter `platformRevisions` (Agent- und Manifest-Revision derselben akzeptierten Deployment, z. B. `MaterializedDeploymentRevisions`), damit Platform-Revocations über `agentRevisionIds` greifen (Spec 4.9 „Revocations blockieren weiterhin“). GID speist beide Getter aus derselben akzeptierten Deployment und liefert nach einer Revocation weiter die widerrufene Deployment statt `undefined`; sonst läuft der Turn auf der lokalen Basis mit abgeleiteten IDs, und Revocations über `agentRevisionIds`/`policyRevisionIds` greifen nicht. Der `toolOverrides`-Adapter behält diese Kopplung bei | P11 (Verdrahtung), P08 im Gleichschritt, vor P11 |
| `examples/source-driven-next/*.d.mts` zusammen mit den `.mjs`-Modulen entfernen | P04 |
| `glirastes init` schreibt immer `.glirastes/prompt-bundle.json` (Refresh verlangt es) | P05 |
| `createToolBindings()` ohne `ctx` (Abweichung von Spec 4.3, Kontext über `ToolContext.callEndpoint`) | P11 beachten |
| HEAD als lesendes Tool aufzählen (P03 meldet HEAD/OPTIONS als begründete Ausschlüsse) | P04 |
| `CLAUDE.md:106` im Platform-Haupt-Checkout nennt die Foundation-Worktree- und Branch-Namen; beim Merge bzw. Entfernen der Worktrees aktualisieren (P01 Task 2 als `526fcda` auf `main` erledigt, mit Freigabe) | P13 |
| Aegis: Batch-Test (`identity-group-e2e.spec.ts:537`) soll die Nachnamen-Kollision tatsächlich prüfen; Regressionstests für die `drawGroupSeed`-Aufrufe in `shieldResult`/`shieldResults`; Erschöpfungspfad von `drawGroupSeed` (≥ 400 Gruppen) | P08 |
| Kanonisches Arbeitsdokument der Platform: Aegis-Flake als behoben eintragen (`18ff671`, `39f0eeb`) | P08 |
| GID: `.planning/codebase/CONVENTIONS.md` beschreibt noch `npm run lint`/`next lint`; `eslint.config.mjs` ignoriert `.worktrees/**` nicht; `eslint-suppressions.json` beim Umstieg auf `master` neu erzeugen statt zusammenführen | P11 |
| SDK: EPERM-Toleranz auf dem Signalpfad des Test-Cleanups ohne eigenen Test; `prepare-browser`-Import in `tests/source-driven-browser.test.mjs:97` verschluckt echte Importfehler; `typecheck:tests` hängt von frischem `dist/` ab (Mapping `glirastes/*` → `src/*` erwägen) | P13 |
| Pro-Freischaltung per abgesichertem Admin-Befehl (kein DB-Handeingriff, Spec 7) | P08b, vor P10 |
| Platform-CI-Workflow (API-Typecheck, API-/Citadel-/DB-Tests, Citadel-Lint, Migration von Null) | P13 |
| `glirastes connect` übernimmt das Framework aus `tools.json` statt fest `nextjs` | P05 |
| App-Scope-Prüfung für app-gebundene Keys in `/v1/audit`, `/v1/stream`, Gate-Config, Deployment-Liste | P08b |
| Connect + Sync Ende-zu-Ende mit dem neuen Pairing-Key über den GID-Piloten (braucht Freigabe für lokale Wegwerf-Postgres) | P11/P13 |
| Platform-UI-Redesign „Living Network“ (deutlich eleganter, Wow-Effekt) in Farben und Schriften der Landingpage, Design-Abschnitt + Plan nach Freigabe des Mockups | P08c |
| Platform-Schemas für Capability-Report und `glirastes sync` akzeptieren nur GET/POST/PUT/PATCH/DELETE; seit P04 meldet das SDK HEAD als lesendes Tool | Platform-Nachtrag nach dem P08b-Gate, vor P09 Task 6 |
| `boundToolOverride` speichert unveränderte Beschreibung und No-op-Policy-Felder als Entscheidung; mit P04 ersetzt eine signierte Beschreibung im Managed-Modus die lokale/Code-Beschreibung, ein Dashboard-Speichern würde sie einfrieren. Platform verwirft No-op-Felder; P08c speichert nur Abweichungen | Platform-Nachtrag (mit HEAD), P08c, vor P11 |
| Registrierter `discoveryDigest` deckt nur das Endpunkt-Inventar ab; UI-Beobachtungen und wirksame Policy ändern ihn nicht, die Capability-Ansicht kann für ältere Builds neuere UI-Tools zeigen. Digest über das ganze Artefakt; bis dahin beschriftet P08c `codeVersion` als Endpunkt-Inventar-Version | P05/P13 mit P08b/P10, P08c |
| `tools.json.appId` muss die Platform-App-ID sein, bevor der erste Refresh committet wird (Tool-IDs leiten sich davon ab); `init`/`connect` schreiben sie und verweigern stille Änderungen; `reportCapabilities()` wird einmal nach der ersten Registrierung aufgerufen | P05, P11 |
| `scanAppSources` überspringt `build`/`dist`/`out`/`generated`/`coverage` in jeder Tiefe; Registrierungen dort fehlen ohne Warnung. Auf die Quellwurzel einschränken oder warnen | P05 |
| Metrik-Ingest zählt gegen das Free-Management-Rate-Limit (ab ~25 Instanzen pro Key 429 und verworfene Batches); Retention folgt dem aktuellen Plan, ein Pro→Free-Wechsel löscht beim nächsten Prune Stunden-Historie älter als 30 Tage (Produktentscheidung offen) | P09-Checkpoint, Philipp |
| Neuer Event-Typ `tool_contract_rejected` (Spec 4.7) im Gleichschritt mit neuen Vektoren und neuem Digest auf beiden Seiten | P05 |
| Skill `integrating-glirastes-nextjs`: „Der normale Chat-Pfad macht keine Control-Plane-Anfrage“ braucht die Connected-Ausnahme für Metriken und den Verdrahtungsschritt (eine Senke pro Prozess) | P05 |
| Direkte @-/-Befehle ohne Modellaufruf umgehen den Metrik-Recorder: aufzeichnen oder ausdrücklich nicht als Turn zählen; `create-ai-chat-handler.ts` wird von P09 und P07b geändert | P07b |
| Zusammenführung `codex/mvp-chat` + `codex/mvp-tools` nach P04/P09: `src/runtime/index.ts` und `src/contracts/index.ts` als Vereinigung | Controller (Merge) |
| P10 nimmt Migration `0046` (P09 belegt `0045_runtime_metrics`; Spec 4.10.11 nennt noch `0045_tool_generation_jobs`) | P10 |
| GID-Verdrahtung: Delta-Overlay (`policyOverlay`), `reportCapabilities()`, Navigation-Bridge, eine Metrik-Senke pro Prozess, generierte Formen im eigenen `uiActionSchema`; `glirastes.*`-Aktionen nicht doppelt ausführen; Live-Prüfung der OpenRouter-Kosten (`usage: { include: true }`) | P11 |
| Transport-Probe vor dem Merge nach `main`: neon-http kann keine Transaktionen, der Branch hat 23 Transaktionsstellen; CWS nutzt ab P08d `DATABASE_TRANSPORT=neon-websocket` (nie unter Bun im Docker-Image erprobt). API-Image unter Bun mit neon-websocket gegen lokale Postgres hinter einem Neon-WebSocket-Proxy starten und eine Transaktionsroute aufrufen (z. B. `PATCH …/tools/:toolId`); der Smoke-Test prüft nur `GET /` | P13 (vor jedem Merge nach `main`) |
| Produktion: Redis führt die neuen Repeatable-Jobs `runtime-metrics-aggregate` und `runtime-metrics-prune` aus; `0045_runtime_metrics` braucht PostgreSQL ≥ 15 (`UNIQUE NULLS NOT DISTINCT`, Philipp prüft `select version()`) | Rollout, Philipp |
| GID-Messung 2026-10-05 ([Bewertung](2026-10-05-gid-readiness-assessment.md)): gepacktes SDK ist kaputt (`files` schließt `dist/server/lancer`, `dist/codegen/format.*`, `dist/server/pii-shield/aegis-detector.*` aus, die statisch importiert werden) — Fix plus Test auf Import-Vollständigkeit des Packs | P04b (vorgezogen aus P13) |
| GID-Messung: `// @ai-ignore` als Ausschluss werten; Input-Schema-Wurzel muss `type: object` sein (sonst `needs_attention`); `emit.mcpCatalog` im SDK bauen (Grants nach `definitionId`, zwei alte Namen auf einer Route) | P05 |
| GID-Messung: Anzeige-Dateien von GID (Labels, Freigabetexte, Ergebnis-Renderer, System-Prompt, i18n, MCP-Paritätstests) hängen an rund 92 alten Toolnamen — auf `definitionId` umstellen oder Zuordnung alt → neu; Tools, die die Rolle nicht aufrufen darf, vor dem Modell ausblenden (`find_tools` oder Rollenfilter); Rückmeldung nach Schreibaktionen (`uiActionOnSuccess`: Toast, Liste neu laden); Next 16 im Peer-Bereich und Browsertest; Docker-Image mit `.glirastes/` und `integrity`-Schritt | P11 (SDK-Anteile ggf. P05) |
| GID: Einstellung `aiAutoApproveTools` (Auto-Freigabe pro Nutzer, 10 Tools, darunter `remove_team_member` auf Stufe 3) widerspricht „Stufe 3 fragt immer“ — entfernen oder auf Platform-Lockerung bis Stufe 2 abbilden | Entscheidung Philipp, vor P11 |
| Direkte @-/-Befehle zählen als Turns mit `model: null` und unbekannten Kosten; die Platform-Aggregation soll Turns ohne Modell als bekannte 0 zählen, sonst zeigt Citadel „mind.“ und wachsende „Anfragen ohne Kostenangabe“ | P08c (API) / P09-Nachtrag |
| Ingest-Kontingent pro Tenant (heute nur Rate-Limit pro Key) vor breiter Öffnung der Free-Registrierung | P13 |
| Client-Aktion zählt nur als schreibend, wenn der Handler direkt `fetch`/`axios` aufruft; Schreiben über Helfer, Server Actions oder Mutation-Hooks markiert die Skill-Arbeitsliste | P05 |

## Freigaben, die unterwegs eingeholt werden

| Wann | Freigabe |
| --- | --- |
| nach P01 | Backup-Push der drei lokalen Foundation-Branches auf eigene Remote-Branches |
| vor Live-Evals (P05, P07, P11) | Nutzung des OpenRouter-Keys von Get It Done für Live-Läufe |
| vor P10-Live-Test | Einrichtung eines OpenRouter-Provisioning-Keys durch Philipp |
| P11/P13 | Merges in Hauptbranches, npm-Veröffentlichung 0.5.0, Deployments |
