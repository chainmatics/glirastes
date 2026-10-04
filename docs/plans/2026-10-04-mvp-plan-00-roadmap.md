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
| P04 | Navigation, Filter, UI-Aktionen, `glirastes/browser` | SDK `mvp-tools` | P03 | wird geschrieben vor Start |
| P05 | Agentische Arbeit per Skills: Arbeitslisten, einheitliche Prüfung, `tools eval`, Stufe-2-Datenmodell, sieben Skills, `init`-Anpassungen | SDK `mvp-tools` | P04, P07 (Merge vorher) | wird geschrieben vor Start |
| P06 | Referenz-Fixtures React+NestJS und Vue+FastAPI inkl. Änderungskorpus (18 Tests) | SDK `mvp-tools` | P05, P07 (Einbettung) | wird geschrieben vor Start |
| P07 | [Routing, Suche, Rückfragen, Chat-UI, Einbettung, STT](2026-10-04-mvp-plan-07-routing-chat-stt.md) | SDK `.worktrees/mvp-chat` (`codex/mvp-chat`) | P01 | ausgeschrieben |
| P07b | Generisches @- und /-System (Spec 6a, freigegeben): deklarative Entitäten/Befehle, direkte `ui`/`tool`-Befehle ohne Modellaufruf, Ableitung aus dem Code, React + `<glirastes-chat>` | SDK `mvp-tools` (nach Merge von P07) | P07, P04 | wird geschrieben vor Start |
| P08a | [Platform-Hygiene](2026-10-04-mvp-plan-08a-platform-hygiene.md): Migrationsjournal, API-Typecheck, Citadel-ESLint, Pairing-Key-Sicherheit, Pairing-Robustheit, Aegis-Folgepunkte | Platform `.worktrees/mvp-platform` (`codex/mvp-platform`) | P01 | ausgeschrieben |
| P08 | Platform (P08b): Hygiene (Journal, API-Typecheck, ESLint, Pairing-Key), begrenzte Overrides (0044), Policy-Revisionen, Capability-Report/-Ansicht, `/connect` und `/manage` nach den fünf Fragen | Platform `.worktrees/mvp-platform` (`codex/mvp-platform`) | P01 (Hygiene), P02 (Verträge) | wird geschrieben vor Start |
| P09 | Metriken (FR-7): Event v2 + Senke im SDK, Ingest, Aggregation, Dashboard | SDK `mvp-tools` + Platform `mvp-platform` | P08 | wird geschrieben vor Start |
| P10 | Pro: Managed Tool-Generierung (Job-API, OpenRouter-Provisioning, Skill-Runner, CI-Workflow) | Platform + SDK | P05, P08 | wird geschrieben vor Start |
| P11 | Get It Done auf aktuellem `master` mit Foundation | GID `.worktrees/glirastes-mvp` (`codex/glirastes-mvp` von `origin/master`) | P05 (Generator + Migrations-Skill), P07 | wird geschrieben vor Start |
| P12 | Landingpage | Platform `mvp-platform` | P11, P08 belegt | wird geschrieben vor Start |
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
| `src/sync/local-deployment-validator.ts` lehnt eine ganze Platform-Deployment ab, wenn sie ein Tool ohne lokales Binding freischaltet; laut Spec 4.9 soll das Tool ignoriert werden (`platform-tool-not-in-code`) | P05 |
| `tools refresh --watch` | P05 |
| Hinweis „N Tools brauchen eine bessere Beschreibung“ am Ende jedes Refresh | P05 |
| Emit-Option für generierte `.ts`-Module mit NodeNext-Importendungen | P06 |
| `ToolContract.runtime` ist Pflichtfeld; P04 und P06 müssen es liefern | P04, P06 |
| Tool-Policy-Einträge für ausgeschlossene Routen werden zusätzlich als `policy-entry-orphaned` gemeldet | P05 |
| `typecheck:tests` als Schritt in `.github/workflows/ci.yml` des SDK | P13 |
| Signiertes Delta-Feld `RuntimePolicyRevision.toolOverrides` plus Overlay-Adapter im SDK (P02-Overlay nutzt übergangsweise volle Policy-Kopien) | P08, vor P11 |
| Platform-„Lockern“ im Managed-Modus nur als wirksam anzeigen, wenn ein committeter lokaler Eintrag existiert | P08 |
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
| Platform-UI-Redesign „Living Network“ (deutlich eleganter, Wow-Effekt), Design-Abschnitt + P08b-Plan nach Freigabe des Mockups | P08b |

## Freigaben, die unterwegs eingeholt werden

| Wann | Freigabe |
| --- | --- |
| nach P01 | Backup-Push der drei lokalen Foundation-Branches auf eigene Remote-Branches |
| vor Live-Evals (P05, P07, P11) | Nutzung des OpenRouter-Keys von Get It Done für Live-Läufe |
| vor P10-Live-Test | Einrichtung eines OpenRouter-Provisioning-Keys durch Philipp |
| P11/P13 | Merges in Hauptbranches, npm-Veröffentlichung 0.5.0, Deployments |
