# Glirastes MVP-Abschluss: Design

Version: 1.1 · Stand: 2026-10-04 · Status: Entwurf zur Freigabe durch Philipp

Grundlage: [MVP-Scope v1.2](2026-09-13-mvp-scope-and-requirements.md), [Fokussiertes MVP](2026-09-13-focused-mvp-design.md), Platform-Design [Local, Connected Free, Managed](/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/docs/plans/2026-08-14-local-connected-managed-platform-design.md). Dieses Dokument ersetzt keine dieser Quellen, sondern legt fest, wie das MVP fertiggestellt wird. Wo es abweicht, ist das ausdrücklich markiert.

## 1. Auftrag und Verständnis

### Was Philipp gesagt hat (2026-10-04)

- Alle MVP-Ziele abschließen; „es soll alles reibungslos laufen“; die erforderlichen Tests fahren.
- Tools ziehen bei Codeänderungen automatisch nach. Wo das deterministisch nicht geht, übernimmt ein Agent, der über **OpenRouter** läuft.
- Auslöser: **lokal bei dev/build plus CI-Prüfung**. Ergebnisse werden mit dem Code committet, Deploys bleiben reproduzierbar.
- Neue Tools: **sofort aktiv**, immer mit den App-Rechten des eingeloggten Nutzers; schreibende und löschende Tools erhalten automatisch eine Rückfrage vor der Ausführung.
- Übersteuerungen und Freigaben: **lokal (CLI/committete Datei) und in der Platform**.
- **Omnify wird vorerst nicht angefasst.**

### Annahmen (korrigierbar)

- „Die Ziele“ sind FR-1 bis FR-8, die Usability- und Release-Abnahme sowie die Landingpage aus dem MVP-Scope v1.2.
- Die Leitplanken des Codex-Goals gelten weiter: TDD in isolierten Worktrees, Schutzmechanismen nicht schwächen, Kompatibilitätscode nicht pauschal löschen, GID-Agentic-Abhängigkeiten erst nach Paritätsnachweis entfernen, **keine Pushes, Hauptbranch-Merges, Veröffentlichungen oder Deployments ohne ausdrückliche Freigabe**.
- Abweichung vom Scope v1.2: Die Referenz „React mit getrenntem Backend“ wird durch eine **Fixture-App im SDK-Repo** (React + NestJS) nachgewiesen, nicht durch Omnify.

### Erfolgskriterien

1. Frisches Next.js-Projekt: `glirastes init` bis zur ersten erfolgreichen, autorisierten Tool-Aktion in unter fünf Minuten (Agent-, Download- und Eingabezeit getrennt ausgewiesen).
2. Für alle drei Referenzintegrationen (Get It Done, React+NestJS-Fixture, Vue+FastAPI-Fixture): Endpunkt, Navigation und Filter jeweils hinzufügen, ändern und entfernen; nach `dev`/`build` entsprechen die Tools dem Code, ohne manuelle Katalogpflege; CI erkennt veraltete Tools.
3. Get It Done läuft auf aktuellem `origin/master` mit Glirastes Foundation, ohne Verlust von App-Funktionen (inkl. MCP-Server und Teams); Agentic-Abhängigkeiten entfernt.
4. Routing, Chat und STT erfüllen FR-3 bis FR-5 in Browser-Tests.
5. Die Platform beantwortet die fünf Nutzerfragen verständlich und zeigt Basismetriken (FR-6, FR-7).
6. Alle Testsuiten, Typechecks, Lints und Produktionsbuilds der drei Repos sind grün; Rollback ist nachgewiesen.
7. Landingpage stimmt mit dem belegten Produkt überein.

Der in Scope §6 geforderte **echte Nutzertest ohne mündliche Hilfe** kann nur von Menschen durchgeführt werden. Ich liefere automatisierte Browser-Walkthroughs und ein Testprotokoll-Template; die Durchführung bleibt bei Philipp.

## 2. Ausgangslage (Baseline 2026-10-04, frisch reproduziert)

| Repo / Worktree | Ergebnis | Befunde |
| --- | --- | --- |
| SDK `foundation-runtime-v1` @362b4aa | Install, Build, Typecheck grün; **1.079/1.079 Tests**; `verify-agent-entry` grün; Next-Browser-Referenz grün (dev und production) | Test-Cleanup-Helper flaky auf macOS (`kill EPERM` bei Zombie-Gruppen); 92 Typfehler in Testdateien (nicht im Gate); `server/testing` per CJS nicht ladbar |
| Get It Done Pilot @56a8590 | Install, `tsc` grün; **1.000/1.000 Tests** mit 30-s-Timeout; `next build` grün (ohne Hook) | 2 lastempfindliche Tests mit 5-s-Default; `bun.lock` für `file:`-SDK veraltet (bun erkennt es nicht); `lint` kaputt (`next lint` entfällt in Next 16, keine ESLint-Config auf dem Branch); `platform-connection.json` nicht gitignored |
| Platform `foundation-control-plane-v1` @4e8f807 | Citadel `tsc` grün, **250/250**; DB **90/90**; API **1.125/1.136** (10 umgebungsbedingt übersprungen, 1 flaky) | **API-Typecheck läuft nicht durch** (Instanziierungsexplosion in `advisor.tools.ts`), ohne Advisor 103 Typfehler, `nest build` mit `noCheck`; **Drizzle-Journal endet bei 0035**, 0036–0043 nur manuell angewendet; Snapshots enden bei 0029; Aegis-Pseudonym-Kollision flaky (2–4 %); keine ESLint-Config |

Weitere bekannte Defekte aus der Bestandsaufnahme: GID-Deploy kaputt (Key-Name `GLIRASTES_RUNTIME_API_KEY` vs. `GLIRASTES_API_KEY`, `file:`-Abhängigkeit im Docker-Build, leere `.glirastes` im Image), `/connect` ohne Pairing-Einstieg, kein Deny im Pairing, Pairing-Key mit `management`-Scope ohne Ablauf (plausibel), FR-7 nicht begonnen, Landing seit 27.04. unverändert. Alle Foundation-Branches existieren nur lokal.

## 3. Teilprojekte und Reihenfolge

| TP | Inhalt | Anforderungen | Abhängig von |
| --- | --- | --- | --- |
| TP0 | Stand sichern, Hygiene, Testbasis stabilisieren | Release-Gate | – |
| TP1 | Code-getriebene Tool-Synchronisierung inkl. OpenRouter-Agent, Risiko-Defaults, Policy, Referenz-Fixtures | FR-1, FR-2, FR-8 (generisch) | TP0 |
| TP2 | Get It Done auf aktuellem `master` mit Foundation | FR-8, FR-2 (GID) | TP1-Kern |
| TP3 | Routing, Suche, Rückfragen, Chat-UI, Einbettung, STT | FR-3, FR-4, FR-5 | TP0 (parallel zu TP1 möglich) |
| TP4 | Platform: fünf Fragen, Capabilities, Overrides, Metriken, Platform-Hygiene | FR-6, FR-7 | TP1-Verträge |
| TP5 | Landingpage | Landing | TP1–TP4 belegt |
| TP6 | Abnahme, Release-Vorbereitung, Dokumentation | Release | alle |

TP1 und TP3 laufen in getrennten Worktrees parallel; TP2 und TP4 starten, sobald die TP1-Verträge (Policy, Overlay, Generator-Ausgaben) stehen.

## 4. TP1 – Code-getriebene Tool-Synchronisierung

### 4.1 Überblick

Ein SDK-Generator leitet bei `dev` und `build` alle Endpunkt-, Navigations- und Filter-Tools deterministisch aus dem App-Code ab. Er nutzt die vorhandenen Bausteine weiter (`reconcileExecutionInventory` mit Tombstones, Setup-Artifact, `applySetupPlan`/`writeArtifactSetAtomically`, `discoverFoundationExecutions`) und schreibt **byte-reproduzierbare, committete Artefakte**. CI prüft sie im Frozen-Modus, Docker nur ihre Digest-Kette. Lokal löst ein OpenRouter-Agent die Befunde, die der Generator benennt, und reichert Beschreibungen und Schemas an; er liefert nur Daten zurück und entscheidet nie über Ausführbarkeit. Eine begrenzte Policy (lokal oder per signiertem Platform-Delta) kann Tools nur einschränken oder justieren, die der deployte Code besitzt.

Die Ermittlung läuft in **zwei Stufen**:

- **Stufe 1 – deterministisch (Existenz und Sicherheit):** welche Tools es gibt, Identität, Methode/Pfad, Eingabe-Schlüssel, Auth-Evidenz und Risiko. Reproduzierbar, in CI ohne Key prüfbar; entscheidet allein über Ausführbarkeit. Der Agent darf hier nur Vorschläge machen, die der Generator gegen den Code bestätigt (4.6).
- **Stufe 2 – agentisch (Verständnis und Qualität):** Beschreibungen, typisierte Ein- und Ausgabeschemas, Parameterbeschreibungen, Synonyme, Modulzuordnung, Anzeigetexte, Rückfragehinweise und Beispielsätze – besonders für Endpunkte ohne Zod, OpenAPI oder vergleichbare Doku. Läuft lokal über OpenRouter, Ergebnisse werden committet und durch eine deterministische Routing-Prüfung abgesichert (4.7). Ohne Stufe 2 bleiben Tools aktiv, aber mit sichtbar schwächerer Beschreibung.

Datenfluss:

```
App-Code + Eingabedateien
  → Quellen (observe) → Vertragsstufen → reconcileExecutionInventory (Inventar + Tombstones)
  → discoverFoundationExecutions (Befunde müssen leer sein)
  → deriveToolPolicyDefaults → resolveToolPolicy (Defaults ⊕ tool-policy.json ⊕ vorheriger Stand)
  → Semantik/Prosa → AppSetupArtifact → createSetupPlan (neue Klasse „added“) → atomarer Schreibvorgang + generiertes Modul
Laufzeit: generiertes Modul → createContractBindings (Digests beim Boot neu berechnet) → lokale Runtime
          (managed: dieselbe lokale Basis + verifiziertes, nur einschränkendes Platform-Overlay; pro Turn gepinnt, kein Platform-Call pro Turn)
```

### 4.2 CLI

Neuer Befehl `glirastes tools` (Subcommand-Parsing in `src/cli/commands/tools/index.ts`, damit der Guard-Test gegen das Literal `generate` in `src/cli/index.ts` bestehen bleibt; `tools` lädt nie implizit `.env`):

| Befehl | Zweck |
| --- | --- |
| `tools refresh [--keep-going] [--resolve] [--adopt <inventory>] [--watch] [--json]` | Tools aus dem Code neu ableiten und schreiben |
| `tools check [--strict] [--integrity-only] [--json]` | Frozen-Refresh: schreibt nie, kein Modell, kein Netz |
| `tools status [--json]` | Lokales „Was kann mein Chat?“ |
| `tools resolve [--print] [--max-items] [--budget-usd] [--model] [--retry] [--yes]` | OpenRouter-Agent für offene Befunde; `--print` liefert eine Arbeitsliste für einen vorhandenen Coding-Agenten |
| `tools describe [<tool>…\|--all] [--retry] [--write-contracts] [--budget-usd]` | Stufe 2: agentische Anreicherung von Beschreibung und Schema |
| `tools eval [--json]` | Deterministische Routing-Prüfung mit den Beispielsätzen (kein Modell, CI-fähig) |
| `tools policy <show\|disable\|enable\|confirm\|relax\|raise\|roles\|describe\|exclude\|include\|accept\|reset> <tool> [wert] [--reason]` | Lokale Übersteuerung |
| `tools verify <tool\|--all>` | Entwickler bestätigt einen beschreibenden Vertrag nach Review |

Modus: Flag → `GLIRASTES_TOOLS_MODE` (`write`/`frozen`/`integrity`) → `CI` gesetzt ⇒ `frozen` → sonst `write`. Damit sind die Paketskripte überall gleich: lokal schreiben, in CI prüfen, im Docker-Build (`ENV GLIRASTES_TOOLS_MODE=integrity`) nur die Digest-Kette verifizieren.

### 4.3 Dateien im App-Repo (`.glirastes/`, alle committet)

Eingaben (von Menschen, `init` oder dem Agenten geschrieben; `refresh` überschreibt sie nie):

- `tools.json`: `{schemaVersion, appId, targetAppKey, locale, sources:[…], emit:{module?, mcpCatalog?}, agent:{model?, consent?, auto?, budget?, keyEnvFile?}, ci:{strict?}}`
- `tool-policy.json`: Übersteuerungen und Ausschlüsse (schreibt nur der Entwickler bzw. die CLI, nie der Agent)
- `tool-resolutions.json`: deklarative Konventionen (`handlerWrappers`, `bodyReaders`, `authHelpers`, `filterValues`) und Verträge pro Tool – nur Daten
- `tool-semantics.json`: Prosa und Anreicherung pro `stableKey` (bestehendes GID-Format, erweitert um Herkunft je Feld `human`/`code`/`agent`, `locked`, Synonyme, verwandte Module, Rückfragehinweise und Beispielsätze). Von Hand gepflegte oder gesperrte Felder überschreibt der Agent nie.
- Optionale Vertragsmodule im App-Code: `<route-dir>/contract.ts` (Next; Geschwisterdatei, weil Next die Exporte von `route.ts` typprüft), `<name>.contract.ts` (Nest), drittes Argument von `useAiClientAction`

Ausgaben (gehören dem Generator, werden byte-geprüft):

- `foundation-execution-inventory.json` (v2, plus optional `sourceKind`), `tool-tombstones.json`
- `tool-contracts.json` (nur lokal, nie synchronisiert): Vertrag, Herkunft, `interfaceDigest`, Defaults pro Tool
- `tool-report.json` (inhaltsfrei): Befunde, Ausschlüsse, Agent-Versuche, Ledger
- `setup-artifact.json` (jetzt committet, deterministische IDs), `build/runtime-manifest.json` (+`policyDigest`), `build/prompt-manifest.json`, `setup-receipt.json`
- Generiertes Modul `src/generated/glirastes/tools.generated.ts` (TS-Apps) bzw. `.glirastes/build/tools.generated.mjs` (Node-Sidecar) mit `toolCatalog`, `createToolBindings(ctx)`, `GeneratedToolId` und optional `mcpEndpointCatalog`

### 4.4 Deterministische Erkennung

**Aufzählung (vollständig oder Abbruch).** Quellen: Next-Routen (`scanNextAppRoutes`), Nest-Controller (Decorators über den TypeScript-Checker), FastAPI über den OpenAPI-Export plus eine SDK-eigene `ast`-Zählung (`python3 -I`, importiert die App nie; versteckte Routen werden zu Befunden), Seiten (`app/**/page.*`, react-router-/vue-router-Konfiguration) und UI-Aktionen (literale IDs an `useAiClientAction`, `registerAiClientAction`, `bus.subscribeById`, auch in `.vue`-`<script>`-Blöcken). Jedes Element endet als Tool, als deaktiviertes `needs_attention`-Tool mit erhaltener Identität oder als begründeter Ausschluss. Nichts wird still verworfen. Unvollständige Aufzählung (`export *`, unlesbare Datei) ⇒ `E-INVENTORY-011`, nichts wird geschrieben.

**Vertragsstufen (erste passende gewinnt):**

1. Nativ und tragend: Handler validiert mit exportiertem Zod-Schema (`parse`/`safeParse`/`parseAsync`/`safeParseAsync`); Rolle (Body/Query/Pfad) per Datenfluss im Handler; deklarierte `handlerWrappers`/`bodyReaders` erweitern das. Nest: `ZodValidationPipe`/`createZodDto`. FastAPI: Pydantic über OpenAPI.
2. Vertragsmodul (tragend, wenn der Handler es importiert; sonst beschreibend).
3. Legacy `ai-tool.ts`/`ai-ui-tool.ts` (nur lesend, für die Migration; beschreibend).
4. Eintrag in `tool-resolutions.json` (`schemaRef` auf exportiertes Zod-Schema bevorzugt, sonst JSON-Schema; beschreibend).
5. Abgeleiteter schwacher Vertrag (Standard an): Pfadparameter, Query-Keys aus `searchParams.get/getAll`, Body-Keys aus geschlossener Destrukturierung; Warnung `contract-derived`. Der Endpunkt validiert weiterhin selbst.
6. Sonst `needs_attention: input-contract-unresolved`.

Beschreibende Verträge sind an `interfaceDigest` gebunden (Methode, Pfad, Parameter, Query-Keys, Schema-Bindungen, Body-Keys; Fallback Handler-Text). Abweichung ⇒ `contract-stale`, Tool deaktiviert und sichtbar. Kosmetische Änderungen machen nichts veraltet.

Schema-Probe: exportierte Schema-Module werden in einem Kindprozess importiert (Umgebung auf `PATH`/`NODE_ENV`/`TZ` reduziert, 10 s Timeout, kein Shell). JSON-Schema über das Zod der App (v4 `z.toJSONSchema`, v3 `zod-to-json-schema`).

**Navigation und Filter (generisch, ohne App-Handler).** `ui.navigate` mit `destination`-Enum aus dem Seitenbaum (ohne Route-Groups, `_private`, `api`, `stripSegments` wie `[locale]`, Standard-Ausschlüsse Login/Callback/MCP und Policy-Ausschlüsse). `ui.filter.<view>` aus nuqs-Parsern (`parseAsStringLiteral` ⇒ Enum, `parseAsInteger`, `parseAsArrayOf`, `parseAsString` ⇒ offen + `filter-domain-open`), typisierten `searchParams`, `useSearchParams().get` oder `defineQueryFilters` (SPA). Ausführung über die Brücke `useGlirastesNavigationBridge({push})` bzw. `registerNavigationBridge({push})`. Andere UI-Aktionen: Payload aus dem Vertragsargument oder dem Parametertyp; untypisiert ⇒ `ui-action-payload-untyped`.

**Identität und Namen.** `toolId` ausschließlich aus `reconcileExecutionInventory` (UUIDv5 inkl. Tombstone-Generation; Wiederauftauchen ⇒ neue ID). `definitionId`: Vertrags-ID → vorheriges Inventar → abgeleitet (`<resource>.list|get|create|update|delete`). Ein bekanntes, weiterhin aufgezähltes, aber unaufgelöstes Tool behält seine ID mit `enabled:false`.

**Prosa ohne Modell (Fallback).** Beschreibung aus JSDoc → Vertrag/OpenAPI → `.describe()` → `tool-semantics.json` → Locale-Vorlage (`description-templated`). Damit blockiert fehlende Prosa nie die Aktivierung. Vorlagen und reine Feldnamen-Verträge sind nur die Untergrenze; Stufe 2 (4.7) ersetzt sie.

**Reproduzierbarkeit.** `artifactId`/`runId` = UUIDv5 aus App und Inhaltsdigest; `generatedAt` bleibt bei unverändertem Inhalt; kanonisch sortiertes JSON. `check` nutzt weder Uhr, Zufall noch Netz.

**Fehlerbilder.** Ganzer Refresh scheitert (nichts geschrieben; in `dev` mit `--keep-going` Exit 0 und alte Artefakte bleiben): unvollständige Aufzählung, Identitätskonflikt, ungültige Policy. Pro Tool `needs_attention` (deaktiviert, sichtbar): unaufgelöst, Rolle unklar, Schema nicht exportiert/ladbar, Parameterkollision, Payload untypisiert, keine Auth-Evidenz, Handler fehlt, Vertrag veraltet. Warnungen: `contract-derived`, `description-templated`, `output-contract-opaque`, `filter-domain-open`, `override-lapsed-risk-raised`, `risk-lower-available`, `policy-entry-orphaned`.

### 4.5 Risiko-Defaults und Policy-Grenzen

Defaults (`src/contracts/tool-policy.ts`, `RULES_VERSION 1`, mit Golden Vectors):

| Eingang | operationGroup | riskClass | Rückfrage |
| --- | --- | --- | --- |
| UI-Aktion | ui | safe-read | nein |
| GET / HEAD | read | safe-read | nein |
| POST | create | write | ja |
| PUT / PATCH | update | write | ja |
| DELETE | delete | delete | ja |
| unbekannt | update | write | ja |

Eskalationen (nur nach oben): destruktive Tokens im Pfad (`delete`, `remove`, `destroy`, `purge`, `permanent`, `revoke` …) bei Nicht-GET ⇒ `delete`; deklarierter Effekt (`write`, `destructive`, `external`, `financial`, `x-glirastes-effect`) ⇒ entsprechende Klasse; Evidenz für Kindprozesse/dynamischen Code ⇒ `external`; UI-Handler mit nachweisbarem schreibendem Fetch ⇒ `write`. `unknown` wird nicht mehr erzeugt. `allowedRoles` ist standardmäßig leer: Es gilt die Autorisierung des Endpunkts. Keine Auth-Evidenz ⇒ `needs_attention`. Standard-Ausschlüsse: `/api/auth/**`, Webhooks, Cron, Callbacks, Health, Catch-all, Chat- und STT-Handler.

Grenzen (eine reine Funktion `resolveToolPolicy`, im SDK und portiert in die Platform, gemeinsame Golden Vectors):

- `riskClass`: nur anheben.
- Rückfrage: Stufe 0–1 frei; Stufe 2 (`write`) standardmäßig an, Lockerung nur per expliziten, reviewten Eintrag mit `atRiskClass:'write'`; Stufe 3 (`delete`, `financial`, `external`) **immer an**, auch die Runtime erzwingt das.
- `enabled`: jede Ebene darf deaktivieren; wirksam = Code ∧ lokal ∧ Platform. Nichts aktiviert ein `needs_attention`-, ausgeschlossenes oder fehlendes Tool.
- `allowedRoles`: nur einschränken (Schnittmenge).
- Beschreibung/Modul/Hinweise/Darstellung: frei, begrenzt, inhaltsgeprüft; Vorrang Platform > lokal > Code.
- Schutzfelder über alle Ebenen: **das Strengste gewinnt.**

Lebenszyklus:

- **Neues Tool:** Defaults plus ggf. Policy-Eintrag, sofort aktiv (außer `needs_attention`). `compareArtifacts` erhält die Klasse `added` ohne Bestätigungspflicht; `loosening` nur durch eine committete Lockerung (der reviewte Eintrag ist die Bestätigung).
- **Geändertes Tool:** Risikoanstieg wird automatisch übernommen; eine gespeicherte Lockerung unterhalb der neuen Stufe verfällt. Codebedingte Absenkung wird gehalten (Ratsche, Warnung `risk-lower-available`), bis `tools policy accept` sie übernimmt.
- **Entferntes Tool:** Tombstone, kein Binding, nach dem nächsten Build/Neustart nicht ausführbar; Wiederauftauchen bekommt eine neue ID, alte Overrides leben nicht wieder auf.

`tool-policy.json`:

```json
{ "schemaVersion": 1,
  "tools": { "<stableKey>": { "enabled": false, "requiresApproval": true, "riskClass": "delete",
                               "allowedRoles": ["admin"], "description": "…", "reason": "…",
                               "pin": { "toolId": "<uuid>", "atRiskClass": "write" } } },
  "exclude": [ { "match": "POST /api/internal/**", "reason": "internal" } ],
  "acceptedRisk": { "<stableKey>": { "riskClass": "write", "toolId": "<uuid>" } } }
```

### 4.6 Agent über OpenRouter (gemeinsamer Harness, Stufe-1-Befunde)

Der Harness erledigt zwei Aufgaben: **Befunde auflösen** (`tools resolve`, dieser Abschnitt) und **anreichern** (`tools describe`, Stufe 2, 4.7). Engine, Werkzeuge, Key, Zustimmung, Modell und Sicherheitsregeln gelten für beide.

- **Wann:** nur über `tools resolve`, `refresh --resolve` oder in `predev`, wenn `agent.auto` gesetzt, Zustimmung erfasst, ein Key vorhanden, ein TTY aktiv und `CI` nicht gesetzt ist. Nur für auflösbare Befunde (`input-contract-unresolved`, Schema-Rolle unklar/nicht exportiert, `ui-action-payload-untyped`, `auth-evidence-missing` – nur als Konventionsvorschlag, `contract-stale`). Verweigert in CI, im Frozen-/Integrity-Modus und in `check`. **Deploys rufen nie ein Modell.**
- **Engine:** `ai@6` (`generateText` mit Tools, `stopWhen` auf `submit_resolutions` und Schrittgrenze), Provider wie in den Apps: `createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' }).chat(model)`. `@ai-sdk/openai` wird optionale Peer-Abhängigkeit und nur vom Resolver dynamisch geladen. Ein kleiner Fetch-Wrapper setzt `provider: { data_collection: 'deny', zdr: true, require_parameters: true }` und `usage: { include: true }` und protokolliert Kosten und tatsächlich bedientes Modell.
- **Werkzeuge des Modells:** nur lesend `list_files`, `read_file`, `grep` (Pfad bleibt im Repo, keine Symlinks, git-ignorierte Dateien ausgeschlossen, Denylist `.env*`, `.secrets/`, `*.pem`, `*.key`, Verbindungs-/Receipt-/State-Dateien, `.git`, `node_modules`, Build-Ordner; Secrets werden redigiert; 64 KB je Datei, 400 KB je Lauf) sowie `submit_resolutions` und `report_unresolvable`. Keine Shell, kein Schreibwerkzeug, kein weiteres Netz.
- **Was geschrieben wird (vom Harness, nicht vom Modell):** `tool-resolutions.json` (Konventionen, Verträge mit Herkunft `agent`, Modell, Digest, Bindung an `interfaceDigest`) und Prosa in `tool-semantics.json`. Effekte dürfen das Risiko nur anheben. Nie: `tool-policy.json`, App-Code, Inventar, IDs, generierte Ausgaben, Ausschlüsse.
- **Validierung vor dem Schreiben:** strikter Zod-Parse; `schemaRef` über Checker und Schema-Probe aufgelöst; JSON-Schema per Ajv strict (Objekt, `additionalProperties:false`, ≤ 32 KB); Abgleich mit dem Scan; Effekt ≥ Default; Inhaltsgrenzen; **voller Pipeline-Lauf im Temp-Verzeichnis: Befund weg, keine neuen Befunde, kein Tool verloren** (der Agent kann einen Befund nicht durch Weglassen lösen); dann atomar schreiben, normaler Refresh, Diff-Zusammenfassung. Höchstens eine Reparaturrunde.
- **Caching:** `inputDigest` über Harness-/Prompt-Version, Modell, Befund, `interfaceDigest` und Kontextdateien. Akzeptierte Ergebnisse sind committete Daten; danach löst der deterministische Pfad das Element, bis sich `interfaceDigest` ändert. Fehlschläge werden bis zur nächsten Änderung übersprungen (`--retry` übersteuert).
- **Budget (Standard):** 10 Elemente, 12 Modellschritte, 40 Tool-Aufrufe, 400 k Input-/24 k Output-Tokens, **0,50 USD je Lauf**, 180 s; unbekannte Kosten bleiben `null`, nie 0.
- **Modell:** fest gepinnter Slug in `tools.json`, Standard `anthropic/claude-sonnet-5.5`, Fallback `openai/gpt-6.1-sol` (laut OpenRouter-Modellliste vom 2026-10-04; der Resolver prüft beim Start über `/api/v1/models` die Unterstützung von Tools und Structured Outputs), überschreibbar per `GLIRASTES_AGENT_MODEL`. Aliasse wie `~latest` werden abgelehnt.
- **Key:** `GLIRASTES_AGENT_OPENROUTER_API_KEY`, sonst `OPENROUTER_API_KEY` aus der Prozessumgebung. Für den reibungslosen Alltag darf `tools.json agent.keyEnvFile` (z. B. `.env.local`) gesetzt werden; dann wird **nur diese eine Variable** aus der Datei gelesen, nichts sonst. Der Key wird nie ausgegeben oder gespeichert; geschriebene Dateien werden auf `sk-or-v1`-Muster geprüft.
- **Zustimmung:** beim ersten Lauf zeigt die CLI Dateien, Bytes und Empfänger (OpenRouter und Modellanbieter, nie die Glirastes-Platform) und schreibt `agent.consent` in `tools.json` (teamweit, im Review sichtbar).
- **Ohne Key oder Zustimmung:** Refresh läuft deterministisch durch; offene Tools bleiben deaktiviert und werden mit drei Optionen gelistet: Key setzen und `tools resolve`; `tools resolve --print` für den vorhandenen Coding-Agenten (gleiche Validierung); `tools policy exclude`.

### 4.7 Stufe 2: agentische Anreicherung von Beschreibung und Schema

Ziel: Das Modell versteht jedes Tool so gut, als hätte ein Entwickler es sorgfältig dokumentiert – auch wenn der Endpunkt weder Zod noch OpenAPI noch JSDoc hat. In Get It Done lesen etwa 40 Routen `request.json()`, nur 17 validieren mit Zod; dort ist Stufe 2 die eigentliche Dokumentationsquelle.

- **Auslöser (pro Tool):** neu oder Schnittstelle geändert (`interfaceDigest`) und mindestens eines davon: Beschreibung nur Vorlage; Eingabevertrag nur abgeleitet (Feldnamen ohne Typen); Ausgabe opak; Filterdomäne offen; Synonyme/Beispielsätze fehlen; Routing-Prüfung (`tools eval`) gescheitert. Läuft nach einem schreibenden Refresh automatisch, wenn `agent.auto`, Zustimmung und Key vorhanden sind (sonst manuell per `tools describe`). Nie in CI, Frozen-/Integrity-Modus oder beim Deploy.
- **Kontext für den Agenten:** Handler-Quelltext, importierte Service-/Repository-/Schema-Module (z. B. Drizzle-Selects für die Ausgabe), verwandte Seiten/UI-Aufrufe und die Stufe-1-Evidenz (Pfad-/Query-/Body-Schlüssel, Methode, Risiko). Gleiche Lese-Sandbox wie in 4.6. Tools eines Moduls werden gebündelt beschrieben, damit sich Kontext teilt und Abgrenzungen zwischen ähnlichen Tools explizit werden.
- **Ergebnis pro Tool:**
  - Beschreibung für das Modell: was das Tool tut, wann es passt, wann ein anderes Tool besser passt;
  - typisiertes Eingabeschema: Typen, Pflichtfelder, Enums, Formate, Grenzen und eine Beschreibung je Parameter;
  - Ausgabeschema (soweit aus dem Code ableitbar) für Ergebnisdarstellung und Kompaktierung;
  - Nutzungshinweise, DE/EN-Synonyme, Modul und verwandte Module für das Routing;
  - Anzeigetexte (Singular/Plural, Text der Rückfrage) und Hinweise, wann eine Rückfrage sinnvoll ist;
  - 3–5 Beispielsätze je Sprache plus passende Beispielaufrufe.
  Effekte dürfen das Risiko nur anheben (z. B. `/archive` als destruktiv).
- **Speicherort und Herkunft:** Schemas als Verträge mit Herkunft `agent-enriched` in `tool-resolutions.json`, Prosa/Synonyme/Beispiele in `tool-semantics.json`; jeweils mit Modell, Digest und Bindung an `interfaceDigest`. **Vorrang:** menschlich (JSDoc, Zod, OpenAPI, Vertragsmodul, von Hand gepflegte oder `locked` Felder) > Agent > Vorlage. Der Agent füllt nur Lücken oder ersetzt seine eigene frühere Ausgabe.
- **Validierung vor dem Schreiben:** Ajv strict; Eingabeschlüssel stimmen mit der Stufe-1-Evidenz überein (zusätzliche Schlüssel nur mit belegter Fundstelle, z. B. Weitergabe an einen Service); Beispielaufrufe validieren gegen das neue Schema; kein Risiko-Absenken; Inhaltsgrenzen (keine Secrets, keine Geschäftsdaten aus Fixtures); Pipeline-Lauf ohne neue Befunde.
- **Qualitätsschleife (`tools eval`, deterministisch, ohne Modell):** Für jedes Tool müssen seine Beispielsätze über `find_tools` und das Modul-Routing das richtige Tool unter den ersten Treffern liefern; Verwechslungen mit anderen Tools werden benannt. Scheitert das, überarbeitet der Agent die betroffenen Beschreibungen einmal; was dann noch scheitert, wird als Warnung `routing-ambiguous` mit den konkurrierenden Tools gemeldet. Die Beispielsätze sind zugleich Regressionskorpus für FR-3 und laufen in CI.
- **Laufzeit:** Angereicherte Schemas steuern das Modell und die Vorvalidierung der Tool-Argumente; der Endpunkt bleibt die maßgebliche Validierung. Lehnt er einen nach dem Schema gültigen Aufruf mit 400 ab, entsteht ein inhaltsfreies technisches Ereignis `tool_contract_rejected` (sichtbar in `doctor` und den Metriken); `tools describe --retry <tool>` beschreibt neu.
- **Optional `--write-contracts`:** Der Agent legt für schlecht dokumentierte Endpunkte eine Geschwisterdatei `contract.ts` mit Zod-Schemas an (nur neue Dateien, nie Änderungen an Handlern), zur Übernahme im PR. Danach erkennt Stufe 1 den Vertrag deterministisch, und die App hat bessere API-Doku. Standard: aus.
- **Caching und Kosten:** neu beschrieben wird nur bei geändertem `interfaceDigest` oder geänderten Kontextdateien; eigenes Budget `agent.enrichBudget` (Standard 1 USD und 25 Tools je Lauf). Es handelt sich um OpenRouter-Tokenkosten auf dem Key des Entwicklers, nur während der Entwicklung, nie pro Chat-Nachricht und nie an die Glirastes-Platform. Schätzung mit `anthropic/claude-sonnet-5.5` (2 USD je 1 Mio. Input-, 10 USD je 1 Mio. Output-Tokens, Cache-Lesen 0,20 USD; OpenRouter-Preisliste 2026-10-04): Erstlauf Get It Done (93 Tools) rund 3–6 USD, je nach Prompt-Caching; danach etwa 0,05–0,20 USD je geändertem Tool. Der Erstlauf braucht deshalb einmalig ein höheres Budget (`tools describe --all --budget-usd 8`) oder mehrere Läufe; das Standardbudget von 1 USD deckt etwa 15–25 Tools. Tatsächliche Kosten stehen im Ledger (`usage.cost` laut OpenRouter).
- **Ohne Key oder in CI:** Tools bleiben aktiv mit Fallback-Beschreibung. `tools status`, `doctor` und die Platform zeigen die Qualität je Tool: Beschreibung `von Hand`/`aus Code`/`Agent`/`Vorlage`, Schema `Zod`/`OpenAPI`/`Agent`/`nur Feldnamen`. Optional `ci.requireEnrichment` (Standard aus): `check` scheitert, solange Tools nur Vorlage oder Feldnamen haben.

### 4.8 Entwicklung, CI, Deploy

- `glirastes init` schreibt die Skripte: `predev: glirastes tools refresh --keep-going`, `prebuild: glirastes tools refresh` (lokal schreibend, in CI frozen, im Docker-Build integrity). Kein `prestart`. Optional `tools refresh --watch` neben `next dev`.
- Ausgabe jedes Refresh: hinzugefügt, geändert, Risiko angehoben, entfernt, braucht Aufmerksamkeit, ausgeschlossen – jeweils mit der nächsten sicheren Aktion.
- Commit: Code, `.glirastes`-Ausgaben und generiertes Modul in einem PR; der Diff von `setup-artifact.json`/`tool-contracts.json` ist der reviewbare Tool-Diff. Merge-Konflikte in generierten Dateien löst ein erneuter Refresh (IDs sind eine reine Funktion von App, `stableKey` und Tombstone-Generation).
- CI-Job `glirastes-tools` ohne Secrets: Install, `glirastes tools check --json` und `glirastes tools eval` (Routing-Regression mit den Beispielsätzen); `--strict` optional per `tools.json ci.strict` (Standard aus, damit Kollegen nicht blockiert werden; offene Tools bleiben deaktiviert und sichtbar). `check` scheitert bei Byte-Drift, unvollständiger Aufzählung, ungültiger Policy oder unbestätigter Lockerung.
- Deploy nutzt nur committete Ausgaben; Integrity-Prüfung der Kette Inventar → Discovery-Digest → Artifact → Runtime-Manifest (`runtimeDigest`, `policyDigest`) → Receipt plus Digests des generierten Moduls. Kein Modell, kein Platform-Call, keine Schreibvorgänge.
- `doctor` zeigt zusätzlich offene, veraltete und verfallene Einträge.

### 4.9 Laufzeit-Durchsetzung

- Wirksame Policy = `resolveToolPolicy(lokal wirksam, verifiziertes Platform-Overlay)` bei jedem Snapshot.
- `needsApproval = requiresApproval ODER Stufe ≥ 3` (ersetzt die wörtliche Übernahme in `local-tool-bindings.ts:235`).
- Overlay-IDs ohne lokales Binding werden ignoriert (`platform-tool-not-in-code`).
- Ein fehlendes oder abweichendes Binding deaktiviert nur dieses Tool, nicht die ganze Registry (heute wirft die Registry insgesamt).
- Revocations blockieren weiterhin; der Principal wird vor jedem Aufruf neu autorisiert.
- **Bewusste Änderung des Vertrauensmodells (Entscheidung Philipp):** Im Managed-Modus laufen neue Code-Tools, bevor die Platform sie gesehen hat. Abmilderung: Rückfrage-Defaults für jedes schreibende Tool, PR-Review des Tool-Diffs, CI-Check, Kill-Switch per Revocation, Deaktivierung pro Tool sobald gemeldet. Wird in Skills und Citadel dokumentiert.

### 4.10 Platform-Anteil von TP1

1. Begrenzte Overrides: `applyToolOverride` wird durch `boundToolOverride` (Port von `resolveToolPolicy`) ersetzt; außerhalb der Grenzen ⇒ 422 mit Grundcode; Golden-Vector-Paritätstest.
2. Migration `0044_bounded_tool_overrides`: `baseline_risk_class`, `baseline_requires_approval`, `allowed_roles` an `runtime_app_setup_tool_overrides`.
3. Ableitung: signierte `toolOverrides[]`-Deltas (nie Kopien lokaler Werte), leere `allowedRoles` erlaubt, Beschreibung in der signierten Revision.
4. Policy-only-Revision beim Speichern eines Overrides (Muster `createPromptOnlyRevision`), aktiviert über Health-Gate und Revocation.
5. Richtungsabhängige Publikationsprüfung: neue Tools zu Defaults und reine Härtungen brauchen keine Sicherheitsfreigabe; Lockerungen schon. Der generische Revisions-Endpunkt erzwingt dieselben Grenzen.
6. Capability-Report: Runner laden das inhaltsfreie Artifact einmal pro `discoveryDigest` mit ihrem app-/umgebungsgebundenen Runtime-Key hoch. Der Report beschreibt Tools, aktiviert sie nie.
7. `GET /v2/apps/:appId/environments/:environmentId/capabilities`: pro Tool Name, Art, Methode/Pfad, Risiko, Rückfrage, aktiv, Herkunft je Feld (Code-Default/lokal/Platform) und Status (neu, geändert, Risiko angehoben, entfernt, braucht Aufmerksamkeit, ausgeschlossen).
8. Citadel: Karte „Was kann mein Chat?“, Tool-Explorer pro Umgebung, Override-Formular nur einschränkend („Deaktivieren“, „Bestätigung verlangen“, „Risiko anheben“, „Rollen einschränken“; „Lockern“ nur bis Stufe 2 mit Hinweis auf Sicherheitsfreigabe).
9. Verträge im Gleichschritt (beide unveröffentlicht): `RuntimePolicyRevision.toolOverrides`, optionale Herkunftsfelder an `AppSetupToolCandidate`.
10. Connected Apply: neue Tools brauchen kein Sync/Apply mehr, um ausführbar zu werden; Apply nur noch für Override-, Prompt- oder Budget-Revisionen.

### 4.11 Referenz-Fixtures im SDK-Repo

| Fixture | Aufbau | Quellen |
| --- | --- | --- |
| `examples/source-driven-next` (bestehend, umgestellt) | Next.js; `adapter.mjs`/`ui-adapter.mjs`/`build.mjs` entfallen zugunsten von `tools refresh`, ein `handlerWrappers`-Eintrag | next-app, next-pages, url-filters, react-actions |
| `examples/react-nest-separate` (neu) | `api/`: NestJS 11 mit Zod-Pipes, Cookie-Session-Guard; Chat-Handler framework-neutral (Web Request/Response) in einem Controller. `web/`: Vite, React, react-router, nuqs, Navigationsbrücke. Tools rufen die API über `createHttpEndpointCaller` mit Cookie/Authorization des Nutzers | nest, react-router, url-filters, react-actions |
| `examples/vue-fastapi` (neu) | `api/`: FastAPI, Pydantic, `export_openapi.py`, optional `x-glirastes-effect`. `web/`: Vue 3, vue-router, `glirastes/browser` (`registerNavigationBridge`, `registerAiClientAction`, `defineQueryFilters`), Chat über die framework-neutrale Einbettung (TP3). `runtime/`: deklarierter Node-Sidecar | openapi (+ FastAPI-Zählung), vue-router, url-filters, browser-actions |

Python 3.12 ist deklarierte Voraussetzung für die Vue/FastAPI-Fixture (README, Setup-Messung, eigener CI-Job; lokal überspringen die Tests sichtbar, wenn Python fehlt). Supportmatrix: „automatisch geprüft“ nur mit bestandenem Änderungskorpus der jeweiligen Fixture.

### 4.12 Tests

- **Änderungskorpus:** 3 Fixtures × {Endpunkt, Navigation, Filter} × {hinzufügen, ändern, entfernen} = 27 Tests. Jeder: Fixture kopieren, Refresh, Patch anwenden, `check` scheitert mit benanntem Befund, Refresh, Change-Set/IDs/Defaults prüfen (GET ohne, schreibend mit Rückfrage, keine Plan-Bestätigung für neue Tools), `check` grün, Runtime aus den committeten Ausgaben booten und Wirkung prüfen (neu: Tool läuft in der Nutzer-Session, unauthentifiziert vom Endpunkt abgelehnt; geändert: neues Schema greift; entfernt: Tool fehlt, Direktaufruf ⇒ `manifest_tool_unavailable`).
- **Zusatzkorpus:** Lockerung verfällt bei Risikoanstieg; Absenkung gehalten bis `accept`; Lockern auf DELETE ⇒ `E-POLICY-002`; nicht unterstützte Änderung ⇒ `needs_attention` und `check --strict` rot; unaufgelöstes bekanntes Tool behält ID; `export *` ⇒ Refresh schreibt nichts; entfernte Brücke ⇒ Navigation/Filter `needs_attention`; Chat-Route nie ein Tool; Integrity-Modus erkennt manipulierte Ausgaben; zweimal byte-identisch auf Node 20 und 22.
- **Agent (MockLanguageModelV3):** akzeptiert gültige Referenz; lehnt fehlenden Export, Lockerung, ungültiges/zu großes Schema, Weglassen/Ausschließen von Tools und Inhaltsverstöße ab; eine Reparaturrunde; Budget-/Timeout-Stopp; Cache; ohne Key/Zustimmung bleibt alles offen; CI verweigert; Denylist-Dateien erreichen nie den Kontext; `check` importiert nie `@ai-sdk/openai`. Live-Evaluation nur per `GLIRASTES_LIVE_AGENT_EVAL=1` und nach Philipps Freigabe des Keys.
- **Stufe 2 (MockLanguageModelV3):** füllt nur Lücken, überschreibt keine `human`/`locked`-Felder; lehnt Schemas mit unbelegten Schlüsseln, ungültige Beispielaufrufe und Risiko-Absenkung ab; Neubeschreibung nur bei geändertem `interfaceDigest`; `tools eval` erkennt Verwechslungen und ist ohne Modell byte-stabil; `--write-contracts` legt nur neue `contract.ts` an, die Stufe 1 danach deterministisch erkennt; ohne Key bleiben Tools aktiv und die Qualitätsanzeige stimmt; `ci.requireEnrichment` greift.
- **Runtime:** Overlay kann unbekannte/`needs_attention`-IDs nicht aktivieren und Stufe 3 nicht lockern; Revocation blockiert; neues lokales Tool ohne Platform aktiv; fehlendes Binding deaktiviert nur ein Tool; kein Netz pro Turn.
- **Platform:** 422-Grenzmatrix plus Vektorparität, Migration 0044, leere Rollen, Policy-only-Republish, richtungsabhängige Publikation, Report-Scope, Capability-Status, Citadel-Formular.
- **Browser-E2E** für alle drei Fixtures (Vue zusätzlich Styling, Tastatur, Unmount).

## 5. TP2 – Get It Done auf aktuellem `master`

1. **Neuer Branch von `origin/master`** (@296e98e) in neuem Worktree; der Pilot bleibt unverändert als Quelle. Die Foundation-Integration des Pilots (Chat-Handler, Standalone-/Managed-Quelle, Chat-UI, STT) wird auf den Code von `master` portiert.
2. **Codemod** (`scripts/migrations/ai-tool-to-contract.ts`, nach Gebrauch gelöscht): jedes `ai-tool.ts` wird zu einem `contract.ts` mit denselben Zod-Schemas; Legacy-Toolnamen nach `.glirastes/mcp-tool-names.json` (nur MCP); Beschreibungen mit alten Namen werden umgeschrieben; `allowedRoles` (inkl. `teamleiter`) und `needsApproval` werden zu `tool-policy.json`-Einträgen (nie Lockerung auf Stufe 3); Navigations-/Filterdefinitionen aus `ai-ui-tool.ts` entfallen zugunsten Seitenbaum + Brücke.
3. **Identität:** `tools refresh --adopt <Pilot-Inventar>` erhält `toolId`s unveränderter `stableKey`s. Umbenannte Pfade (groups→teams, Deutsch→Englisch) bekommen neue IDs plus Tombstones. `platform-tool-bindings.json` entfällt.
4. **Refresh und Parität:** temporärer Paritätstest gegen den `master`-Katalog (IDs, Methode/Pfad, Risiko/Rückfrage mindestens so streng). `bulk/delete` und `bulk/permanent-delete` werden `delete`. `setup-artifact.json` und generiertes Modul werden committet (behebt auch das leere `.glirastes` im Image).
5. **UI:** handgepflegte Zielkarte in `app-shell.tsx` ⇒ `useGlirastesNavigationBridge`; nuqs-Parser auf typisierte Enums aus `src/lib/validations`; Dialog-Aktionen mit Vertragsargument; `REQUIRED_ACTION_IDS` entfällt (fehlender Handler ⇒ `check`-Fehler).
6. **MCP-Server** (`src/lib/mcp`): bezieht `mcpEndpointCatalog` aus dem generierten Modul (Zod-Originale für Vertrags-/native Tools, sonst JSON-Schema; Rollen aus der wirksamen Policy). Klassifizierung bleibt app-lokal und fail-closed; UI-Tools bleiben draußen; Grants nach `definitionId` bleiben gültig.
7. **Skripte, CI, Deploy:** `predev`/`prebuild` ⇒ `tools refresh`; CI-Job `glirastes-tools` plus Tests/Typecheck/Lint (ESLint-Config für Next 16); `deploy.yml`/`.env.example`/Test auf `GLIRASTES_API_KEY` vereinheitlichen; Docker-Build mit `GLIRASTES_TOOLS_MODE=integrity`; SDK im Image über ein gepacktes Tarball (`bun pm pack`) bis zur freigegebenen Veröffentlichung.
8. **Erst nach Paritätsnachweis:** `agentic generate-tools` und alle `@chainmatics/agentic-*` entfernen; eingefrorene Registry, Export-Skript, `generate-glirastes-local-bindings.ts`, Assess-Skripte, `local-tool-bindings.json`, `tool-roles.ts` löschen.
9. **Abnahme in GID:** Route hinzufügen ⇒ Chat ruft sie erfolgreich auf; Route löschen ⇒ Tool weg; dasselbe für Navigation und Filter; MCP-Tests grün.
10. Branch `origin/projects` (Frank Landgraf) wird nicht verändert. Hinweis für die Abstimmung: Neue Endpunkte brauchen künftig kein `ai-tool.ts` mehr; `readJsonBody` wird als `bodyReaders`-Konvention unterstützt.

## 6. TP3 – Routing, Suche, Rückfragen, Chat-UI, STT (FR-3 bis FR-5)

- **`find_tools`:** Unicode-fähiger Tokenizer (`\p{L}\p{N}`), Stemming über das vorhandene `snowball-stemmers` (DE/EN), Synonyme aus `usageHints`/Semantik, auch im Standalone-Modus verfügbar (heute nur managed). DE/EN-Relevanzkorpus mit Synonymen, Nulltreffern und fehlenden Berechtigungen; unberechtigte oder im Deployment fehlende Tools werden nie geliefert.
- **Rückfragen:** strukturiertes Klärungs-Tool mit Optionen und Freitext als SDK-Komponente; der ursprüngliche Auftrag bleibt in der Session erhalten und wird mit der Antwort fortgesetzt. Kein zusätzlicher Planner-Modellaufruf im Normalfall; bei eindeutiger Absicht keine Rückfrage.
- **Chat-UI:** generische Provider-API für `/`-Befehle und `@`-Erwähnungen (asynchrone Suche, Tastatursteuerung, stabile IDs, Berechtigungskontext); eingebauter Befehls-Provider aus den UI-Tools des Katalogs; Registry für eigene Ergebnis-Komponenten pro Tool (`definitionId`, Schema-Version, sicherer Fallback für alte Nachrichten); mobile Darstellung mit Browser-Test.
- **Framework-neutrale Einbettung:** neues Subpaket `glirastes/embed` mit Custom Element `<glirastes-chat>` (Shadow DOM, CSS-Variablen, Events, sauberes Unmount); intern die React-UI. Genutzt von der Vue-Fixture.
- **STT:** Push-to-talk (gedrückt halten, Taste und Button) zusätzlich zum Umschalten; Zwischentext auch in der Aufnahmeleiste; Bearbeiten vor dem Senden; kein Auto-Senden durch Finalisierung; weiterhin genau ein Controller und ein Mikrofonstream. Browser-Tests mit Chromes Fake-Media-Device: Stop, Cancel, Retry, Routen- und Sessionwechsel, Unmount hinterlassen keinen Stream.
- **Messung:** Vergleichskorpus mit identischem Modell vorher/nachher (Erfolgsquote, erste Antwort, Gesamtzeit, Modellrunden, Tokens). Live-Läufe mit OpenRouter nur nach Philipps Freigabe der Key-Nutzung; bis dahin deterministisches Testmodell.

## 7. TP4 – Platform-Betrieb und Metriken (FR-6, FR-7)

**Nutzerführung entlang der fünf Fragen** (`/manage` als App-Übersicht):

| Frage | Umsetzung |
| --- | --- |
| Ist meine App verbunden? | Status in Klartext (verbunden, Runner gesund, zuletzt gesehen), Fehler mit nächster sicherer Aktion |
| Was kann mein Chat? | Capability-Ansicht aus TP1 mit Suche, Risiko, Rückfrage, Status, Override |
| Sind meine Änderungen verfügbar? | Lesbare Versionsnummern (v7) statt Digests; „Neue Version verfügbar – Update anwenden“ nur noch für Platform-seitige Änderungen |
| Was kostet die Nutzung? | Basis-Dashboard (Tokens, Kosten mit Herkunft, Latenz, Fehler, Tool-Nutzung) |
| Wie behebe ich ein Problem oder gehe zurück? | Diagnose mit Handlungsempfehlung, geführter Rollback auf letzten gesunden Stand |

Digests, IDs und Pins bleiben unter „Technische Details“ erreichbar.

**Verbinden:** `/connect` führt primär zum Pairing (`glirastes connect`, Code vorbefüllt über `user_code`), der Env-Block wandert unter „Erweitert“; Deny-Pfad in API und UI; verständliche Meldung bei `connected_free_limit_reached` mit Upgrade-Hinweis. `glirastes connect` erhält das Framework aus `tools.json` statt fest `nextjs`.

**Metriken:**

- SDK: `TechnicalRuntimeEvent` v2 mit `appId`, `environmentId`, `buildId`, `instanceId`, `revisionId`, Modell, Input-/Output-Tokens, Kosten `{usd|null, source: 'provider-reported'|'price-table'|null, pricingVersion}`, Latenz (erste Antwort, gesamt), Fehlercode, Tool-Anzahl/-IDs. Asynchrone, gebündelte Senke außerhalb des kritischen Turn-Pfads; bei Ausfall verworfen, nie blockierend. OpenRouter-`usage.cost` gilt als `provider-reported`. Keine Prompts, Inhalte, Argumente, Ergebnisse oder Secrets (Content-Boundary-Prüfung).
- Platform: Ingest-Endpunkt mit Runtime-Key (app-/umgebungsgebunden), Tabelle plus stündliche Aggregation (bestehendes BullMQ-Muster), Free-Dashboard pro App/Umgebung; Pro: Vergleiche nach Umgebung, Version, Modell, Tool und längere Historie (Aufbewahrungsdauer ist eine offene Produktentscheidung; technisch konfigurierbar, Standard Free 30 Tage, Pro 365 Tage).
- Der bisherige Lancer-Versand an den nicht gemounteten Proctor-Endpunkt wird im Foundation-Pfad durch die neue Senke ersetzt.

**Platform-Hygiene (Voraussetzung für Release):**

- Drizzle: 0036–0043 im Journal registrieren, Snapshots nachziehen, Migrationsstrategie dokumentieren und testen (Anwendung gegen eine Wegwerf-Postgres, z. B. PGlite oder Docker-Postgres), danach 0044.
- API-Typecheck reparieren: Instanziierungsexplosion in `advisor.tools.ts` (Advisor ist im Foundation-Profil zurückgestellt; Typen isolieren oder Modul aus dem Foundation-Typecheck-Pfad nehmen, ohne es zu löschen), 103 Typfehler beheben, Typecheck als CI-Gate.
- Pairing-Key auf `runtime`-Scope beschränken, Ablauf/Rotation; `/v1/apps` prüft App-Scope (Test zuerst, der die Lücke belegt).
- Aegis-Pseudonym-Kollision (Nachnamen über Identitätsgruppen) beheben.
- ESLint-Config für Citadel.
- Pro-Freischaltung: ohne Billing-UI ein abgesicherter Admin-Befehl zum Planwechsel (kein DB-Handeingriff); ein Bezahlsystem ist keine MVP-Voraussetzung.

## 8. TP5 – Landingpage

Erst nach belegtem Produkt: Hero-Glyphen als kontrollierte SVG-/Textebene lesbar; Wurzel-Animation ruhig mit `prefers-reduced-motion`-Variante; Inhalte auf den belegten Stand (Installieren → echte App-Aktion → bleibt automatisch aktuell; kein `glirastes index`; Local/Free/Pro ohne nicht beschlossene Preise; keine unbelegten PII-/Compliance-Aussagen); Copy-Button tastaturbedienbar; Platzhalterlinks raus; Desktop/Mobil, Reduced Motion und Ladeleistung im Browser geprüft. **Veröffentlichung nur nach Freigabe.**

## 9. TP0 und TP6 – Sicherung, Hygiene, Release-Vorbereitung

- TP0: nicht committete Doku im Platform-Worktree lokal committen; `.glirastes/platform-connection.json` in GID `.gitignore`; veraltete Löschung in `platform-tool-bindings.json` klären; lastempfindliche Tests mit eigenem Timeout; macOS-`EPERM` im Test-Cleanup behandeln; Typfehler in SDK-Testdateien beheben und Test-Typecheck als Gate; GID `lint` reparieren; Platform-`CLAUDE.md` auf den SDK-Pfad `/Users/philipprollmann/Dev/chainmatics/glirastes` korrigieren.
- **Backup-Push der drei lokalen Branches auf eigene Remote-Branches: nur nach Philipps Freigabe.**
- TP6: SDK-Version **0.5.0** (0.4.0 ist bereits mit anderem Inhalt veröffentlicht), CHANGELOG mit Breaking Changes (entfernte Exporte `./server/nestjs`, `./openapi`, `./react/langgraph`; Omnify bleibt auf 0.4.0, bis es bewusst migriert wird), Paketprüfung (`bun pm pack`, Installationsbeispiel gegen den Tarball), Skills/README/CLI konsistent, Supportmatrix (erkannt/integriert/automatisch geprüft/offiziell unterstützt). **Veröffentlichung, Merges und Deploys nur nach Freigabe.**

## 10. Von mir festgelegte Standardentscheidungen (Veto möglich)

1. Neue Endpunkte ohne Schema: sofort aktiv mit abgeleitetem schwachem Vertrag (Endpunkt validiert weiterhin), Warnung sichtbar.
2. Agent-Key: `GLIRASTES_AGENT_OPENROUTER_API_KEY`, sonst `OPENROUTER_API_KEY`; optional nur diese Variable aus `agent.keyEnvFile`.
3. Agent in `predev`: teamweite, committete Zustimmung in `tools.json`; ohne Key läuft alles deterministisch weiter.
4. Modell: `anthropic/claude-sonnet-5.5` über OpenRouter, Fallback `openai/gpt-6.1-sol`; Budget 0,50 USD je Lauf.
5. Vorrang: über alle Ebenen gewinnt das Strengste; die Platform kann eine lokale Härtung nicht lockern.
6. CI: `tools check` standardmäßig, `--strict` optional.
7. GID-Migration auf neuem Branch von `origin/master`; konvertierte `contract.ts` sind als Übergang erlaubt, bis Routen damit validieren.
8. Dritte Referenz: Vue 3 + FastAPI, Python 3.12.
9. Metriken-Aufbewahrung technisch konfigurierbar (Standard Free 30, Pro 365 Tage) bis zur Produktentscheidung.
10. Stufe 2 läuft automatisch nach jedem schreibenden Refresh, sobald Key und Zustimmung vorliegen; Budget 1 USD je Lauf, für den Erstlauf einmalig höher.
11. Von Hand gepflegte oder als `locked` markierte Beschreibungen und Schemas überschreibt der Agent nie.
12. `--write-contracts` (Agent legt `contract.ts` an) ist standardmäßig aus; `ci.requireEnrichment` ebenfalls.

## 11. Nicht im Umfang

Omnify (keine Lese- oder Schreibarbeit); Pushes, Merges nach `main`/`master`, npm-Veröffentlichung, Deployments und Änderungen an der Live-Landingpage ohne Freigabe; Billing-System; Canary/A-B/automatische Prompt-Optimierung; Widget-Katalog/visueller Editor; TTS/Duplex; Reaktivierung zurückgestellter Platform-Module (Analytics, Aegis-Produkt, Warden, Primus, Optimizer, MCP/ACP-Produkt); Löschung von Kompatibilitätscode ohne separate Entscheidung; Änderungen an `origin/projects`.

## 12. Risiken

- Heuristische Datenfluss- und Wrapper-Erkennung kann falsche `needs_attention`-Befunde erzeugen (Abhilfe: Konventionen, Vertragsmodule, Resolver). Größter Aufwandsposten.
- Schema-Probe und OpenAPI-Export führen App-Module beim Generieren aus; Module mit Seiteneffekten beim Import scheitern geschlossen.
- Vertrauensmodell im Managed-Modus ändert sich bewusst (neue Tools vor Platform-Sichtung aktiv).
- SDK und Platform ändern strikte Verträge im Gleichschritt; beide müssen gemeinsam unveröffentlicht bleiben.
- GID-Migration ist groß (121 Commits, 86 Routen, Umbenennungen); MCP-Alias- und Grant-Kontinuität hängt am Codemod.
- Modellnamen wechseln von Legacy-snake_case zu abgeleiteten Namen; Beschreibungen müssen nachgezogen werden, sonst sinkt die Routing-Qualität.
- Agentisch abgeleitete Schemas können falsch oder zu streng sein; Abhilfe: Evidenzabgleich, Beispielaufrufe, `tools eval`, Endpunkt bleibt maßgeblich, `tool_contract_rejected` stößt Neubeschreibung an.
- OpenRouter: Modellverfügbarkeit, Kosten, ablaufende Slugs; `zdr`/`require_parameters` können Anbieter ausschließen. Der Key-Status (früher 403 „Key limit exceeded“) ist unbekannt; Live-Nachweise brauchen Philipps Freigabe.
- Echter Nutzertest bleibt eine menschliche Aufgabe.

## 13. Aufwand und Vorgehen

Grobe Schätzung in Entwicklertagen (menschliches Äquivalent): TP0 3, TP1 55 (davon Stufe 2 rund 5), TP2 8, TP3 12, TP4 15, TP5 4, TP6 3 – zusammen rund 100. Umsetzung durch orchestrierte Agenten in isolierten Worktrees, Phase für Phase mit lokalen Commits, grünen Gates und einem Checkpoint-Bericht nach jeder Phase. Freigaben, die ich unterwegs einhole: Backup-Push, Nutzung des OpenRouter-Keys für Live-Läufe, Merges, Veröffentlichung, Deployments.
