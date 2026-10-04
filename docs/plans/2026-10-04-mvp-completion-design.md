# Glirastes MVP-Abschluss: Design

Version: 1.4 · Stand: 2026-10-04 (Abschnitt 6a zur Freigabe) · Status: Entwurf zur Freigabe durch Philipp

Grundlage: [MVP-Scope v1.2](2026-09-13-mvp-scope-and-requirements.md), [Fokussiertes MVP](2026-09-13-focused-mvp-design.md), Platform-Design [Local, Connected Free, Managed](/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/docs/plans/2026-08-14-local-connected-managed-platform-design.md). Dieses Dokument ersetzt keine dieser Quellen, sondern legt fest, wie das MVP fertiggestellt wird. Wo es abweicht, ist das ausdrücklich markiert.

## 1. Auftrag und Verständnis

### Was Philipp gesagt hat (2026-10-04)

- Alle MVP-Ziele abschließen; „es soll alles reibungslos laufen“; die erforderlichen Tests fahren.
- Tools ziehen bei Codeänderungen automatisch nach. Wo das deterministisch nicht geht, übernimmt ein Agent; das gilt ausdrücklich auch für Beschreibungen und Schemas, weil viele Endpunkte nicht über API-Doku, Zod o. Ä. beschrieben sind.
- Agentische Tool-Generierung läuft **in Local/Free lokal mit dem eigenen Coding-Agenten (kein OpenRouter)** und **in Pro als Managed Service: von CI/CD ausgelöst, im CI-Runner ausgeführt, von der Platform gesteuert (OpenRouter), Ergebnisse als Commit/PR im Repo**. Quellcode geht dabei nie über die Glirastes-Platform.
- **Sämtliche agentischen Notwendigkeiten werden per Skill gelöst.**
- Den OpenRouter-Key braucht die **Zielapp** für die Nutzung von Glirastes: Er ist der Modellzugang ihres Chats zur Laufzeit (Konto des App-Betreibers), nicht der Tool-Generierung.
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
| TP1 | Code-getriebene Tool-Synchronisierung inkl. agentischer Stufe (Coding-Agent bzw. Managed-Job), Risiko-Defaults, Policy, Referenz-Fixtures | FR-1, FR-2, FR-8 (generisch) | TP0 |
| TP2 | Get It Done auf aktuellem `master` mit Foundation | FR-8, FR-2 (GID) | TP1-Kern |
| TP3 | Routing, Suche, Rückfragen, Chat-UI, Einbettung, STT | FR-3, FR-4, FR-5 | TP0 (parallel zu TP1 möglich) |
| TP4 | Platform: fünf Fragen, Capabilities, Overrides, Managed Tool-Generierung (Pro), Metriken, Platform-Hygiene | FR-6, FR-7 | TP1-Verträge |
| TP5 | Landingpage | Landing | TP1–TP4 belegt |
| TP6 | Abnahme, Release-Vorbereitung, Dokumentation | Release | alle |

TP1 und TP3 laufen in getrennten Worktrees parallel; TP2 und TP4 starten, sobald die TP1-Verträge (Policy, Overlay, Generator-Ausgaben) stehen.

## 4. TP1 – Code-getriebene Tool-Synchronisierung

### 4.1 Überblick

Ein SDK-Generator leitet bei `dev` und `build` alle Endpunkt-, Navigations- und Filter-Tools deterministisch aus dem App-Code ab. Er nutzt die vorhandenen Bausteine weiter (`reconcileExecutionInventory` mit Tombstones, Setup-Artifact, `applySetupPlan`/`writeArtifactSetAtomically`, `discoverFoundationExecutions`) und schreibt **byte-reproduzierbare, committete Artefakte**. CI prüft sie im Frozen-Modus, Docker nur ihre Digest-Kette. Agentische Arbeit (Befunde auflösen, Beschreibungen und Schemas anreichern) erledigt in Local und Free der eigene Coding-Agent des Entwicklers, in Pro ein Managed-Job im CI-Runner, den die Platform steuert. Beide liefern nur Daten; der Generator validiert sie und entscheidet allein über Ausführbarkeit. Eine begrenzte Policy (lokal oder per signiertem Platform-Delta) kann Tools nur einschränken oder justieren, die der deployte Code besitzt.

Die Ermittlung läuft in **zwei Stufen**:

- **Stufe 1 – deterministisch (Existenz und Sicherheit):** welche Tools es gibt, Identität, Methode/Pfad, Eingabe-Schlüssel, Auth-Evidenz und Risiko. Reproduzierbar, in CI ohne Key prüfbar; entscheidet allein über Ausführbarkeit. Der Agent darf hier nur Vorschläge machen, die der Generator gegen den Code bestätigt (4.6).
- **Stufe 2 – agentisch (Verständnis und Qualität):** Beschreibungen, typisierte Ein- und Ausgabeschemas, Parameterbeschreibungen, Synonyme, Modulzuordnung, Anzeigetexte, Rückfragehinweise und Beispielsätze – besonders für Endpunkte ohne Zod, OpenAPI oder vergleichbare Doku. Erledigt in Local/Free der eigene Coding-Agent, in Pro ein Managed-Job im CI über OpenRouter; Ergebnisse werden committet und durch eine deterministische Routing-Prüfung abgesichert (4.7). Ohne Stufe 2 bleiben Tools aktiv, aber mit sichtbar schwächerer Beschreibung.

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
| `tools refresh [--keep-going] [--adopt <inventory>] [--watch] [--json]` | Tools aus dem Code neu ableiten und schreiben |
| `tools check [--strict] [--integrity-only] [--json]` | Frozen-Refresh: schreibt nie, kein Modell, kein Netz |
| `tools status [--json]` | Lokales „Was kann mein Chat?“ |
| `tools resolve --print [--json]` | Arbeitsliste offener Stufe-1-Befunde für den eigenen Coding-Agenten (Local/Free) |
| `tools describe --print [<tool>…\|--all] [--write-contracts]` | Arbeitsliste für Stufe 2 (Beschreibung und Schema) für den eigenen Coding-Agenten |
| `tools enrich --managed [--first-run] [--budget-usd]` | Pro: Managed-Job im CI-Runner (Befunde und Anreicherung), Ergebnis als Commit |
| `tools eval [--json]` | Deterministische Routing-Prüfung mit den Beispielsätzen (kein Modell, CI-fähig) |
| `tools policy <show\|disable\|enable\|confirm\|relax\|raise\|roles\|describe\|exclude\|include\|accept\|reset> <tool> [wert] [--reason]` | Lokale Übersteuerung |
| `tools verify <tool\|--all>` | Entwickler bestätigt einen beschreibenden Vertrag nach Review |

Modus: Flag → `GLIRASTES_TOOLS_MODE` (`write`/`frozen`/`integrity`) → `CI` gesetzt ⇒ `frozen` → sonst `write`. Damit sind die Paketskripte überall gleich: lokal schreiben, in CI prüfen, im Docker-Build (`ENV GLIRASTES_TOOLS_MODE=integrity`) nur die Digest-Kette verifizieren.

### 4.3 Dateien im App-Repo (`.glirastes/`, alle committet)

Eingaben (von Menschen, `init` oder dem Agenten geschrieben; `refresh` überschreibt sie nie):

- `tools.json`: `{schemaVersion, appId, targetAppKey, locale, sources:[…], emit:{module?, mcpCatalog?}, enrich:{managed?, model?, writeContracts?}, ci:{strict?, requireEnrichment?}}` (nie ein Key)
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

### 4.6 Agentische Arbeit: ausschließlich über Skills

**Grundsatz.** Jede Aufgabe, die das Urteilsvermögen eines Modells braucht, ist eine mit dem SDK ausgelieferte Skill. Die CLI bleibt deterministisch: Sie erkennt, erzeugt Arbeitslisten, validiert und schreibt Artefakte; sie enthält keine Modell-Prompts und ruft lokal nie ein Modell auf. Skills werden mit dem Paket versioniert und von `glirastes init`/`glirastes install` für den vorhandenen Coding-Agenten installiert. Wer eine Skill ausführt, hängt von der Variante ab: lokal der eigene Coding-Agent (Local/Free), in Pro der Glirastes-Skill-Runner im CI. Es gibt keine zweite, in Code gegossene Agentenlogik neben den Skills.

| Skill | Status | Aufgabe |
| --- | --- | --- |
| `setting-up-glirastes` | vorhanden, überarbeiten | Einrichtung: Stack, Auth und Infrastruktur erkennen, `tools.json` und Quellen konfigurieren, Chat und Modellzugang der Zielapp einbinden, CI-Jobs anlegen, erste erfolgreiche Tool-Aktion nachweisen |
| `integrating-glirastes-nextjs` | vorhanden, überarbeiten | Next.js-spezifische Anbindung (Route-Handler, Navigationsbrücke, nuqs-Filter) |
| `integrating-glirastes-web` | neu | Getrenntes Backend (z. B. NestJS), Nicht-React-Frontends (Vue, `<glirastes-chat>`), Node-Sidecar für Nicht-Node-Backends (z. B. FastAPI) |
| `maintaining-glirastes-tools` | vorhanden, überarbeiten | Stufe-1-Befunde auflösen (`tools resolve --print`), Konventionen, Policy-Übersteuerungen, `needs_attention` abarbeiten |
| `describing-glirastes-tools` | neu | Stufe 2: Beschreibungen, typisierte Schemas, Synonyme, Beispielsätze (`tools describe --print`), Verwechslungen aus `tools eval` beheben |
| `building-glirastes-chat-ui` | vorhanden, überarbeiten | Chat-UI, `/`- und `@`-Provider, Ergebnis-Komponenten, STT |
| `migrating-to-glirastes` | neu | Migration von `@chainmatics/agentic-*` und `ai-tool.ts` (inkl. MCP-Katalog), genutzt für Get It Done |

Es gibt zwei agentische Tool-Aufgaben: **Befunde auflösen** (Stufe 1 kann ein Element nicht bestimmen, z. B. `input-contract-unresolved`, Schema-Rolle unklar/nicht exportiert, `ui-action-payload-untyped`, `auth-evidence-missing` nur als Konventionsvorschlag, `contract-stale`) und **anreichern** (Stufe 2, 4.7). Beide liefern ausschließlich Daten in `tool-resolutions.json` und `tool-semantics.json` (optional neue `contract.ts`). Wer die Arbeit erledigt, hängt von der Variante ab; die Prüfung ist immer dieselbe.

**Einheitliche Prüfung im Generator.** `tools refresh` und `tools check` validieren jeden agentischen Eintrag, egal ob ihn der eigene Coding-Agent oder der Managed-Job geschrieben hat: strikter Schema-Parse; `schemaRef` über Checker und Schema-Probe auflösbar; JSON-Schema per Ajv strict (Objekt, `additionalProperties:false`, ≤ 32 KB); Abgleich mit der Stufe-1-Evidenz (keine unbelegten Schlüssel); Effekte nur risikoerhöhend; Inhaltsgrenzen (keine Secrets, kein `sk-or-v1`-Muster, keine Geschäftsdaten); menschliche oder `locked` Felder haben Vorrang; kein Tool und keine Zuordnung geht verloren (ein Befund lässt sich nicht durch Weglassen lösen). Ungültige Einträge werden ignoriert und als Befund `resolution-rejected` gemeldet; das Tool behält seinen Fallback. Nie geschrieben werden dürfen `tool-policy.json`, App-Handler, Inventar, IDs, generierte Ausgaben und Ausschlüsse.

**Local und Free: eigener Coding-Agent, kein OpenRouter für die Generierung.**

- `tools resolve --print` und `tools describe --print` erzeugen eine JSON-Arbeitsliste: pro Tool `stableKey`, Befund oder Lücke, relevante Dateien, Stufe-1-Evidenz, Zieldatei und das erwartete Eintragsformat.
- Die Skills `maintaining-glirastes-tools` (Befunde) und `describing-glirastes-tools` (Anreicherung) beschreiben den Ablauf; `glirastes init` ergänzt `AGENTS.md`/`CLAUDE.md` um einen kurzen Hinweis: nach Änderungen an API-Routen, Seiten oder UI-Aktionen `glirastes tools refresh` ausführen, die Arbeitsliste abarbeiten, danach `tools refresh` und `tools eval` erneut.
- Jeder Refresh endet bei offenen Lücken mit einem Satz wie „12 Tools brauchen eine bessere Beschreibung – dein Coding-Agent kann das mit `glirastes tools describe --print` erledigen“.
- Kosten entstehen nur im Abo des Coding-Agenten; für die Generierung braucht Glirastes keinen Key.

**Pro: Managed-Job im CI-Runner, gesteuert von der Platform.**

- **Auslöser:** Der von `glirastes init --ci github` erzeugte Workflow-Job `glirastes-tools-enrich` läuft bei Pushes auf PR-Branches (optional auf `main`), führt `tools refresh` im Schreibmodus aus und startet bei Lücken `glirastes tools enrich --managed`. Der normale Prüfjob `glirastes-tools` bleibt modellfrei.
- **Job anlegen:** Die CLI ruft mit einem app-gebundenen CI-Key (neuer Scope `ci`) `POST /v2/apps/:appId/tool-jobs` auf. Die Nutzlast ist inhaltsfrei: `discoveryDigest`, Liste der `stableKey`s mit Lückencodes, Commit-SHA, Branch. Die Platform prüft Entitlement (Pro), Monatslimit des Tenants und App-Einstellungen, legt den Job an und erzeugt über die OpenRouter-Provisioning-API einen **kurzlebigen OpenRouter-Key** (Laufzeit ≤ 1 h, Guthabenlimit = Job-Budget). Antwort: `jobId`, Key, Modell, Budget, Routing-Vorgaben. Alternativ (BYOK) hinterlegt der Kunde einen eigenen OpenRouter-Key als CI-Secret; die Platform orchestriert dann nur.
- **Skill-Runner (im SDK, `src/agent/`, nur mit Job-Token oder BYOK in CI aktiv):** führt genau die Skills aus, die auch der lokale Coding-Agent nutzt (`maintaining-glirastes-tools`, `describing-glirastes-tools`), headless mit der Arbeitsliste als Auftrag. `ai@6`-Tool-Loop, Provider `createOpenAI({ baseURL: 'https://openrouter.ai/api/v1' }).chat(model)` mit `provider: { data_collection: 'deny', zdr: true, require_parameters: true }` und `usage: { include: true }`. Werkzeuge: lesen (`list_files`, `read_file`, `grep`; Pfad im Repo, keine Symlinks, keine git-ignorierten Dateien; Denylist `.env*`, `.secrets/`, `*.pem`, `*.key`, Verbindungs-/Receipt-/State-Dateien, `.git`, `node_modules`, Build-Ordner; Secrets redigiert; 64 KB je Datei, 400 KB je Lauf), schreiben nur in die erlaubten Datendateien (`tool-resolutions.json`, `tool-semantics.json`, optional neue `contract.ts`) und `glirastes tools refresh`/`eval` als Werkzeug. Keine Shell, kein weiteres Netz. Nach dem Lauf prüft der Runner per `git diff`, dass nur erlaubte Pfade geändert wurden; sonst scheitert der Job ohne Commit. Höchstens eine Reparaturrunde.
- **Ergebnis:** Der CI-Job committet die geänderten `.glirastes`-Dateien (und ggf. `contract.ts`) als Bot-Commit (`glirastes-bot`, Marker `[glirastes-tools]`) in den PR-Branch; bei Auslösung auf `main` öffnet er einen PR. Schleifenschutz: kein Lauf, wenn der letzte Commit ein Bot-Commit ist oder keine Lücken bestehen; Pfadfilter. Benötigt `contents: write` (PR-Modus zusätzlich `pull-requests: write`).
- **Rückmeldung:** inhaltsfreier Ledger an die Platform (Status, gelöste/gescheiterte Elemente mit Codes, Tokens, Kosten laut OpenRouter oder `null`, angefragtes und bedientes Modell, Dauer); die Platform widerruft den Key bei Jobende. Citadel zeigt Job-Historie, Kosten pro Monat, Qualität je Tool und die Einstellungen.
- **Datenpfad und Zustimmung:** Quelltext-Auszüge gehen nur vom CI-Runner zu OpenRouter und dem Modellanbieter (ZDR, keine Datensammlung, optional EU-Routing), **nie über die Glirastes-Platform**. Ein Pro-Admin aktiviert die Managed-Generierung pro App in der Platform und bestätigt den Datenpfad (Audit-Ereignis).
- **Modell und Budget:** Standard `anthropic/claude-sonnet-5.5`, Fallback `openai/gpt-6.1-sol` (laut OpenRouter-Modellliste vom 2026-10-04; der Skill-Runner prüft beim Start über `/api/v1/models` Tools- und Structured-Output-Unterstützung); gepinnte Slugs, keine Aliasse. Budget je Job standardmäßig 2 USD; ein einmaliger Erstbeschreibungs-Job (`--first-run`) bis 8 USD; Monatslimit je Tenant konfigurierbar (Standard 25 USD) bis zur Preisentscheidung. Unbekannte Kosten bleiben `null`, nie 0.
- **Caching:** Neu bearbeitet wird nur bei geändertem `interfaceDigest` oder geänderten Kontextdateien; gescheiterte Elemente werden bis zur nächsten Änderung übersprungen.

**Nie:** in `tools check`, im Frozen-/Integrity-Modus oder beim Deploy. Deploys rufen nie ein Modell.

**Abgrenzung:** Der OpenRouter-Key der Zielapp (4.8, Modellzugang des App-Chats) wird für die Tool-Generierung nicht verwendet.

### 4.7 Stufe 2: agentische Anreicherung von Beschreibung und Schema

Ziel: Das Modell versteht jedes Tool so gut, als hätte ein Entwickler es sorgfältig dokumentiert – auch wenn der Endpunkt weder Zod noch OpenAPI noch JSDoc hat. In Get It Done lesen etwa 40 Routen `request.json()`, nur 17 validieren mit Zod; dort ist Stufe 2 die eigentliche Dokumentationsquelle.

- **Auslöser (pro Tool):** neu oder Schnittstelle geändert (`interfaceDigest`) und mindestens eines davon: Beschreibung nur Vorlage; Eingabevertrag nur abgeleitet (Feldnamen ohne Typen); Ausgabe opak; Filterdomäne offen; Synonyme/Beispielsätze fehlen; Routing-Prüfung (`tools eval`) gescheitert. Local/Free: Refresh listet die Lücken, der eigene Coding-Agent arbeitet sie über `tools describe --print` ab. Pro: der Managed-Job im CI übernimmt sie automatisch (4.6). Nie im Prüfjob, Frozen-/Integrity-Modus oder beim Deploy.
- **Kontext für den Agenten:** Handler-Quelltext, importierte Service-/Repository-/Schema-Module (z. B. Drizzle-Selects für die Ausgabe), verwandte Seiten/UI-Aufrufe und die Stufe-1-Evidenz (Pfad-/Query-/Body-Schlüssel, Methode, Risiko). Die Arbeitsliste nennt diese Dateien; der Skill-Runner nutzt die Lese-Sandbox aus 4.6. Tools eines Moduls werden gebündelt beschrieben, damit sich Kontext teilt und Abgrenzungen zwischen ähnlichen Tools explizit werden.
- **Ergebnis pro Tool:**
  - Beschreibung für das Modell: was das Tool tut, wann es passt, wann ein anderes Tool besser passt;
  - typisiertes Eingabeschema: Typen, Pflichtfelder, Enums, Formate, Grenzen und eine Beschreibung je Parameter;
  - Ausgabeschema (soweit aus dem Code ableitbar) für Ergebnisdarstellung und Kompaktierung;
  - Nutzungshinweise, DE/EN-Synonyme, Modul und verwandte Module für das Routing;
  - Anzeigetexte (Singular/Plural, Text der Rückfrage) und Hinweise, wann eine Rückfrage sinnvoll ist;
  - 3–5 Beispielsätze je Sprache plus passende Beispielaufrufe.
  Effekte dürfen das Risiko nur anheben (z. B. `/archive` als destruktiv).
- **Speicherort und Herkunft:** Schemas als Verträge mit Herkunft `agent-enriched` in `tool-resolutions.json`, Prosa/Synonyme/Beispiele in `tool-semantics.json`; jeweils mit Modell, Digest und Bindung an `interfaceDigest`. **Vorrang:** menschlich (JSDoc, Zod, OpenAPI, Vertragsmodul, von Hand gepflegte oder `locked` Felder) > Agent > Vorlage. Der Agent füllt nur Lücken oder ersetzt seine eigene frühere Ausgabe.
- **Validierung:** die einheitliche Prüfung im Generator (4.6), zusätzlich: Eingabeschlüssel nur mit belegter Fundstelle (z. B. Weitergabe an einen Service); Beispielaufrufe validieren gegen das neue Schema.
- **Qualitätsschleife (`tools eval`, deterministisch, ohne Modell):** Für jedes Tool müssen seine Beispielsätze über `find_tools` und das Modul-Routing das richtige Tool unter den ersten Treffern liefern; Verwechslungen mit anderen Tools werden benannt. Scheitert das, überarbeitet der Agent (Coding-Agent oder Managed-Job) die betroffenen Beschreibungen einmal; was dann noch scheitert, wird als Warnung `routing-ambiguous` mit den konkurrierenden Tools gemeldet. Die Beispielsätze sind zugleich Regressionskorpus für FR-3 und laufen in CI.
- **Laufzeit:** Angereicherte Schemas steuern das Modell und die Vorvalidierung der Tool-Argumente; der Endpunkt bleibt die maßgebliche Validierung. Lehnt er einen nach dem Schema gültigen Aufruf mit 400 ab, entsteht ein inhaltsfreies technisches Ereignis `tool_contract_rejected` (sichtbar in `doctor` und den Metriken); die betroffenen Tools erscheinen in der nächsten Arbeitsliste bzw. im nächsten Managed-Job.
- **Optional `--write-contracts`:** Der Agent legt für schlecht dokumentierte Endpunkte eine Geschwisterdatei `contract.ts` mit Zod-Schemas an (nur neue Dateien, nie Änderungen an Handlern), zur Übernahme im PR. Danach erkennt Stufe 1 den Vertrag deterministisch, und die App hat bessere API-Doku. Standard: aus.
- **Kosten:** Local/Free: keine Glirastes-seitigen Modellkosten für die Generierung, nur das Abo des eigenen Coding-Agenten. Pro: OpenRouter-Tokenkosten auf Chainmatics' Rechnung (oder BYOK), nur bei Codeänderungen. Schätzung mit `anthropic/claude-sonnet-5.5` (2 USD je 1 Mio. Input-, 10 USD je 1 Mio. Output-Tokens, Cache-Lesen 0,20 USD; Preisliste 2026-10-04): Erstbeschreibung Get It Done (93 Tools) rund 3–6 USD je nach Prompt-Caching, danach etwa 0,05–0,20 USD je geändertem Tool. Tatsächliche Kosten stehen im Ledger und fließen in die Pro-Preisfindung. Davon getrennt: die Chat-Kosten der Zielapp pro Nachricht (4.8).
- **Ohne Anreicherung:** Tools bleiben aktiv mit Fallback-Beschreibung. `tools status`, `doctor` und die Platform zeigen die Qualität je Tool: Beschreibung `von Hand`/`aus Code`/`Agent`/`Vorlage`, Schema `Zod`/`OpenAPI`/`Agent`/`nur Feldnamen`. Optional `ci.requireEnrichment` (Standard aus): `check` scheitert, solange Tools nur Vorlage oder Feldnamen haben.

### 4.8 Entwicklung, CI, Deploy

- **Modellzugang der Zielapp:** `glirastes init` richtet den Chat-Modellzugang der App ein, Standard OpenRouter über `OPENROUTER_API_KEY` in der App-Umgebung (lokal z. B. `.env.local`, im Deploy als Secret); andere AI-SDK-Provider sind konfigurierbar. Der Entwickler trägt den Key selbst ein; Setup-Agent und CLI lesen oder kopieren ihn nie, `doctor` prüft nur, ob er gesetzt ist. Das ist in Local/Free die einzige Key-Voraussetzung von Glirastes; die Kosten pro Chat-Nachricht trägt der App-Betreiber über sein Konto.
- `glirastes init` schreibt die Skripte: `predev: glirastes tools refresh --keep-going`, `prebuild: glirastes tools refresh` (lokal schreibend, in CI frozen, im Docker-Build integrity). Kein `prestart`. Optional `tools refresh --watch` neben `next dev`.
- Ausgabe jedes Refresh: hinzugefügt, geändert, Risiko angehoben, entfernt, braucht Aufmerksamkeit, ausgeschlossen – jeweils mit der nächsten sicheren Aktion.
- Commit: Code, `.glirastes`-Ausgaben und generiertes Modul in einem PR; der Diff von `setup-artifact.json`/`tool-contracts.json` ist der reviewbare Tool-Diff. Merge-Konflikte in generierten Dateien löst ein erneuter Refresh (IDs sind eine reine Funktion von App, `stableKey` und Tombstone-Generation).
- CI-Job `glirastes-tools` ohne Secrets: Install, `glirastes tools check --json` und `glirastes tools eval` (Routing-Regression mit den Beispielsätzen); `--strict` optional per `tools.json ci.strict` (Standard aus, damit Kollegen nicht blockiert werden; offene Tools bleiben deaktiviert und sichtbar). `check` scheitert bei Byte-Drift, unvollständiger Aufzählung, ungültiger Policy oder unbestätigter Lockerung.
- Pro zusätzlich: Workflow-Job `glirastes-tools-enrich` (4.6) mit `contents: write`, Bot-Commits in PR-Branches, Schleifenschutz; ohne Pro-Verbindung bleibt er aus.
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
11. Managed Tool-Generierung (Pro): CI-Key-Scope `ci`; Job-API `POST/GET /v2/apps/:appId/tool-jobs` mit inhaltsfreier Nutzlast; Entitlement- und Monatslimit-Prüfung; kurzlebige OpenRouter-Keys über die Provisioning-API (Chainmatics-Provisioning-Key als Platform-Secret), Widerruf bei Jobende; Ledger-Ingest (Content-Boundary-geprüft); Migration `0045_tool_generation_jobs` (Jobs, Einstellungen, Zustimmung); Citadel: Aktivierung mit Datenpfad-Erklärung, Job-Historie, Kosten, Qualität je Tool, BYOK-Option.

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
- **Prüfung agentischer Einträge (ohne Modell):** vom Coding-Agenten geschriebene Einträge werden akzeptiert bzw. als `resolution-rejected` abgelehnt (fehlender Export, Lockerung, ungültiges/zu großes Schema, unbelegte Schlüssel, Weglassen/Ausschließen von Tools, Inhaltsverstöße, Überschreiben von `locked`); Arbeitslisten von `resolve --print`/`describe --print` sind vollständig und stabil.
- **Skills:** Arbeitslisten-Format und Skill-Anweisungen werden per Test konsistent gehalten; Guard-Phrasen-Tests (`install-skills`, `agent-setup`, `setup-skill-workflow`) bleiben grün; jede Skill hat ein Szenario auf einer Fixture, das der Skill-Runner mit MockLanguageModelV3 strukturell durchläuft; opt-in Live-Eval mit echtem Coding-Agenten (Codex, Claude Code) auf allen drei Fixtures, zugleich die FR-1-Zeitmessung.
- **Skill-Runner (MockLanguageModelV3, Mock-Platform):** läuft nur mit Job-Token oder BYOK in CI; schreibt nur erlaubte Pfade (sonst kein Commit); eine Reparaturrunde; Budget-/Timeout-Stopp; Cache; Denylist-Dateien erreichen nie den Kontext; Ledger ist inhaltsfrei; Bot-Commit und Schleifenschutz; `check` importiert nie `@ai-sdk/openai`. Live-Lauf gegen OpenRouter nur nach Philipps Freigabe.
- **Stufe 2 (MockLanguageModelV3 bzw. vorbereitete Coding-Agent-Ausgaben):** füllt nur Lücken, überschreibt keine `human`/`locked`-Felder; lehnt Schemas mit unbelegten Schlüsseln, ungültige Beispielaufrufe und Risiko-Absenkung ab; Neubeschreibung nur bei geändertem `interfaceDigest`; `tools eval` erkennt Verwechslungen und ist ohne Modell byte-stabil; `--write-contracts` legt nur neue `contract.ts` an, die Stufe 1 danach deterministisch erkennt; ohne Anreicherung bleiben Tools aktiv und die Qualitätsanzeige stimmt; `ci.requireEnrichment` greift.
- **Runtime:** Overlay kann unbekannte/`needs_attention`-IDs nicht aktivieren und Stufe 3 nicht lockern; Revocation blockiert; neues lokales Tool ohne Platform aktiv; fehlendes Binding deaktiviert nur ein Tool; kein Netz pro Turn.
- **Platform:** Job-API (Entitlement, Monatslimit, Key-Erzeugung über gemockte Provisioning-API, Widerruf, inhaltsfreier Ledger, CI-Scope); 422-Grenzmatrix plus Vektorparität, Migration 0044, leere Rollen, Policy-only-Republish, richtungsabhängige Publikation, Report-Scope, Capability-Status, Citadel-Formular.
- **Browser-E2E** für alle drei Fixtures (Vue zusätzlich Styling, Tastatur, Unmount).

## 5. TP2 – Get It Done auf aktuellem `master`

1. **Neuer Branch von `origin/master`** (@296e98e) in neuem Worktree; der Pilot bleibt unverändert als Quelle. Die Foundation-Integration des Pilots (Chat-Handler, Standalone-/Managed-Quelle, Chat-UI, STT) wird auf den Code von `master` portiert.
2. **Codemod** über die Skill `migrating-to-glirastes` mit deterministischem Hilfsskript (`scripts/migrations/ai-tool-to-contract.ts`, nach Gebrauch gelöscht): jedes `ai-tool.ts` wird zu einem `contract.ts` mit denselben Zod-Schemas; Legacy-Toolnamen nach `.glirastes/mcp-tool-names.json` (nur MCP); Beschreibungen mit alten Namen werden umgeschrieben; `allowedRoles` (inkl. `teamleiter`) und `needsApproval` werden zu `tool-policy.json`-Einträgen (nie Lockerung auf Stufe 3); Navigations-/Filterdefinitionen aus `ai-ui-tool.ts` entfallen zugunsten Seitenbaum + Brücke.
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
- **Messung:** Vergleichskorpus mit identischem Modell vorher/nachher (Erfolgsquote, erste Antwort, Gesamtzeit, Modellrunden, Tokens). Live-Läufe mit dem Chat-Modellzugang der Zielapp (OpenRouter-Key von Get It Done) nur nach Philipps Freigabe der Key-Nutzung; bis dahin deterministisches Testmodell.

## 6a. Ergänzung (zur Freigabe): Generisches @- und /-System für jede Zielapp

Wunsch Philipp (2026-10-04): Jede beliebige Zielapp kann vorgeben, mit welchen Dingen und Befehlen man im Chat direkt interagiert. P07 liefert dafür nur die Grundlage (generische Suche für `/` und `@` mit strukturierten IDs). Diese Ergänzung macht daraus ein deklaratives, framework-unabhängiges System, das sich soweit möglich automatisch aus dem Code ableitet.

**Entitäten (`@`).** `defineChatEntity({ type, label: { de, en }, search(query, ctx), resolve?(id), card?, actions? })`. Die Auswahl fügt eine strukturierte Referenz `{ type, id, label }` in die Nachricht ein; das Modell erhält sie eindeutig als Kontext statt eines zu erratenden Namens. Zu jeder Entität erscheinen Kontextaktionen (z. B. „Öffnen“, „Erledigen“, „Zuweisen …“), per Maus und Tastatur erreichbar.

**Befehle (`/`).** `defineChatCommand({ id, label, args?, run })` mit drei Ausführungsarten:

| `run.kind` | Wirkung | Modellaufruf |
| --- | --- | --- |
| `ui` | deterministische UI-Aktion über den UiActionBus (Navigation, Filter, Dialoge) | nein |
| `tool` | ruft ein Tool direkt mit den eingegebenen Argumenten auf – über dieselbe serverseitige Ausführung inkl. Rechte, Rückfrage, Revocation und Budget | nein |
| `prompt` | fügt eine vorbereitete Anweisung ein, die das Modell ausführt | ja |

Argumente können selbst `@`-Referenzen sein (z. B. `/zuweisen @Aufgabe @Person`); fehlende Argumente fragt die UI gezielt ab.

**Automatische Ableitung (Generator, aufbauend auf P04/P05).**
- Entitätssuche aus lesenden Such-/Listen-Endpunkten mit erkanntem Suchparameter und ID-/Label-Feldern im Ausgabeschema (z. B. `GET /api/tasks?search=`).
- Kontextaktionen aus Endpunkten mit einem Pfadparameter dieses Typs (z. B. `PATCH /api/tasks/[id]`).
- Befehle aus UI-Aktionen, Navigation (`/öffne …`) und Filtern (`/filter …`).
- Ausgabe im generierten Modul (`chatEntities`, `chatCommands`); Übersteuerung in `.glirastes/chat-interactions.json` oder im App-Code; Labels, Synonyme und Icons ergänzt Stufe 2 über die Skills (`describing-glirastes-tools`, `building-glirastes-chat-ui`).

**Framework-unabhängig.** Dieselben Definitionen gelten in React (Provider-Props/Hooks) und für `<glirastes-chat>` per JS-API (`el.defineEntity(…)`, `el.defineCommand(…)`) bzw. automatisch aus dem generierten Modul. Die Vue-Fixture nutzt genau diesen Weg.

**Sicherheit.** Suchen laufen mit der Session des Nutzers über die App-Endpunkte; direkte Tool-Befehle nutzen exakt die normale Tool-Ausführung, nichts umgeht Rechte oder Rückfrage. Suchergebnisse und Referenzen gehen nie an die Glirastes-Platform.

**Get It Done.** Ersetzt die hart codierten `UI_COMMANDS` und die app-spezifische Erwähnungssuche (P11).

**Tests.** Ableitung aus den drei Fixtures; `ui`- und `tool`-Befehle laufen ohne Modellaufruf (Mock-Modell wird nachweislich nicht aufgerufen); Tool-Befehle respektieren Rückfrage und Rechte; Referenzen erreichen das Modell strukturiert; Tastatur und ARIA im Browser-Test; React und `<glirastes-chat>` verhalten sich gleich.

Umsetzung als Teilplan P07b nach P07 und P04, vor P11.

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
2. Local/Free brauchen für die Tool-Generierung keinen OpenRouter-Key; agentische Arbeit erledigt der eigene Coding-Agent über Arbeitslisten und Skill.
3. Pro: Managed-Job im CI-Runner mit kurzlebigem, budgetbegrenztem OpenRouter-Key von der Platform (Chainmatics-Rechnung); BYOK optional; Quellcode nur CI → OpenRouter.
4. Modell des Managed-Jobs: `anthropic/claude-sonnet-5.5`, Fallback `openai/gpt-6.1-sol`; 2 USD je Job, Erstbeschreibung bis 8 USD, Monatslimit 25 USD je Tenant bis zur Preisentscheidung.
5. Vorrang: über alle Ebenen gewinnt das Strengste; die Platform kann eine lokale Härtung nicht lockern.
6. CI: `tools check` standardmäßig, `--strict` optional.
7. GID-Migration auf neuem Branch von `origin/master`; konvertierte `contract.ts` sind als Übergang erlaubt, bis Routen damit validieren.
8. Dritte Referenz: Vue 3 + FastAPI, Python 3.12.
9. Metriken-Aufbewahrung technisch konfigurierbar (Standard Free 30, Pro 365 Tage) bis zur Produktentscheidung.
10. Pro-Managed-Job läuft bei Pushes auf PR-Branches, wenn Lücken bestehen; Ergebnisse als Bot-Commit in den PR-Branch, bei `main` als PR.
11. Von Hand gepflegte oder als `locked` markierte Beschreibungen und Schemas überschreibt der Agent nie.
12. `--write-contracts` (Agent legt `contract.ts` an) ist standardmäßig aus; `ci.requireEnrichment` ebenfalls.
13. Modellzugang der Zielapp: Standard OpenRouter über `OPENROUTER_API_KEY` in der App-Umgebung, andere AI-SDK-Provider konfigurierbar; Kosten pro Chat-Nachricht beim App-Betreiber.
14. Ausführung der Skills in Pro durch den Glirastes-Skill-Runner (eng begrenzte Werkzeuge, jedes OpenRouter-Modell). Alternative: headless Codex CLI mit OpenRouter-Provider und denselben Skills; nicht gewählt, weil sie Shell-Zugriff im CI-Runner mitbringt.

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
- OpenRouter: Modellverfügbarkeit, Kosten, ablaufende Slugs; `zdr`/`require_parameters` können Anbieter ausschließen; der Managed-Service braucht einen Chainmatics-Provisioning-Key (Einrichtung durch Philipp). Der Status des App-Keys von Get It Done (früher 403 „Key limit exceeded“) ist unbekannt; Live-Nachweise brauchen Philipps Freigabe.
- Qualität der Free-Anreicherung hängt vom Coding-Agenten des Entwicklers ab; abgesichert durch die einheitliche Prüfung und `tools eval`.
- Skills können gegenüber CLI und Formaten veralten; Abhilfe: Konsistenztests, Versionierung mit dem Paket, Szenario- und Live-Evals.
- Der Pro-Job braucht Schreibrechte im Repo des Kunden; Bot-Commits müssen zu Branch-Schutzregeln passen.
- Echter Nutzertest bleibt eine menschliche Aufgabe.

## 13. Aufwand und Vorgehen

Grobe Schätzung in Entwicklertagen (menschliches Äquivalent): TP0 3, TP1 60 (davon Skills, Stufe 2 und Skill-Runner rund 10), TP2 8, TP3 12, TP4 19 (davon Managed-Service rund 4), TP5 4, TP6 3 – zusammen rund 109. Umsetzung durch orchestrierte Agenten in isolierten Worktrees, Phase für Phase mit lokalen Commits, grünen Gates und einem Checkpoint-Bericht nach jeder Phase. Freigaben, die ich unterwegs einhole: Backup-Push, Einrichtung eines OpenRouter-Provisioning-Keys, Live-Läufe mit OpenRouter, Merges, Veröffentlichung, Deployments.
