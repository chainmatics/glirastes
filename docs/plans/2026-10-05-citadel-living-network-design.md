# Citadel-Redesign „Living Network v3“: Design

Version: 1.2 (Entscheidungen Philipps vom 2026-10-05 eingearbeitet) · Stand: 2026-10-05 · Status: Entwurf zur Freigabe durch Philipp · Umsetzung: Teilplan P08c (Platform `mvp-platform`)

Änderungen:
- 1.1: Gegenprüfung gegen API-Code @ `9014587`, P09-Plan und Prototyp eingearbeitet.
- 1.2: Philipps Entscheidungen vom 2026-10-05 (Lockern der Rückfrage bis Stufe 2 im Dashboard, Fehlerregel verbindlich, Deutsch und Englisch zum MVP, Expertenrouten zum Release ausgeblendet) und zwei Standardentscheidungen des Controllers (Versionszählung, Landing-Renderer), Abschnitt 8.3. Neu: 2.4 (Sprachen), D16 (wirksame Platform-Lockerung). Gegengeprüft gegen API @ `9014587` und SDK `codex/mvp-tools` @ `dd6c175`.

Grundlage:
- Freigegebener Prototyp `/Users/philipprollmann/Dev/chainmatics/.archives/glirastes-living-network-design-v3-landing-2026-10-05/` (`index.html`, `README.md`, `src/`, `shots/`). Philipp am 2026-10-05: „Design sieht gut aus“.
- [MVP-Abschluss-Design v1.4](2026-10-04-mvp-completion-design.md), Abschnitte 4.2, 4.5, 4.9, 4.10, 6a, 7.
- [Roadmap](2026-10-04-mvp-plan-00-roadmap.md), Zeilen mit Zuständigkeit P08c.
- [P08b-Plan](2026-10-05-mvp-plan-08b-platform-backend.md), Task 8, Task 14, Checkpoint Punkt 4, sowie der Code auf `codex/mvp-platform` @ `9014587` (`apps/api/src/modules/runtime-setup-v2/*`, `runtime-revisions/*`, `runtime-deployments/*`, `runtime-connect/*`, `apps/*`, `audit/*`, `stream/*`).
- SDK-Code auf `codex/glirastes-foundation-runtime` und `codex/mvp-tools` @ `dd6c175` (`src/runtime/policy-overlay.ts`, `src/runtime/turn-snapshot.ts`, `src/contracts/tool-policy.ts`, `src/codegen/tools/pipeline.ts`), [P04-Plan](2026-10-05-mvp-plan-04-navigation-filters-ui.md), Ziel 1, und Spec 4.9 und 10 Punkt 5 (für D16).
- Entscheidungen Philipps vom 2026-10-05 (Abschnitt 8.3).
- [P09-Plan](2026-10-05-mvp-plan-09-metrics.md), Teil B (Tasks 6–13), Checkpoint Punkt 4. Die Metrik-Endpunkte existieren auf `codex/mvp-platform` noch nicht.
- Citadel-Code auf `codex/mvp-platform` (`apps/citadel`): Routen `/manage`, `/connect`, `/connect/pair`, `/settings/*`, Foundation-Profil `src/lib/product-profile.ts`, `components/ui/*` (shadcn `base-nova` auf Base UI), Tailwind 4, `components/landing/landing.css`.
- Restliste der letzten Prüfung: `.superpowers/sdd/controller.md`, Abschnitt „2026-10-05 12:55“.
- Prüfskripte des Prototyps: im Archiv unter `.archives/glirastes-living-network-design-v3-landing-2026-10-05/checks/` (`audit.mjs`, `contrast2.mjs`, `build.mjs`, `tmp/fold.mjs`, `tmp/ovf.mjs`, `tmp/forced.mjs`, `tmp/interact-v3b.mjs`, `tmp/probe-v3b.mjs` u. a.; am 2026-10-05 vom Controller unverändert aus dem Arbeitsverzeichnis der Design-Sitzung kopiert). P08c portiert sie (Abschnitt 7).

Dieses Dokument legt fest, wie der Prototyp in Citadel gebaut wird. Wo es vom Prototyp abweicht, steht das ausdrücklich da. In der Regel liegt das daran, dass der Prototyp Daten zeigt, die die API nicht liefert.

---

## 1. Ziel und Freigabe

### 1.1 Ziel

Citadel beantwortet im Foundation-Profil die fünf Nutzerfragen aus Spec 7 für Nicht-Experten, auf Deutsch und Englisch (2.4), in der Marke von glirastes.io: gleiche Farben, gleiche Schriften, und das Netz des Landing-Heros als Statusanzeige. Grundlage sind ausschließlich echte API-Daten. Jede Aussage auf dem Bildschirm lässt sich auf ein Feld zurückführen. Was die API nicht liefert, erscheint nicht, und das UI kündigt es auch nicht an.

### 1.2 Was freigegeben ist

Freigegeben ist der Stand v3, Runde 2, aus dem Archiv:

| Bereich | Freigegebener Inhalt |
| --- | --- |
| Bildsprache | Die Palette der Landingpage, Dunkel als Standard, Hell abgeleitet und nachrangig. Drei Schriften (Geist, JetBrains Mono, Instrument Serif). Radien 8/12/20. Amber-Morgenlicht, Punktraster, Glühen. Netz mit weißglühendem Kern, glühenden Hyphen, Knospen und Kometen (Abschnitt 3). |
| Informationsarchitektur | Fünf Bildschirme (Übersicht, Was kann mein Chat?, Kosten & Nutzung, Historie & Rollback, Verbinden), Seitenleiste mit App-/Umgebungswechsel, der „Faden“ mit fünf Antworten, Ledger-Abschnitte auf einem 12-Spalten-Raster. |
| Zustandslogik | Jeder Zustand dreifach codiert (Farbe, Form, Wort). Der schwerste Zustand gewinnt. Eine Ursache ist genau einmal rot, mit genau einer Wirkung; alles, was daraus folgt, verweist mit „Bekannt“ zurück. Zählregel „1 Fehler“ plus ein leises „+5 prüfen“. |
| Interaktion | Drawer pro Tool (erst Behebung, dann Nutzung, dann „Strenger machen“; seit Version 1.2 dieser Spec „Regeln ändern“ mit Lockern der Rückfrage bis Stufe 2, 4.2.4). Riskante Bestätigungen öffnen sich auf „Abbrechen“. Ehrlicher Zwischenzustand bis zur Bestätigung durch den Runner. ⌘K-Palette, `G`-Kürzel, abschaltbare Einzeltasten. |
| Qualitätsniveau | WCAG AA in beiden Themes, Forced Colors, Reduced Motion. Kein horizontales Scrollen zwischen 320 und 1440 px. Die fünfte Antwort steht im ersten Viewport. Prüfwerte der letzten Verifikation: Markentreue 9,3, Eleganz 8,8, Klarheit 9,1. |

Prototyp: `/Users/philipprollmann/Dev/chainmatics/.archives/glirastes-living-network-design-v3-landing-2026-10-05/index.html`. Referenzbilder: `shots/final/showcase-1.png` … `showcase-6.png`, `showcase-3b.png` und `shots/compare-v3b-*.png`. Quelltexte: `src/tokens.mjs` (einzige Quelle der Farb-Tokens), `src/c-net.js` (Netzgeometrie), `src/d-overview.js`, `src/e-tools.js`, `src/f-views.js`, `src/g-app.js`, `src/style.css`.

### 1.3 Was der Prototyp nicht ist

- **Keine echten Daten.** Alles ist Mock aus `src/a-core.js` und `src/b-state.js`: Get It Done mit 95 Tools, Euro-Beträge, 4.812 Aufrufe, „So, 4. Okt. 14:21“, Lea Brandt, die Rollen Admin/Projektleitung/Mitglied/Gast, „172 Aufrufe in Staging“, p95 pro Tool. Auch die Szenarien `ok | pending | stale | error` werden per Schalter gesetzt.
- **Kein Code zum Übernehmen.** Der Prototyp ist eine einzelne HTML-Datei mit Vanilla-JS-Templates. Citadel baut ihn in React neu (Abschnitt 5). Übernommen werden Werte (Tokens, Geometrie, Maße, Timings) und Regeln, keine Templates.
- **Teile der Prototyp-Copy sind durch die API nicht gedeckt.** Diese Sätze entfallen oder werden umformuliert (Abschnitt 4):

| Prototyp-Aussage | Warum nicht | Ersatz |
| --- | --- | --- |
| „Ja, 2 Server“, „Server 2 noch auf 0.9.1“ | `runtime_runners` hat pro Umgebung genau eine Zeile (`runtime_runners_environment_unique`); Instanzen sieht nur die Metrik-Dimension `instanceId` | „Verbunden“ plus Runner-Version, sobald D1 geliefert ist |
| „Wir prüfen die Fehlerquote jede Minute. Steigt sie über 2 %, melden wir uns sofort.“ | Es gibt keinen Alarm- oder Benachrichtigungsdienst | Der Wert wird angezeigt, ein Versprechen gibt es nicht (Nicht-Ziel, Abschnitt 8) |
| „wirkt in 5 s“, „Noch etwa 5 Sekunden“ | Die Zeit bis zur Bestätigung durch den Runner ist nicht gemessen | „wirkt nach Bestätigung des Runners“ plus mitlaufende Sekunden |
| „Gilt sofort, ohne neue Version“ | Eine Entscheidung erzeugt eine Policy-only-Konfigurationsrevision und braucht ein Apply (P08b Task 8) | „Wirkt nach dem Anwenden, als Version vN (nur Regeln, kein Code)“ |
| Euro, Budget 200 €, Hochrechnung „71 %“ | Die Metrik-API rechnet in USD; ein Monatsbudget gibt es nicht | USD; der Budget-Abschnitt entfällt (D10) |
| „Daten in der EU, Frankfurt“ | Für Citadel nicht belegt | Entfällt, bis ein belegter Wert konfiguriert ist |
| p95 pro Tool, 7-Tage-Balken pro Tool | Latenz misst P09 nur pro Turn; eine Tagesreihe pro Tool gibt es nicht | Aufrufe und Fehler pro Tool, Reihe nach D6 |
| „Dein Chat ist gerade ohne Tools“, Chat-Antwort „Gerade gar nichts“, „bisher 17 Anfragen abgelehnt“ | Ein stiller Runner heißt nur, dass die Platform nichts hört. Der Chat läuft in der App und fragt die Platform pro Turn nicht (Spec 4.12); ob die App steht oder nur die Platform nicht erreicht, ist unbekannt. Abgelehnte Anfragen eines stillen Runners zählt niemand | „Deine App meldet sich seit {hh:mm} nicht.“; Chat-Antwort „Unbekannt“ (off), Abschnitt 4.1.3 |
| Server-Zeilen, „Region EU, Frankfurt“, „Antwortzeit zu Glirastes 42 ms“, Lebenszeichen-Leiste über 60 Minuten | Es gibt nur `lastSeenAt` pro Umgebung, keine Latenz und keine Herzschlag-Historie | Fakten aus `environments`, `healthStatus` des aktiven Deployments und D1 (4.1.9) |
| „von Lea Brandt“, „synchronisiert von …“, „Angewendet von …“ | Die Deployment-Liste nennt keinen Menschen; Akteure stehen nur im Audit, für Dashboard-Nutzer tenantweit | Entfällt bis D7 |
| „Neustart-Befehl kopieren“ (`glirastes runner restart`), „Befehl für Server 2 kopieren“ (`glirastes runner update`) | Diese CLI-Befehle gibt es nicht (Spec 4.2) | Text „App in {Umgebung} neu starten“, ohne Befehl |
| „in Staging ohne Fehler“, „172 Aufrufe in Staging“ | Für eine noch nicht angewendete Regel-Revision gibt es keine Messwerte | Entfällt; Pro zeigt nur „In {Vorumgebung} aktiv“ (4.1.7) |
| „wird oft falsch aufgerufen“ als Prüf-Grund | `tool_contract_rejected` kommt erst mit P05 | Entfällt bis P05 |
| Änderungsliste pro Version in Historie und Rollback-Dialog („fällt weg“, „kommt zurück“) | Kein Endpunkt vergleicht zwei Konfigurationen; `capabilities` vergleicht nur den Code-Bericht mit der laufenden Konfiguration | Nur für den bereiten Stand aus `capabilities` (4.1.6); sonst D15 |
| „Sa, Feiertag“, Wochentags-Täler | Keine Feiertagsquelle | Nur Wochenende/Werktag aus dem Datum |
| „▲ FEHLER … ABGELEHNT“ | P09 zählt fehlgeschlagene Tool-Aufrufe und Turns mit `status = error`, keine Ablehnungen | „FEHLGESCHLAGEN“ (4.1.3) |

- Der Szenario-Umschalter, `?s=`, `?proto=`, `?still=` und die Telefon-Vorschau gehören nur zum Prototyp. Für Tests gibt es stattdessen API-Fixtures (Abschnitt 7).

---

## 2. Informationsarchitektur

### 2.1 Navigation

```
Seitenleiste (264 px; ab ≤ 1180 px off-canvas)
├─ Marke: LogoMark + „Glirastes“ (Geist 600) + Mono-Tag „Citadel“   → /manage
├─ App-/Umgebungswechsel: App-Kachel (Amber-Spross), App-Name, Umgebung
├─ Hauptnavigation
│   ├─ Übersicht               /manage           G O
│   ├─ Was kann mein Chat?     /manage/tools     G T   Badge: Glyphe + Zahl (schwerster Zustand)
│   ├─ Kosten & Nutzung        /manage/usage     G K
│   ├─ Historie & Rollback     /manage/history   G H
│   └─ Verbinden               /connect          G V
├─ Eyebrow „Arbeitsbereich“
│   ├─ Einstellungen           /settings
│   └─ Team                    /settings/team
└─ Fuß: „Free-Plan · 1 von 1 App“ bzw. „Pro-Plan“ (aus /v1/tenant und /v1/apps)

Kopfleiste (sticky, --bg mit 80 %, Blur 12 px)
  Menü-Knopf (≤ 1180) · Breadcrumb „<App> / <Seite>“ · Suche ⌘K · Theme-Schalter · Avatar
  Avatar öffnet das Nutzermenü: E-Mail · Sprache „Deutsch“ / „English“ (Auswahl, 2.4) · Abmelden
```

- Die aktive Seite ist eine Zeile in `--card-2` mit Radius 8, Schrift `ink` in 500, ohne Zustandsfarbe (`aria-current="page"`). Ein Zustand erscheint nur als Badge rechts: Glyphe + Zahl, der schwerste gewinnt („◆ 5“, „▲ 1“). Im Zustand stale zeigt „Was kann mein Chat?“ das hohle Still-Quadrat ohne Zahl statt des Prototyp-Badges „▲ alle“, weil über den Chat nichts bekannt ist (1.3). Die Wörter stehen im zugänglichen Namen („Was kann mein Chat?, 1 Fehler, dazu 5 prüfen“) und im Tooltip.
- Die bisherigen Foundation-Navigationspunkte (`Connected`, `Connect`, `Approvals`, `Audit Stream` in `components/sidebar.tsx`) werden ersetzt.
- **Expertenrouten sind zum Release ausgeblendet** (Philipp, 2026-10-05). `/runtime-setup`, `/rollouts`, `/revisions`, `/approvals` und `/audit-stream` sind im Foundation-Profil nicht routbar: Die Middleware leitet sie auf `/manage` um (2.2). Sie haben keinen Sidebar-Eintrag, keinen Palette-Eintrag (4.1.10) und keine Links aus Foundation-Seiten; „Technische Details“ in Drawer und Historie zeigen nur Daten, keine Links. Grund: Bis D8 kann das Promote in `/rollouts` gespeicherte Entscheidungen weglassen. Das gilt, bis P08d das Promote entscheidungserhaltend gemacht hat (D8); das Wiedereinblenden ist danach eine eigene, freizugebende Änderung.
- Das Profil `full` behält seine Navigation. Es bekommt durch die Token-Aliase das neue Aussehen, wird aber nicht umgestaltet (Abschnitt 8).

### 2.2 Routen und Foundation-Profil

| Bildschirm | Route | Bestehende Citadel-Route | Änderung in `product-profile.ts` |
| --- | --- | --- | --- |
| Übersicht | `/manage` | `/manage` (ersetzt den Inhalt von `app/(dashboard)/manage/page.tsx`) | `/manage` wird Präfix statt exakter Route |
| Was kann mein Chat? | `/manage/tools` (`?tool=<toolId>` öffnet den Drawer; Filter `q`, `view=all\|attn\|approval\|changed\|new`, `risk=0\|1\|2\|3`, `module`) | neu; ersetzt im Foundation-Profil die Tool-Ansicht in `/runtime-setup` (ausgeblendet, 2.1) | durch das Präfix `/manage` abgedeckt |
| Kosten & Nutzung | `/manage/usage` (`?range=month\|7d\|30d\|12m`, `split=tool\|environment\|revision\|model`, Filter `revision`, `model`) | neu (der Name folgt dem Prototyp-NAV) | durch das Präfix `/manage` abgedeckt |
| Historie & Rollback | `/manage/history` (`?filter=all\|version\|manual\|incident`; `manual` = „Änderungen von Hand“, strenger wie gelockert, 4.4) | neu; ersetzt im Foundation-Profil `/rollouts` (ausgeblendet, 2.1) | durch das Präfix `/manage` abgedeckt |
| Verbinden | `/connect`, `/connect/pair?user_code=XXXX-XXXX` | bestehend; `verificationUri` der API zeigt schon auf `/connect/pair?user_code=` | unverändert |
| Einstellungen | `/settings`, `/settings/apps`, `/settings/api-keys` | bestehend | unverändert; der Optimizer-Abschnitt von `/settings` wird im Foundation-Profil ausgeblendet |
| Team | `/settings/team` | bestehend | unverändert |
| Expertenrouten | `/runtime-setup`, `/rollouts`, `/revisions`, `/approvals`, `/audit-stream` | bestehend | Die fünf Expertenpräfixe fallen aus `FOUNDATION_ROUTE_PREFIXES`; dort steht danach nur `/manage` (erste Zeile). `isProductRouteVisible` meldet sie im Foundation-Profil als unsichtbar, die Middleware leitet auf `dashboardLandingPath` um (2.1, bis D8). Das Profil `full` bleibt unverändert |

`dashboardLandingPath('foundation')` bleibt `/manage`.

Gemeinsamer URL-Zustand auf allen `/manage/*`-Routen ist `?env=<environmentId>`. Die App kommt wie bisher aus dem `AppContext` (`localStorage`). Fehlt `env`, gilt:
- **Free:** die einzige Umgebung (Free erlaubt 1 App und 1 Umgebung, `platform-entitlement.service.ts`, `connected_free_limit_reached`).
- **Pro:** die zuletzt gewählte Umgebung dieser App (pro App gemerkt, `localStorage` in try/catch), sonst die Umgebung mit der höchsten `promotionOrder`.

### 2.3 Die fünf Fragen und ihre Datenquellen

Die Fragen im UI sind die Kurzformen des Prototyps. Die rechte Spalte nennt die Formulierung aus Spec 7.

| # | Frage (UI) | Thema im Netz | Spec 7 | Antwort aus (Endpunkt → Felder) | Abhängigkeit |
| --- | --- | --- | --- | --- | --- |
| 1 | Ist meine App verbunden? | Verbindung | Ist meine App verbunden? | `GET /v2/apps/:appId/runtime-setup/connected-overview?environmentId=` → `connection` (`connected`/`stale`/`disconnected`, frisch ≤ 90 s, `CONNECTED_FRESHNESS_MS`), `runtimeHealth` (`unknown`/`healthy`/`degraded`/`unhealthy`), `productMode`. `GET /v1/apps/:appId/environments` → `lastSeenAt`, `status`, `kind`, `name`, `promotionOrder`. `deployments` → `healthStatus` des Eintrags mit `status = active` (4.1.3) | D1 (Runner-Version, letzter angewandter Stand) |
| 2 | Was kann mein Chat? | Tools | Was kann mein Chat? | `GET /v2/apps/:appId/environments/:environmentId/capabilities` → `tools[]` mit `riskClass`, `enabled`, `requiresApproval`, `status`, `warnings`, `decisionPending`, `relaxationPending`, `quality`; `codeVersion`. Fehler pro Tool: `GET /v2/apps/:appId/metrics` → `tools[]` (`calls`, `errors`) | D4 (`module`, `title`), D13 (P09) |
| 3 | Gibt es eine neue Version? | Version | Sind meine Änderungen verfügbar? | `connected-overview` → `action` (`apply`/`resume`/`sync`/`none`), `candidate`, `activeDeployment`. `capabilities` → Zählung von `status` (`new`/`changed`/`risk-raised`/`removed`), `decisionPending`, `comparedTo`. `GET /v1/apps/:appId/environments/:environmentId/deployments` → `configRevisionId`, `activatedAt` | D2 (Versionsnummer), D3 (`pendingChange`) |
| 4 | Was kostet es? | Kosten | Was kostet die Nutzung? | Übersichtsfenster `GET /v2/apps/:appId/metrics?environmentId=&from=<min(Monatsanfang, heute − 30 Tage), 00:00 UTC>&granularity=day` → `series[]` (pro UTC-Tag `cost.knownUsd`, `providerReportedUsd`, `priceTableUsd`, `unknownCostTurns`, `turns`, `errorTurns`, `toolErrors`), `range`, `retention`, `tools[]`. Monatssumme = Summe der Tage ab Monatsanfang; Hochrechnung aus den letzten 7 vollständigen Tagen derselben Reihe | D13 (P09) |
| 5 | Gibt es ein Problem? | Probleme | Wie behebe ich ein Problem oder gehe zurück? | abgeleitet aus 1–3 plus `metrics?revisionId=<agentRevisionId>&from=<activatedAt>` (`errorTurns`, `turns`, `toolErrors`, `toolCalls`, `tools[]`). `agentRevisionId` und `activatedAt` stammen aus dem `deployments`-Eintrag mit `id = ov.activeDeployment.id` (`connected-overview` liefert nur `id` und `activatedAt`). Rückweg aus `deployments` nach der Regel in 4.1.2 | D2, D8 |

Die Übersicht lädt fünf Anfragen parallel: `environments`, `connected-overview`, `capabilities`, `metrics` (Übersichtsfenster) und `deployments`. Danach folgen höchstens zwei abhängige Metrik-Abfragen für die Fehlerbedingung (aktive Version seit Aktivierung; die vorige Version nur, wenn die aktive über der Schwelle liegt, 4.1.3). Einmal pro Sitzung kommen `GET /v1/tenant` (Plan), `GET /v1/apps` (App-Zahl) und `GET /v1/tenant/team` (eigene Rollen, Abschnitt 4) dazu. Die Antworten berechnet ein reines View-Model, `lib/view-models/overview.ts` (Abschnitt 4.1). Netz, Faden, Hero, Ledger, Seitenleisten-Badges und Kicker lesen alle dasselbe Ergebnis. So steht jede Tatsache an genau einer Stelle und kann sich nicht widersprechen.

### 2.4 Sprachen: Deutsch und Englisch

Philipp am 2026-10-05: „Beides zum MVP“. Die Foundation-Oberfläche von Citadel (alle Routen aus 2.2 außer den Expertenrouten, dazu `(auth)`) erscheint zum MVP auf Deutsch und Englisch. Die Landingpage bleibt englisch.

| Thema | Festlegung |
| --- | --- |
| Kataloge | Alle sichtbaren Texte, zugänglichen Namen, `aria-valuetext`, Tooltips, Toasts, `document.title` und Metadaten stehen in zwei typisierten Katalogen: `src/lib/copy.de.ts` (Referenz; daraus der Typ `Copy`, ohne `as const`, damit die Werte `string` sind und nicht die deutschen Literale) und `src/lib/copy.en.ts` (`export const en = { … } satisfies Copy`). `satisfies` lehnt fehlende und überzählige Schlüssel zur Compile-Zeit ab. Die Kataloge sind reine Daten: Strings mit benannten Platzhaltern (`{n}`, `{tool}`) und Pluralobjekte `{ one, other }`, die `t()` über `Intl.PluralRules` der gewählten Sprache auflöst. Keine i18n-Bibliothek. |
| Texte dieser Spec | Die deutschen Texte in den Tabellen dieser Spec sind die Referenz für `copy.de.ts`. Die englischen Texte stehen nur in `copy.en.ts`; sie sagen dasselbe, mit denselben Platzhaltern und ohne zusätzliche Aussagen (1.1). Die Kernbegriffe legt das Glossar unten fest. |
| View-Models | View-Models geben Textschlüssel mit Werten zurück (`CopyRef = { key, values }`), keine fertigen Sätze. Erst die Komponente macht daraus mit `t()` und `format.ts` Text in der gewählten Sprache. Die Sprache ändert also keine Logik. |
| Umschalten | Im Nutzermenü (Avatar, 2.1) und in der Palette (4.1.10). Jede Option trägt ihren Namen in der eigenen Sprache („Deutsch“, „English“). Die Wahl wirkt sofort: Cookie setzen, `document.documentElement.lang` setzen, `router.refresh()`. Es gibt keinen Seitenwechsel und keinen Verlust von Filtern oder Drawer-Zustand. Anmelden und Registrieren (`(auth)`) haben keinen Umschalter; sie folgen dem Cookie bzw. `Accept-Language`. |
| Speicherung | Cookie `citadel-locale` (`de` \| `en`; `Path=/`, `Max-Age` 1 Jahr, `SameSite=Lax`, in Produktion `Secure`). Die Wahl gilt damit pro Browser; eine Speicherung am Nutzerkonto gibt es zum MVP nicht. Ein Cookie statt `localStorage`, weil der Server Sprache und `<html lang>` schon beim ersten Rendern braucht (kein Aufblitzen der falschen Sprache). Andere Cookie-Werte werden ignoriert. |
| Standard | Ohne gültiges Cookie entscheidet `Accept-Language`: Beginnt die Sprache mit dem höchsten `q`-Wert (bei Gleichstand die erste) mit `de`, gilt Deutsch, sonst Englisch. Fehlt der Header oder ist er ungültig, gilt Englisch. Eine reine Funktion `resolveLocale(cookie, acceptLanguage)` in `src/lib/i18n/locale.ts` entscheidet das. |
| `<html lang>` | Die Gruppen `(dashboard)` und `(auth)` haben eigene Root-Layouts mit `<html lang={locale}>`; die Landing (`(marketing)`) hat ein eigenes Root-Layout mit `<html lang="en">` und bleibt statisch. `app/layout.tsx` entfällt (5.3). Der Wechsel zwischen Landing, Anmeldung und Dashboard ist damit ein voller Dokumentwechsel; das ist gewollt. Ohne gemeinsames Root-Layout braucht eine unbekannte URL eine eigene 404: `app/global-not-found.tsx` (Next 15.5, `experimental.globalNotFound`) mit eigenem `<html lang>` aus `resolveLocale`; ein Playwright-Test ruft eine unbekannte URL auf. |
| Auslieferung | Das Server-Layout gibt nur den Katalog der gewählten Sprache an einen Client-`CopyProvider`; der andere Katalog wird nicht ausgeliefert (Budget 6.2). |
| Formate | `src/lib/format.ts` formatiert Zahlen, Prozente, Beträge (USD), Datum, Uhrzeit und relative Zeiten über `Intl` mit `de-DE` bzw. `en-US` (Abschnitt 4). |
| Nicht übersetzt | Tool-Namen, Beschreibungen und Bereiche aus der App (wie gemeldet; ein lokalisierter `title` nach D4 in der gewählten Sprache, sonst der vorhandene), IDs, Digests, Befehle und Codeblöcke (`translate="no"`), Versionsnummern, Produktnamen (Glirastes, Citadel, Runner). API-Fehlertexte erscheinen nie roh: Jede bekannte Antwort hat einen Katalogeintrag (4.1.6, 4.2.4, 4.5); eine unbekannte zeigt einen allgemeinen Katalogtext mit dem HTTP-Status. |
| Kürzel | `G O`, `G T`, `G K`, `G H`, `G V`, `U`, `/`, `?`, ⌘K und ⌘Z sind in beiden Sprachen gleich (6.1). |

Glossar (verbindlich für `copy.en.ts`):

| Deutsch | Englisch |
| --- | --- |
| Übersicht · Was kann mein Chat? · Kosten & Nutzung · Historie & Rollback · Verbinden · Einstellungen · Team | Overview · What can my chat do? · Cost & usage · History & rollback · Connect · Settings · Team |
| Ist meine App verbunden? · Gibt es eine neue Version? · Was kostet es? · Gibt es ein Problem? | Is my app connected? · Is there a new version? · What does it cost? · Is there a problem? |
| Gesund · Bereit · Neu im Code · Prüfen · Fehler · Bekannt · Getrennt · Still | Healthy · Ready · New in code · Review · Error · Known · Disconnected · Quiet |
| Fragt vorher · Eingeschränkt · Gelockert · Geändert · Risiko gestiegen | Asks first · Restricted · Relaxed · Changed · Risk raised |
| Liest nur · Liest Sensibles · Ändert Daten · Löscht · Versendet / extern · Bezahlt · Nicht eingeordnet | Reads only · Reads sensitive data · Changes data · Deletes · Sends / external · Pays · Not classified |
| Anwenden · Fortsetzen · Zurückkehren · Rückgängig machen · Regeln ändern · Auf den Code-Wert zurück | Apply · Resume · Roll back · Undo · Change rules · Back to the code value |
| Wartet auf den Runner · Nicht angewendet · Was wir geprüft haben · Rückweg | Waiting for the runner · Not applied · What we checked · Way back |

---

## 3. Bildsprache und Tokens

### 3.1 Herkunft und Theme-Mechanik

- `src/tokens.mjs` aus dem Prototyp wird unverändert in den Werten nach `apps/citadel/src/design/tokens.mjs` übernommen und ist dort die einzige Quelle. Ein Skript `apps/citadel/scripts/build-tokens.mjs` erzeugt daraus `src/app/tokens.css`. Die Datei ist generiert und eingecheckt; ein Test prüft im Modus `--check`, dass sie zum Quelltext passt. Die Ausgabe hat genau zwei Regeln:
  - `:root, [data-theme="dark"] { …dunkel… }`
  - `[data-theme="light"] { …hell… }`

  Jede der beiden Regeln enthält alle Farb-Tokens (`COLORS`), die themenabhängigen Werte (`THEMED`) **und** alle Aliase: die shadcn-Aliase (`SHADCN`), die Landing-Aliase (`LANDING`) und `--primary-soft`. Die Aliase stehen also nicht nur einmal auf `:root`. Grund: Eine Custom Property wie `--fg: var(--ink)` wird an dem Element aufgelöst, an dem sie deklariert ist, und als fertiger Wert vererbt. Stünden die Aliase nur auf `:root`, erbte der dunkle Landing-Wrapper (`[data-theme="dark"]`) unter einem hellen `<html data-theme="light">` die hellen Werte von `--fg`, `--background` usw. Ein Playwright-Test prüft das: Landing bei `citadel-theme = light` hat für `--fg`, `--card`, `--primary` und `--border` die Dunkel-Werte.
  - Die Prototyp-Zeile `--radius: 12px; --radius-sm: 8px; --radius-lg: 20px` aus `tokenCSS()` wird **nicht** übernommen; sie kollidierte mit Tailwinds `--radius-*`. Die Radien regelt 3.4.
- **Dunkel ist Standard.** `next-themes` mit `attribute="data-theme"`, `defaultTheme="dark"`, `enableSystem={false}`, `storageKey="citadel-theme"`. Das hart gesetzte `className="dark"` in `app/layout.tsx` entfällt mit der Datei (Root-Layouts pro Gruppe, 2.4). Tailwind:
  - `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`
  - `@custom-variant light (&:where([data-theme=light], [data-theme=light] *));`
- **Gemeinsam mit `landing.css`.** `.landing` deklariert seine Palette nicht mehr selbst, sondern liest die Tokens über die Landing-Aliase (`--fg`, `--fg-muted`, `--fg-dim`, `--card`, `--card-2`, `--border-strong`, `--primary-dim`, `--teal`, `--blue`, `--violet`, `--red`). Der Wrapper im `(marketing)`-Layout bekommt `data-theme="dark"`, damit die Landingpage dunkel bleibt, auch wenn jemand Citadel hell nutzt (das Theme liegt in `localStorage` derselben Origin). Innerhalb von `.landing` werden keine Tailwind-Varianten `dark:`/`light:` verwendet, weil dort beide Varianten zugleich passen würden (`<html data-theme="light">` als Vorfahr und der dunkle Wrapper). Die Werte im Dunkel-Theme sind identisch mit dem heutigen `landing.css`; die Landingpage ändert sich also um keinen Pixel (Screenshot-Gleichheitstest, Abschnitt 7). Die Radien der Landingpage (`--radius*`) bleiben auf `.landing` beschränkt (siehe 3.4).
- **Hell ist abgeleitet und nachrangig.** Gleiche Farbtöne auf neutralem Off-White, kein Glühen, flaches Netz. Es gelten dieselben Zustände, Formen und Prüfungen wie im Dunkel-Theme; Referenz für Design-Abnahmen bleibt aber Dunkel.

### 3.2 Farb-Tokens (exakt aus `tokens.mjs`)

| Token | Alias (shadcn · Landing) | Dunkel (Standard = Landing) | Hell (abgeleitet) | Rolle |
| --- | --- | --- | --- | --- |
| `bg` | `--background`, `--sidebar` | `oklch(0.09 0 0)` | `oklch(0.976 0 0)` | Seite |
| `bg-elevated` | – | `oklch(0.11 0.003 70)` | `oklch(0.988 0 0)` | Off-canvas-Seitenleiste |
| `surface-1` | `--card`, `--popover` | `oklch(0.13 0.004 70)` | `oklch(0.995 0 0)` | Karten: Diagnose, Dialoge, Drawer, Palette, Faden- und Kicker-Pills |
| `surface-2` | `--muted`, `--accent`, `--secondary`, `--sidebar-accent`, `--card-2` | `oklch(0.155 0.005 70)` | `oklch(0.955 0 0)` | Ghost-Chips, Suchfeld, Chart-Tooltip, Toast (dunkel) |
| `surface-3` | – | `oklch(0.19 0.005 70)` | `oklch(0.925 0 0)` | gedrücktes Segment, Tasten-Tooltip, Disabled-Fläche, Meter-Spur |
| `line` | `--border`, `--sidebar-border` | `oklch(1 0 0 / 8%)` | `oklch(0 0 0 / 9%)` | Haarlinien, Kartenränder |
| `line-2` | `--border-strong` | `oklch(1 0 0 / 14%)` | `oklch(0 0 0 / 15%)` | Abschnittslinien, Rand des Sekundärknopfs, Spitzenringe, Pill-Ränder |
| `input` | `--input` | `oklch(0.52 0 0)` | `oklch(0.60 0 0)` | 3:1-Kante: Switch, Checkbox, Radio, gewähltes Segment (hell) |
| `ink` | `--foreground` und alle `*-foreground` außer primary/destructive/muted, `--fg` | `oklch(0.985 0 0)` | `oklch(0.17 0 0)` | Text |
| `ink-2` | `--muted-foreground`, `--fg-muted` | `oklch(0.72 0 0)` | `oklch(0.42 0 0)` | Sekundärtext, Lede, Labels |
| `ink-3` | – | `oklch(0.62 0 0)` | `oklch(0.50 0 0)` | Tertiärtext (≥ 4,5:1 auf jeder Fläche) |
| `ink-4` | `--fg-dim` | `oklch(0.55 0 0)` | `oklch(0.64 0 0)` | nur Trenner und Linien, nie Text |
| `net` | – | `oklch(0.93 0.028 80)` | `oklch(0.36 0.004 70)` | Hyphen, Wurzel, Zweige |
| `net-core` | – | `oklch(0.84 0.13 75)` | `oklch(0.66 0.15 72)` | erstes Fünftel jeder Hyphe (Kernlicht) |
| `net-tip` | – | `oklch(0.72 0 0)` | `oklch(0.52 0 0)` | Hyphenspitze |
| `net-fine` | – | `oklch(0.72 0 0)` | `oklch(0.55 0 0)` | ferne Myzel-Textur |
| `plate` | – | `oklch(0.11 0.003 70)` | `oklch(0.995 0 0)` | Füllung des Spitzenrings |
| `comet` | – | `oklch(0.85 0.15 75)` | `oklch(0.72 0.16 72)` | Kometenschweif |
| `comet-head` | – | `oklch(0.97 0.06 85)` | `oklch(0.96 0.07 85)` | Kometenkopf |
| `comet-glow` | – | `oklch(0.78 0.16 75 / .65)` | `oklch(0.74 0.16 72 / .7)` | Glühen hinter dem Kometenkopf |
| `amber` | `--primary`, `--sidebar-primary` | `oklch(0.78 0.16 75)` | `oklch(0.78 0.16 75)` | Marke, Kern, die eine Primäraktion |
| `amber-hover` | – | `oklch(0.82 0.17 75)` | `oklch(0.81 0.165 76)` | Primär-Hover |
| `amber-press` | – | `oklch(0.74 0.16 74)` | `oklch(0.74 0.16 74)` | Primär gedrückt |
| `amber-edge` | `--primary-dim` | `oklch(0.65 0.17 75)` | `oklch(0.62 0.16 72)` | Kernrand; hell: 1-px-Rand des Primärknopfs |
| `on-amber` | `--primary-foreground`, `--sidebar-primary-foreground` | `oklch(0.13 0 0)` | `oklch(0.13 0 0)` | Text auf Amber |
| `amber-ink` | – | `oklch(0.85 0.17 75)` | `oklch(0.53 0.13 68)` | Text „Neu / bereit“, Amber-Phrase im Hero |
| `amber-mark` | – | `oklch(0.78 0.16 75)` | `oklch(0.63 0.16 72)` | Knospenring, gestrichelte „neu“-Glyphe, bereite Version in der Historie |
| `amber-tint` | – | `oklch(0.19 0.03 75)` | `oklch(0.955 0.035 82)` | „neu“-Pill |
| `ok` | – | `oklch(0.86 0.10 185)` | `oklch(0.46 0.09 185)` | Text „gesund“ (Teal) |
| `ok-mark` | `--chart-5`, `--teal` | `oklch(0.75 0.15 185)` | `oklch(0.58 0.12 185)` | Glyphe/Spitze „gesund“ |
| `ok-tint` | – | `oklch(0.18 0.03 185)` | `oklch(0.955 0.02 185)` | Pill „gesund“ |
| `info` | – | `oklch(0.84 0.09 250)` | `oklch(0.48 0.14 250)` | Text „neu und schon da“ / Information (Blau) |
| `info-mark` | `--chart-4`, `--blue` | `oklch(0.70 0.15 250)` | `oklch(0.56 0.15 250)` | Info-Glyphe, Hochrechnung |
| `info-tint` | – | `oklch(0.18 0.03 250)` | `oklch(0.955 0.02 250)` | Info-Pill |
| `attn` | – | `oklch(0.84 0.11 300)` | `oklch(0.48 0.17 300)` | Text „prüfen“ (Violett) |
| `attn-mark` | `--violet` | `oklch(0.70 0.17 300)` | `oklch(0.55 0.18 300)` | Glyphe/Hyphe „prüfen“ |
| `attn-tint` | – | `oklch(0.18 0.035 300)` | `oklch(0.957 0.022 300)` | Pill „prüfen“ |
| `err` | – | `oklch(0.80 0.13 22)` | `oklch(0.50 0.19 25)` | Fehlertext |
| `err-mark` | `--red` | `oklch(0.70 0.19 22)` | `oklch(0.58 0.20 25)` | Glyphe/Hyphe „Fehler“ |
| `err-tint` | – | `oklch(0.18 0.04 22)` | `oklch(0.957 0.022 25)` | nur Glyphen-Hintergrund, nie Panel |
| `err-fill` | `--destructive` | `oklch(0.54 0.19 25)` | `oklch(0.52 0.19 25)` | gefüllter Destruktiv-Knopf |
| `on-err` | `--destructive-foreground` | `oklch(0.985 0 0)` | `oklch(0.99 0 0)` | Text auf `err-fill` |
| `off` | – | `oklch(0.72 0 0)` | `oklch(0.48 0 0)` | Text „still“ |
| `off-mark` | – | `oklch(0.58 0 0)` | `oklch(0.60 0 0)` | Glyphe „still“, gekappte Hyphe |
| `off-tint` | – | `oklch(0.17 0 0)` | `oklch(0.94 0 0)` | Pill „still“ |
| `chart-1` | `--chart-1` | `oklch(0.88 0 0)` | `oklch(0.28 0 0)` | Risiko 3 |
| `chart-2` | `--chart-2` | `oklch(0.68 0 0)` | `oklch(0.45 0 0)` | Risiko 2 |
| `chart-3` | `--chart-3` | `oklch(0.50 0 0)` | `oklch(0.62 0 0)` | Risiko 0–1, Balken des Vormonats |
| `grid` | – | `oklch(0.2 0 0)` | `oklch(0.91 0 0)` | Chart-Gitter |
| `thread` | – | `oklch(0.50 0 0)` | `oklch(0.58 0 0)` | der Faden (1 px, ≥ 3:1) |
| `focus` | `--ring`, `--sidebar-ring` | `oklch(0.92 0 0)` | `oklch(0.22 0 0)` | Fokusring |
| `term` | – | `oklch(0.105 0.002 70)` | `oklch(0.965 0 0)` | Codeblock |
| `term-bar` | – | `oklch(0.13 0.003 70)` | `oklch(0.94 0 0)` | Chrome-Leiste des Codeblocks |
| `term-dot` | – | `oklch(0.25 0 0)` | `oklch(0.84 0 0)` | drei Chrome-Punkte |
| `term-ink` | – | `oklch(0.85 0 0)` | `oklch(0.22 0 0)` | Terminal-Text |
| `term-dim` | – | `oklch(0.62 0 0)` | `oklch(0.47 0 0)` | Prompt, Hinweise |
| `lift` | – | `oklch(0.78 0.16 75 / .13)` | `oklch(0.78 0.16 75 / .07)` | warmes Feld hinter dem Kern |
| `core-hot` | – | `oklch(0.97 0.06 85)` | `oklch(0.9 0.12 84)` | weißglühendes Kernzentrum |
| `bud-rim-ok` | – | `oklch(0.9 0.09 185)` | `oklch(0.58 0.12 185)` | Knospenrand Teal |
| `bud-rim-attn` | – | `oklch(0.88 0.1 300)` | `oklch(0.55 0.18 300)` | Knospenrand Violett |
| `bud-rim-err` | – | `oklch(0.86 0.11 22)` | `oklch(0.58 0.20 25)` | Knospenrand Rot |
| `brow` | – | `oklch(0.78 0.16 75 / .6)` | `oklch(0.62 0.16 72 / .6)` | 20×1-px-Strich des Eyebrows |
| `scrim` | – | `oklch(0.05 0 0 / .66)` | `oklch(0.2 0 0 / .28)` | Hintergrund hinter Dialog/Drawer (3 px Blur) |

Zusätzliche Aliase:
- `--primary-soft: oklch(0.78 0.16 75 / 14%)`
- `--sidebar-*` gemäß `SHADCN` in `tokens.mjs`

### 3.3 Themenabhängige Nicht-Farbwerte (exakt aus `THEMED`)

| Wert | Dunkel | Hell |
| --- | --- | --- |
| `color-scheme` | `dark` | `light` |
| `--halo-a` / `--halo-r` | `.5` / `112px` | `.34` / `84px` |
| `--hy-tip-o` | `.92` | `.6` |
| `--far-o` | `.2` | `.14` |
| `--plate-o` | `.5` | `0` |
| `--ambient` | `radial-gradient(ellipse 80% 50% at 50% -10%, oklch(0.78 0.16 75 / 10%), transparent 60%), radial-gradient(ellipse 60% 40% at 100% 30%, oklch(0.7 0.15 250 / 5%), transparent 60%)` | gleich mit `/ 7%` bzw. `/ 4%` |
| `--dots` | `oklch(1 0 0 / 2.5%)` | `oklch(0 0 0 / 5%)` |
| `--hy-glow` | `drop-shadow(0 0 2px oklch(0.86 0.14 78 / .6)) drop-shadow(0 0 8px oklch(0.78 0.16 75 / .25))` | `none` |
| `--hy-glow-attn` | `drop-shadow(0 0 2px oklch(0.78 0.14 300 / .6)) drop-shadow(0 0 8px oklch(0.7 0.17 300 / .25))` | `none` |
| `--hy-glow-err` | `drop-shadow(0 0 2px oklch(0.78 0.15 22 / .6)) drop-shadow(0 0 8px oklch(0.7 0.19 22 / .25))` | `none` |
| `--bloom-o` / `--bud-o` / `--rim-w` / `--tipring-o` | `.2` / `.85` / `1.3` / `0` | `0` / `0` / `0` / `1` |
| `--field-rx` / `--field-ry` | `560` / `420` | `330` / `262` |
| `--core-glow` | `drop-shadow(0 0 18px oklch(0.8 0.16 78 / .75)) drop-shadow(0 0 5px oklch(0.9 0.1 82 / .55))` | `none` |
| `--glow-ok` / `--glow-attn` / `--glow-err` / `--glow-new` | `drop-shadow(0 0 4px oklch(0.75 0.15 185 / .75))` / `drop-shadow(0 0 4px oklch(0.7 0.17 300 / .75))` / `drop-shadow(0 0 4px oklch(0.7 0.19 22 / .8))` / `drop-shadow(0 0 5px oklch(0.78 0.16 75 / .7))` | `none` |
| `--dot-glow` | `0 0 8px` | `0 0 0` |
| `--cmt-filter` | `drop-shadow(0 0 1.5px var(--comet-glow)) drop-shadow(0 0 6px var(--comet-glow))` | `none` |
| `--chead-filter` | `none` | `drop-shadow(0 0 .6px oklch(0.55 0.14 65 / .95)) drop-shadow(0 0 4px var(--comet-glow))` |
| `--btn-primary-shadow` | `0 0 0 1px oklch(0.78 0.16 75 / 20%), 0 8px 32px -12px oklch(0.78 0.16 75 / 40%)` | `0 0 0 1px oklch(0.62 0.16 72), 0 8px 24px -12px oklch(0.7 0.16 72 / 45%)` |
| `--btn-primary-shadow-hover` | `0 0 0 1px oklch(0.78 0.16 75 / 30%), 0 12px 40px -10px oklch(0.78 0.16 75 / 55%)` | `0 0 0 1px oklch(0.62 0.16 72), 0 12px 30px -10px oklch(0.7 0.16 72 / 55%)` |
| `--btn-2-bg` / `--btn-2-bg-h` / `--btn-2-line-h` | `oklch(1 0 0 / 4%)` / `oklch(1 0 0 / 7%)` / `oklch(1 0 0 / 22%)` | `oklch(0.995 0 0)` / `oklch(0.965 0 0)` / `oklch(0 0 0 / 26%)` |
| `--seg-track` / `--seg-on` | `oklch(1 0 0 / 4%)` / `oklch(0.19 0.005 70)` | `oklch(0.945 0 0)` / `oklch(0.995 0 0)` |
| `--mp-a` / `--mp-b` / `--mp-o` | Sinuswellen (Strich `oklch(0.88 0.16 75)`) / `.85` | Strich `oklch(0.6 0.15 72)` / `1` |
| `--shadow-1` | `0 1px 0 oklch(1 0 0 / .03) inset` | `0 1px 2px oklch(0 0 0 / .05)` |
| `--shadow-2` | `0 18px 44px -18px oklch(0 0 0 / .7), 0 0 0 1px oklch(1 0 0 / .05)` | `0 18px 40px -22px oklch(0 0 0 / .25), 0 4px 12px -8px oklch(0 0 0 / .1)` |
| `--shadow-3` | `0 28px 70px -20px oklch(0 0 0 / .8), 0 0 0 1px oklch(1 0 0 / .06)` | `0 24px 64px -20px oklch(0 0 0 / .3), 0 8px 20px -10px oklch(0 0 0 / .14)` |

Netzgewichte (`WEIGHT`, aus `c-net.js`):

| Element | Dunkel | Hell |
| --- | --- | --- |
| Hyphen | 5,8 → 1,05 | 2,5 → 0,7 |
| Wurzel | 5,8 → 1,15 | 2,7 → 0,8 |
| Zweige | ×1 bei Opazität .5–.9 | ×0,8 bei .4–.7 |
| Aufweitung am Kern | 1,6× | 1,45× |

`MyceliumPhrase` (`components/landing/mycelium-phrase.tsx`) hat seine Farben heute fest im Code (`oklch(0.85 0.17 75)`, Filament `oklch(0.88 0.16 75)`). Für Citadel liest die Variante `tone="primary"` stattdessen `var(--amber-ink)` und `--mp-a`/`--mp-b`/`--mp-o`. Im Dunkel-Theme sind die Werte identisch, die Landingpage bleibt also gleich.

### 3.4 Typografie und Radien

| Rolle | Schrift | Größe / Zeile | Laufweite |
| --- | --- | --- | --- |
| Hero-H1 (genau zwei Sätze auf genau zwei Zeilen; die zweite in `ink-2` oder als Amber-Phrase) | Geist 500 | 60/1,02; 52 bei Hero ≤ 1040 oder Höhe ≤ 780; 48 bei ≤ 940; 46 bei ≤ 820; 34 Telefon; 30 bei ≤ 380 px oder ≤ 600 px Höhe; `fitHero` stuft in 4-px-Schritten bis 44 ab | −0,035em |
| Seiten-H1 | Geist 500 | 52/1,02 (36 Telefon) | −0,035em |
| Erfolgs-H1 („Verbunden.“) | Geist 500 | 56/1,02 (40 Telefon) | −0,035em |
| Dialogfrage | Geist 500 | 34/1,04 | −0,035em |
| Abschnittssatz | Geist 500 | 26/1,15, max. 30–38ch (22 Telefon) | −0,03em |
| Schrittfrage (Pairing), „Wenn etwas schiefgeht“ | Geist 500 | 24–26/1,1 | −0,03em |
| Drawer-Titel | Geist 500 | 28/1,1 | −0,035em |
| Faden-Antwort | Geist 500 | 20/1,16 (18 bei ≤ 1100 und Telefon, 17 bei kurzen Telefonen) | −0,022em |
| KPI-Zahlen | Geist 500, tabular | 36/1 (28 Telefon) | −0,035em |
| Versionsnummern | Geist 500, tabular | 26–32/1 | −0,035em |
| Diagnose-Kopf | Geist 600 | 20 | −0,015em |
| Eyebrow (nur Abschnittsköpfe mit Strich, siehe 8.2) | JetBrains Mono 500, Versalien per CSS | 11 (10–10,5 eng) | +0,14em |
| Statuszeile im Hero | JetBrains Mono 500, Versalien | 11 (10,5 Telefon) | +0,14em |
| Netz- und Graft-Labels, Monatsachsen | JetBrains Mono 500, Versalien, `ink-2` | 10,5/16 | +0,14em |
| Kometenzeichen (Hero, dunkel) | JetBrains Mono 500, `comet` | 7,5 | +0,14em |
| Zeiten, Achsen, Zähler, Schrittnummern „01“ | JetBrains Mono 400–500 | 10,5–12 | 0–0,08em |
| Pairing-Code | JetBrains Mono 500 | 40/40 (30 Telefon) | 0,08em |
| IDs, Digests, Terminal, kbd | JetBrains Mono 400/500 | 10,5–12,5 | 0–0,04em |
| Graft-Caption, Worte des Nutzers | Instrument Serif italic | 32/1,1 bzw. 1,12em | −0,01em / 0 |
| Lede | Geist 400, `ink-2` | 16,5/1,6, 40ch Hero, 60ch Seiten; Telefon 13/18 kurze Zeile | −0,005em |
| Fließtext, Knöpfe, Links | Geist 400/500 | 13,5–15 | −0,005em |
| Meta, Pills, Chart-Labels | Geist 400–500 | 11–12,5 | 0 |

- Fließtext bekommt `font-feature-settings: "ss01", "cv11"`, Mono bekommt `"tnum", "zero"`. Zwischen Wert und Einheit steht immer U+00A0 („1 Fehler“, „wirkt nach Bestätigung“ ausgenommen).
- Gewichte: 500 für Display und Betonung; 600 nur für Wortmarke, Diagnose-Kopf und Gruppennamen.
- Schriften werden einmal in `src/app/fonts.ts` über `next/font/google` definiert, mit denselben Variablen wie heute im `(marketing)`-Layout: `--font-geist`, `--font-jetbrains-mono`, `--font-instrument-serif`. Alle drei Root-Layouts (2.4) setzen sie; das `(marketing)`-Layout definiert sie nicht mehr selbst. Instrument Serif wird mit `preload: false` geladen. Outfit entfällt.
- Schriftstapel auf `:root`, wortgleich mit `.landing`: `--font-sans: var(--font-geist), "Söhne", -apple-system, BlinkMacSystemFont, "Inter", sans-serif`, `--font-serif: var(--font-instrument-serif), "Times New Roman", serif`, `--font-mono: var(--font-jetbrains-mono), ui-monospace, "SF Mono", Menlo, monospace`. Das heutige `@theme inline { --font-sans: var(--font-sans) }` in `globals.css` verweist auf sich selbst und wird durch `--font-sans: var(--font-geist), …` ersetzt; `.landing` deklariert die Stapel nicht mehr.

Radien: Citadel definiert auf `:root` drei Werte, `--radius-control: 8px`, `--radius-card: 12px` und `--radius-overlay: 20px`. Tailwinds `@theme inline` bildet sie so ab:

| Tailwind-Klasse | Wert | Verwendung |
| --- | --- | --- |
| `rounded-sm` | 6 px | kbd, Inline-Code |
| `rounded-md`, `rounded-lg` | 8 px | Knöpfe, Eingaben, Segmente, Navigation; stock `Button`/`Input` nutzen `rounded-lg` |
| `rounded-xl` | 12 px | Karten, Codeblöcke, Toast; stock `Card` nutzt `rounded-xl` |
| `rounded-2xl` | 20 px | Dialoge und Palette; der Dialog-Wrapper setzt diese Klasse ausdrücklich, weil stock `Dialog` `rounded-xl` setzt |
| `rounded-4xl`, `rounded-full` | 999 px | Pills, Tags, Switch |

Die bisherigen `calc(var(--radius) * …)`-Ableitungen entfallen.

### 3.5 Raum und Raster

- Abstände folgen einer 4-px-Basis: 4 · 6 · 8 · 12 · 16 · 18 · 20 · 22 · 24 · 28 · 32 · 40 · 48 · 56.
- **Ein Maß, ein Raster:** Inhalt max. 1120 px; Außenabstand 32 px (24 bei ≤ 1180, 16 bei ≤ 940). `.g12` = 12 Spalten mit 40 px Rinne (32 bei ≤ 1040), eine Spalte bei ≤ 940. Ausnahme: KPI-Bänder bleiben bis 320 px zweispaltig.
- Aufteilungen:

| Bereich | Spalten |
| --- | --- |
| Ledger der Übersicht | 5/7, 5/7, 12 |
| KPI-Bänder | 4/3/2/3 |
| Kosten-Charts | 7/5 |
| Historie | 8/4 |
| Pairing | 6/6 |

- **Abschnitte:**
  - Linie oben in `line-2`; ein Fehlerabschnitt nimmt `err-mark`, ein „Bekannt“-Abschnitt bleibt neutral.
  - Von der Linie 18 px bis zum Eyebrow, 12–14 px bis zum Satz, 20–26 px bis zum Inhalt, ≥ 20 px bis zum Link.
  - 48 px zwischen Abschnitten (36 Telefon), 56 px zwischen Ledger-Reihen.
- **Bedienelemente:**
  - Hero-CTA 44 px; Primär/Sekundär 40 px (44 auf Telefon und im Pairing); klein 32/36.
  - Ghost-Chips und Suche 32 px; Icon-Knöpfe 32 px (44 auf Telefon).
  - Tabellenzeilen 52 px.
- **Seitenkopf (Unterseiten):** Kicker-Pill (24 px) und Mono-Frage mit Strich → 18 px → H1 → 14 px → Lede, Mindesthöhe 212 px. Die Platte liegt dahinter, von 40 px über bis 36 px unter dem Kopf, 80 % der Inhaltsbreite (max. 920 px), bis an den Viewport-Rand; ausgeblendet bei ≤ 640 px.
- **Hero:** Kopie-Spalte ≤ 560 px (`fitHero` öffnet bis 620 px), Lede 40ch und ≥ 24 px unter dem Filament der Amber-Phrase, 40 px unter der Aktionsreihe. Netzbreite `--bw = min(clamp(500px, 100cqi − 392px, 720px), (100svh − 274px) · 720/520)`. Mit Platz (≥ 1380 × 860) sitzt die Mitte der Statuszeile auf Höhe des Labels „TOOLS“, sonst ist die Kopie zum Netz zentriert. Schutzzonen: ≥ 64 px zwischen der längsten H1-Zeile und jedem Label oder jeder Spitze auf ihrer Höhe; ≥ 40 px zwischen Aktionsreihe und Label.

### 3.6 Bildsprache des Netzes

Ein Kern, fünf Hyphen: eine pro Frage und eine pro Spitze des Logos. Die Wurzel wächst aus dem Faden und bindet in einen Knoten zwischen der vierten und fünften Faden-Pill. Das Netz ist für assistive Technik `aria-hidden`; der Faden sagt dasselbe in Worten. Geometrie und Choreografie stammen exakt aus `c-net.js` (v2), v3 hat nur Farbe, Licht und Gewicht verändert.

| Teil | Festlegung |
| --- | --- |
| Rahmen | `viewBox 0 0 720 520`, Kern bei 430/284, Kernradius r 15 |
| Hyphen | `sCurve(core, tip, s1, s2)`: Kontrollpunkte bei 32 % und 70 % der Sehne, Versatz 18–20 % und 13–14 % zu gegenüberliegenden Seiten. Spitzen: Verbindung 140/420, Tools 236/131, Version 470/96, Kosten 640/150, Probleme 636/336. Gefüllte Verjüngung mit Ease 0,62 und Aufweitung am Kernrand, die über 8 px zurückgeht. Füllung: `linearGradient` von `net-core` über `net` (bei 28 %) zu `net-tip`, Opazität 1 → `--hy-tip-o`. Violette und rote Hyphen behalten 16 % Amber-Anfang. Dunkel: Bloom pro Farbgruppe (`--hy-glow*`, nach den Reveal-Masken) plus `.bloom`-Unterlage (3,2× → 1,6× Strichbreite, 5 px Blur, 20 %). |
| Reveal | ein Masken-Pfad pro Hyphe, `pathLength=1`, `stroke-dasharray: 1 2`, `stroke-dashoffset: 1.002 → 0` |
| Zweige | 1–3 pro Hyphe (10 insgesamt), C-Kurven; ≥ 64 px Abstand zur H1 und 16 Einheiten über dem Faden |
| Ferne Textur | 0,6 px `net-fine` bei `--far-o` (dunkel alle Filamente, Maske r 330; hell jedes zweite, r 260) |
| Ring | nur dunkel: ein Ring r 208 um den Kern, 0,75 px `line-2` bei `--plate-o` (50 %) |
| Feld | Ellipse `--field-rx` × `--field-ry` (× `--u`) um den Kern in `lift`; volle Stärke bis 28 % des Radius, 48 % bei 58 %, 16 % bei 84 %, außen transparent. Reicht über den Inhaltsrand und wird von `main` mit `overflow-x: clip` am Viewport beschnitten (kein Scroll-Container, Sticky-Köpfe funktionieren weiter) |
| Wurzel und Knoten | `rootCurve(ex)` mit Verjüngung 5,8 → 1,15 (dunkel) und Verlauf `net-core` → `net` → `net-tip` bei 70 %. `alignRoot` (ResizeObserver) setzt `ex` unter den Knoten: Scheibe 8 px in `net`, 3-px-Ring in `bg`, dunkel 10 px Amber-Glühen, mittig zwischen vierter und fünfter Faden-Pill |
| Kern | radialer Verlauf auf r 28,5: `core-hot` bis 20 %, `amber` bei 46 %, `amber-edge` bei 64 % (78 %) und 82 % (26 %), transparent am Rand. Keine Kontur. Dazu `--core-glow`, Halo `--halo-r`/`--halo-a` und das warme Feld (`lift`, Ellipse `--field-rx` × `--field-ry`). Der Ring r 26 erscheint nur während des Umschaltens. |
| Spitzen | Knospen (dunkel): Halo r 9 mit 5 px Blur bei `--bud-o`, darauf die Form mit 1,3-px-Rand `bud-rim-*`. ok = Teal-Scheibe r 5,2; attn = violette Raute 6,4; err = rotes Dreieck mit Ping; neu = gestrichelter Amber-Ring, der um den Teal-Kern dreht; ref = neutraler Pfeil zurück auf Ring r 10 in `plate`, ohne Glühen; cut/off = Stummel bis 70 %, 12-px-Kappe, Lücke, blasser Rest, hohles Quadrat 9 px. Hell: jede Spitze flach auf weißem Ring r 10. |
| Kometen | nur auf gesunden Hyphen. Dunkel: Schweif 56/34/15 px bei .3/.5/.85, Kopf 4,6 px. Hell: 92-px-Verlauf, Kopf 5 px mit Amber-Rand. Auf der Verbindungshyphe läuft der Komet nach innen. Im Hero (nur dunkel) führt jeder Komet eine Kette aus sechs Zeichen in JetBrains Mono mit (`textPath`, `startOffset` per SMIL) – außer auf der Verbindungshyphe (Punkt 8.2.4). |
| Labels | HTML-Geschwister des SVG, `aria-hidden`, nur das Thema (Verbindung · Tools · Version · Kosten · Probleme). Sie liegen radial außerhalb der Spitze, `--off = u · r + 10px`. `.below`, wenn das Label ≤ 40 px an der Aktionsreihe des Heros läge. |
| Band (≤ 820 px) | eigene Geometrie 350 × 144, Kern r 8, keine Labels und keine Kometen. Höhe `clamp(120px, 100svh − 780px, 210px)` auf Tablet, `clamp(54px, 100svh − 600px, 146px)` auf Telefon. |
| Platte (Unterseiten) | `hyphaPlate(topic, state)`: Netz gedreht, Kern bei 772/212 in 900 × 300, `xMaxYMid slice`. Die Hyphe des Themas zeigt zur H1, die übrigen vier als Geister bei 14 % (hell 12 %). Ausgeblendet bei ≤ 640 px. |
| Graft (Verbinden, leere Übersicht) | derselbe Renderer, 420 × 300, Caption in Instrument Serif |
| Hervorhebung | `data-focus=<thema>`: andere Hyphen 20 %, andere Kometen aus, andere Labels 35 %, das aktive Label in `ink` |

### 3.7 Bewegung

| Was | Dauer | Kurve |
| --- | --- | --- |
| Hover/Press | 120 ms | `cubic-bezier(.2,0,0,1)`, Press `scale(.98)` |
| Primär-Hover (heller, −1 px, mehr Glühen) | 200 ms | `cubic-bezier(.16,1,.3,1)` |
| Filament der Amber-Phrase | 7 s, ±18/14 px | ease-in-out, endlos |
| Drawer, Dialog, Seitenleiste, Scrim, Hervorhebung, Toast, Palette | 200–320 ms | expo-out |
| Tasten-Tooltip | 200 ms, 450 ms Hover-Verzögerung | standard |
| Pfeil-Link `.go`: Pfeil 3 px nach rechts, Unterstrich zeichnet sich | 200 / 320 ms | expo-out |
| Einzeichnen 1: Hero-Text steigt 8 px | 400 ms, 55 ms Staffel | expo-out ab 0 ms |
| Einzeichnen 2: Wurzel aus dem Knoten | 520 ms | ab 430 ms |
| Einzeichnen 3: Kern, Skala .4 → 1 | 520 ms | ab 780 ms |
| Einzeichnen 4: Hyphen | 900 ms, 90 ms Staffel | ab 900 ms |
| Einzeichnen 5: Spitze, Label, Faden-Pill (Knospe +140 ms) | 280–360 ms | ab ≈ 1640 + 90·i ms |
| Einzeichnen 6: Zweige, Textur | 600/1600 ms | standard |
| Kernatmung | 5,6 s, 1 → 1,04 | `cubic-bezier(.65,0,.35,1)` |
| Kometen | 4,6-s-Zyklus, Lauf 3,5–3,8 s, gleichmäßig versetzt, Einblenden 700 ms bei 2,5 s | `cubic-bezier(.3,.22,.58,.92)` |
| Live-Punkt, Knospenring, Fehler-Ping | 2,8 s / 16 s linear / 2,8 s ab 500 ms nach der Spitze | in-out / linear / expo-out |
| Zwischenzustand: 2-px-Amber-Linie, Kernring pulsiert | unbestimmte Fortschrittsanzeige; Ring 1,4 s | linear / in-out |
| Moment „angewendet“: Hyphe wächst nach, Spitze, Amber-Ping; Moment „zurück“: Teal-Ping auf Probleme | 900/700/1100 ms; 1100 ms | expo-out |

Regeln:
- Es bewegt sich nur, was lebt.
- Eingezeichnet wird nur beim ersten Aufruf von `/manage` pro Browser-Sitzung (`sessionStorage` in try/catch). Danach steht das fertige Netz, und die Kometen laufen.
- Die Animation pausiert, wenn der Tab verborgen ist (`visibilitychange`) oder das Netz nicht im Bild ist (`IntersectionObserver`): `svg.pauseAnimations()` plus `animation-play-state: paused`.
- Die Abweichung vom Prototyp (eine Fortschrittslinie ohne 5-s-Dauer) folgt aus 1.3.

**Reduced Motion** (`prefers-reduced-motion: reduce`):
- Netz, Band, Platten und Graft erscheinen fertig gezeichnet und still.
- Kein Einzeichnen, keine Kometen und Kometenzeichen, keine Atmung, keine Pings, kein Filament-Drift, kein pulsierender Statuspunkt.
- Die Fortschrittslinie wird zum statischen Text „Wartet auf den Runner · 12 s“.
- H1 und Hero-Spalte haben in beiden Modi keine `transition`, damit `fitHero` echte Größen misst.

### 3.8 Zustandscodierung (Farbe + Form + Wort)

| Zustand | Farbe | Form (Glyphe/Netz) | Wort | Wann (Quelle) |
| --- | --- | --- | --- | --- |
| Gesund | Teal `ok`/`ok-mark` | gefüllter Kreis / Scheibenspitze, Komet | Gesund, Aktuell, Ruhig, Im Rahmen, Alles klar, Behoben | Standard bei vollständigen Daten ohne Befund |
| Bereit („neu / bereit“) | Amber `amber-mark` + `amber-ink` | gestrichelter Ring / Knospe; Amber-Phrase im Hero | Neu, Bereit, Wartet auf dich | eine Platform-seitige Änderung wartet aufs Anwenden (`action = apply`, D3) oder eine gespeicherte Entscheidung wirkt noch nicht (`decisionPending`) |
| Neu und schon da / Info | Blau `info`/`info-mark` | Ring mit Punkt | Neu im Code, Hinweis | `status = new` bzw. `changed` (Code-Tools sind sofort aktiv, Spec 4.5), Policy-Hinweise (`risk-lower-available`, `override-lapsed-risk-raised`) |
| Hochrechnung | Blau `info-mark` | gepunktete Linie | Hochrechnung | Kostenseite |
| Prüfen | Violett `attn` | Raute / violette Hyphe | Prüfen, „5 prüfen“ | Tools: `status = needs-attention` oder `risk-raised`, Beschreibung fehlt (`description = null`). Verbindung: `healthStatus = degraded` des aktiven Deployments |
| Fehler | Rot `err` | Dreieck / rote Hyphe, Ping, rote Abschnittslinie | Fehler, „1 Fehler“ | Abschnitt 4.1.3 |
| Bekannt (Ursache woanders) | neutral `ink-2` | Pfeil zurück / neutrale Hyphe | Bekannt | Folge einer roten Ursache |
| Getrennt (Produktionsumgebung) | Rot `err` | Kappe ⊣ / Stummel | Getrennt | `connection ≠ connected`, `lastSeenAt` gesetzt, Produktionsumgebung = die Umgebung mit der höchsten `promotionOrder` der App (bei Free die einzige). `kind` taugt dafür nicht: neue Umgebungen legt die API immer als `custom` an (`apps.controller.ts`), `production` gibt es nur bei Altbeständen |
| Still (andere Umgebung) | Grau `off` | Kappe ⊣ | Still | wie oben, alle anderen Umgebungen |
| Eingeschränkt / Gelockert / Fragt vorher / Geändert | `ink-2` | Schloss / offenes Schloss / Sprechblase / Mono `~` `↑` | Eingeschränkt, Gelockert, Fragt vorher, Geändert, Risiko gestiegen | `origin.* = platform` mit strengerem Wert; Gelockert: `requiresApproval = false` mit `origin.requiresApproval = platform` (4.2.4); `requiresApproval`; `status` |
| Risiko | `ink` auf `line-2` | 1–3 steigende Pips | siehe Tabelle unten | effektive `riskClass` |
| Nicht verfügbare Aktion | `ink-3` auf `surface-3`, ohne Rand | flacher Knopf | Grund daneben | z. B. fehlende Rolle |

Risiko-Abbildung (die API kennt vier Stufen, der Prototyp drei Pips; das Wort trennt Stufe 0 und 1):

| `riskClass` | Stufe (`riskTier`) | Pips | Wort | Diagrammfarbe |
| --- | --- | --- | --- | --- |
| `safe-read` | 0 | 1 | Liest nur | `chart-3` |
| `read-sensitive` | 1 | 1 | Liest Sensibles | `chart-3` |
| `write` | 2 | 2 | Ändert Daten | `chart-2` |
| `delete` | 3 | 3 | Löscht | `chart-1` |
| `external` | 3 | 3 | Versendet / extern | `chart-1` |
| `financial` | 3 | 3 | Bezahlt | `chart-1` |
| `unknown` oder unbekannter Wert | 3 (die API behandelt ihn wie Stufe 3) | 3 | Nicht eingeordnet | `chart-1` |

Amber hat genau drei Aufgaben: die Marke (Logo, Kern, Kometen, Eyebrow-Strich), die eine Primäraktion pro Bildschirm und „neu / bereit“.

---

## 4. Bildschirme

Für alle Bildschirme gilt:
- Clients validieren Antworten mit zod, nach dem Muster von `connected-overview-client.ts`.
- Ein API-Fehler auf der Platform ist etwas anderes als ein Problem in der App: Er erscheint als eigenes Band „Glirastes erreicht die Platform gerade nicht“ mit „Erneut laden“. Das Netz wird dann neutral ohne Zustandsfarben und ohne Kometen gezeichnet.
- Texte kommen aus dem Katalog der gewählten Sprache (2.4). Die Tabellen dieser Spec nennen den deutschen Text; `{hh:mm}`, `{Datum}`, `{Monat}` und Beträge darin sind Platzhalter, die `format.ts` in der gewählten Sprache füllt.
- Zeitangaben (über `Intl` mit `de-DE` bzw. `en-US`):
  - relativ bis 60 s (`Intl.RelativeTimeFormat`, Sekunden `narrow`): „vor 11 s“ / „11s ago“; bis 60 Min. (Minuten `short`): „vor 5 Min.“ / „5 min. ago“; danach „um 14:21“ / „at 2:21 PM“
  - Datum „3. Okt.“ / „Oct 3“; Zeitzone ist die des Browsers
- Zahlen und Beträge über `Intl.NumberFormat` mit `de-DE` bzw. `en-US`, Beträge in USD: „15,18 $“ / „$15.18“, Prozent „9,7 %“ / „9.7%“, Tausender „4.812“ / „4,812“.
- Eine Rate steht immer mit ihrer Anzahl da: „3 von 31 Aufrufen = 9,7 %“ / „3 of 31 calls = 9.7%“.
- **Kostenkalender in UTC.** P09 fasst Stunden zu UTC-Tagen zusammen (`foldIntoDays`). Alle Tages- und Monatsgrenzen der Kosten- und Fehlerreihen sind daher UTC-Grenzen; „Dieser Monat“ beginnt am 1. um 00:00 UTC. Die Kostenseite sagt das in ihrer Fußzeile („Tage und Monate in UTC“). Alle anderen Zeitangaben (Lebenszeichen, Aktivierung, Historie) stehen in der Zeitzone des Browsers.
- **Gekürzter Zeitraum.** P09 kürzt `from` stillschweigend auf `retention.availableFrom`. Liegt `range.from` der Antwort nach dem angefragten Beginn, sagt die Ansicht „seit {Datum}“ statt des vollen Zeitraums, bei Free mit dem Zusatz „Free hält 30 Tage“.

**Rollen und Rechte.** Die API prüft serverseitig; das UI zeigt eine Aktion, die die Rolle nicht erlaubt, von vornherein als flachen Knopf mit Grund. Die eigenen Rollen liest Citadel einmal pro Sitzung: E-Mail aus der Better-Auth-Sitzung, Abgleich mit `GET /v1/tenant/team` → `members[].role`, `members[].roles`. Fehlt der Abgleich (Fehler, kein Treffer), sind alle Aktionen aktiv und die 403-Antwort der API entscheidet.

| Aktion | Endpunkt | Erlaubt (API-Code) | Im Dashboard vergebbar heißt das | Text am flachen Knopf |
| --- | --- | --- | --- | --- |
| Tool strenger machen, Einschränkung aufheben (speichern) | `PATCH …/runs/:runId/tools/:toolId` | `owner`, `admin`, `editor`, `publisher` (`EDITING_ROLES`) | Owner, Admin | „Ändern dürfen Owner und Admins.“ |
| Rückfrage lockern (speichern, dann anwenden) | `PATCH …/runs/:runId/tools/:toolId` mit `requiresApproval: false`, danach `POST …/configurations/:id/apply` | Speichern: `EDITING_ROLES`. Wirksam erst durch ein Anwenden, das die Sicherheitsfreigabe selbst gibt; dafür gilt dieselbe Bedingung wie für jedes Anwenden (nächste Zeile) | Owner, Admin | „Lockern dürfen Owner und Admins.“ |
| Anwenden, Fortsetzen | `POST …/configurations/:id/apply`, `POST …/runs/:runId/apply` | eine Publisher-Rolle (`owner`, `admin`, `publisher`) **und** (`owner`/`admin` als Hauptrolle oder `security-approver`) (`assertActorCanRun`) | Owner, Admin | „Anwenden dürfen Owner und Admins.“ |
| Zurück; Rückgängig nach Anwenden oder Zurück | `POST …/deployments/:id/rollback` | Hauptrolle `owner`, `admin` oder `publisher` | Owner, Admin | „Zurückgehen dürfen Owner und Admins.“ |
| Gerät verbinden, ablehnen | `POST /v1/runtime-connect/pairings/authorize`, `…/deny` | Hauptrolle `owner` oder `admin` | Owner, Admin | „Geräte verbinden dürfen Owner und Admins.“ |

`member`, `viewer` und ein reiner `security-approver` sehen alles, ändern aber nichts; für sie ist das ganze Formular „Regeln ändern“ flach mit dem einen Grund „Ändern dürfen Owner und Admins.“. Der Anwenden-Schritt nach dem Speichern (4.2.4) entfällt für Rollen, die speichern, aber nicht anwenden dürfen (`editor`, `publisher` ohne `security-approver`); sie sehen „Gespeichert. Anwenden dürfen Owner und Admins.“ Lockern bietet das Formular diesen Rollen nicht an: Der Schalter „Vorher nachfragen“ steht für sie flach mit „Lockern dürfen Owner und Admins.“, weil eine Lockerung erst mit einer Sicherheitsfreigabe wirkt, die nur das Anwenden mitbringt.

**Wer eine Lockerung anwenden kann** (API-Code @ `9014587`, P08b Task 8):
- Gespeichert wird `requiresApproval: false` von `saveToolOverride` (`EDITING_ROLES`). Die API pinnt die Lockerung an die Risikoklasse, die der Code gemeldet hat (`withBaseline`: `baselineRiskClass`), und lehnt sie bei Stufe 3 oder `unknown` mit 422 `tier-3-always-requires-approval` ab (`boundToolOverride`).
- Die Konfigurationsrevision mit der Lockerung ist sicherheitskritisch (`isSecurityCriticalChange` über `deltasLoosen`, `runtime-publication-policy.ts`). Beide Anwenden-Wege (`applyConfiguration` und `runs/:runId/apply` über `runConnected`) prüfen zuerst `assertActorCanRun` und veröffentlichen dann mit `publishBatchResumable(…, { selfApproveCritical: true })`. Die API trägt dabei eine Sicherheitsfreigabe mit dem Anwendenden als `approverId` ein; `assertPublicationAllowed` akzeptiert sie für die Hauptrolle `owner`/`admin` oder die Rolle `security-approver` (`selfApproved: true`).
- Selbst freigegeben wird nur die Revision, die die aktuellen Entscheidungen signiert (`assertSignsCurrentDecisions`); jede andere Revision im Entwurf antwortet mit 409 (4.1.6).
- Protokolliert wird das als `runtime.app_setup.tool_override` beim Speichern (`direction = loosening`) sowie beim Anwenden als `runtime.revision.decision` (`approvalKind = security`, `decision = approved`, `selfApproved = true`) und `runtime.revision.published` (`critical = true`, `selfApproved = true`).
- Wer anwenden darf, darf also auch lockernd anwenden; eine zusätzliche Schranke gibt es nicht. Im Dashboard vergebbar sind das Owner und Admins. Die 403 „security approval role required“ aus `publishBatch` ist über diese Wege nicht erreichbar, weil `assertActorCanRun` dieselbe Bedingung vorher prüft.
- Einen eigenen Freigabe-Ablauf (zweite Person) gibt es im UI nicht (8.1). Hat jemand ohne Anwenden-Recht eine Lockerung über die API gespeichert, wartet sie wie jede Entscheidung auf das Anwenden; der Anwenden-Dialog nennt sie (4.1.6), und ohne Anwenden-Recht bleibt der Knopf flach mit „Anwenden dürfen Owner und Admins.“
- Das Anwenden signiert immer **alle** gespeicherten Entscheidungen der App (die Revision aus `ToolPolicyRevisionService.target`), nicht nur die gerade bearbeitete. Damit eine fremde oder seit einem Rollback ruhende Lockerung nicht unbemerkt mit selbst gegebener Sicherheitsfreigabe wirksam wird, wendet der Drawer nur dann direkt an, wenn außer dem bearbeiteten Tool kein Tool `decisionPending` zeigt; sonst öffnet er nach dem Speichern den Anwenden-Dialog, der alle Änderungen nennt (4.2.4, Schritt 3).

**Momente.** „Angewendet“ und „Zurück“ (4.1.8) sind Zustände des Tabs, der die Aktion ausgelöst hat. Sie stehen, bis die Seite verlassen oder neu geladen wird oder die Daten einen schwereren Zustand melden; danach gilt wieder der Zustand aus den Daten.

### 4.1 Übersicht (`/manage`)

#### 4.1.1 Aufbau

Von oben nach unten:
1. **Hero** (Kopie links, Netz rechts; ≤ 820 px: Band oben, Kopie darunter)
   - Mono-Statuszeile auf Höhe des Labels „TOOLS“
   - H1, genau zwei Zeilen
   - Lede
   - eine Primäraktion (Amber, 44 px) und ein Sekundärknopf (`.l-btn-secondary`), 12 px Abstand. Auf dem Telefon nur die Primäraktion und statt der Lede eine Kurzzeile.
   - Texte, Aktionen und Kurzzeilen pro Zustand: 4.1.8.
2. **Faden:** fünf gleiche Spalten auf einem durchgehenden 1-px-Faden; bei ≤ 820 px vertikal. Pro Spalte: Pill (Glyphe + Wort), Frage, Antwort (Geist 500, 20 px), eine Meta-Zeile. Die fünfte Meta-Zeile nennt immer den Rückweg. Jede Spalte ist ein Link zu ihrem Ledger-Abschnitt; der zugängliche Name lautet „Frage – Antwort – Zustand. Meta“.
3. **Diagnosekarte** (nur in den Zuständen stale/error): „Was wir geprüft haben“ (4.1.5).
4. **Ledger** auf `.g12`: Verbindung 5 | Chat 7, Version 5 | Kosten 7, Probleme 12. Jeder Abschnitt hat Eyebrow, Satz, Fakten und höchstens einen nächsten Schritt (Pfeil-Link `.go`). Inhalt pro Abschnitt und Zustand: 4.1.9.

`fitHero` (als `useLayoutEffect` mit `ResizeObserver`) hält jeden H1-Satz auf einer Zeile:
- Zuerst öffnet es die Kopie-Spalte in 20-px-Schritten bis 620 px, solange die 64-px-Schutzzone zu Labels hält.
- Danach stuft es die H1 in 4-px-Schritten bis 44 ab.
- Die Aktionsreihe bleibt ≥ 40 px von jedem Label entfernt; sonst rutscht das Label unter seine Spitze (`.below`).
- Die H1 bekommt einen festen Platz für zwei Zeilen, damit nichts springt (CLS).

#### 4.1.2 Antworten (View-Model `lib/view-models/overview.ts`)

Eingaben sind `env` (Umgebungsliste), `ov` (connected-overview), `cap` (capabilities), `met` (Metriken), `dep` (Deployments) und optional `runner` (D1). Ausgabe sind fünf Antworten `{ topic, state, word, short, meta, way? }` plus ein Hero-Modell und ein Netz-Modell; die Textfelder sind `CopyRef`s (2.4), keine fertigen Sätze. Für jedes Feld gilt die angegebene Quelle; das View-Model rät nichts dazu.

| Frage | Zustand und Antwort (Auswahl in dieser Reihenfolge, die erste zutreffende gilt) | Meta-Zeile |
| --- | --- | --- |
| Verbindung | `connection ≠ connected` und `lastSeenAt` gesetzt → cut (Produktion) bzw. off: „Nein, seit hh:mm“ · `connected` und `healthStatus` des aktiven Deployments `degraded` → attn „Ja, eingeschränkt“ · sonst `connected` → ok „Ja, verbunden“ · Umgebung nie gesehen (`lastSeenAt = null`) → leerer Zustand (4.1.4) | „Letztes Lebenszeichen vor 11 s“ (`lastSeenAt`); ab D1 zusätzlich „glirastes <version>“ |
| Chat | Verbindung cut/off → off „Unbekannt“, Wort „Still“ (keine Aussage über den Chat, 1.3) · Fehlerursache im Chat oder in der Version (4.1.3) → err „Alles, bis auf ein Tool“ (genau ein Tool über der Schwelle) bzw. „Mit Fehlern“ (sonst), Wort „1 Fehler“ + leises „+n prüfen“ · `codeVersion.status ≠ reported` → off „Noch kein Code-Bericht“ · Prüf-Menge nicht leer → attn mit der Fähigkeit (siehe unten), Wort „n prüfen“ · sonst ok mit der Fähigkeit, Wort „Alles klar“ | „{n} Tools · {k} mit Folgen“ ({k} = aktivierte Tools mit Stufe ≥ 2) bzw. „{n} Tools · ◆ +5 prüfen“; ohne Code-Bericht „Kommt mit dem nächsten Start der App“; still „Seit {hh:mm} keine Meldung“ |
| Version | Zwischenzustand (4.1.4) oder `action = resume` → Amber „Wird angewendet“ · Version ist Ursache eines Fehlers → err „v{N} aktiv, mit Fehler“ · `action = apply` bzw. `pendingChange` (D3) → neu (Amber) „v{N+1} ist bereit“ (vor D2: „Neue Regeln sind bereit“) · `candidate.status = failed` → attn „Update fehlgeschlagen“ (die aktive Version läuft weiter, das ist kein Fehlerzustand des Chats) · aktives Deployment ist ein Rollback (`rolledBackFromId ≠ null`) und Tools haben `decisionPending` → info „{k} Regeln ruhen seit dem Zurückgehen“ (nach einem Rollback bietet die API kein erneutes Anwenden an, `pendingChange = null`; „Erneut anwenden“ kommt mit D8) · sonst Tools mit `decisionPending`, aber `action ≠ apply` (aktiviert, vom Runner noch nicht übernommen; bei Runnern vor P04 dauerhaft, Ledger X5) → Amber „Wartet auf den Runner“ als Zustand, nie als Fehler · Tools mit `status ∈ {new, changed}` → info „Neu im Code: {k} Tools“ · sonst ok „v{N} ist aktuell“ | „seit {activatedAt}“ · „{k} Tool-Regeln warten“ · „Code-Bericht {reportedAt}“ |
| Kosten | Metriken fehlen (4.1.4) → off „Noch keine Messwerte“ · Monatssumme `turns = 0` → ok „Noch keine Anfragen“ · alle Monatstage mit `unknownCostTurns = 0` → ok „{knownUsd} im {Monat}“ · ein Teil unbekannt → ok „mind. {knownUsd}“ · alles unbekannt (`unknownCostTurns = turns`) → ok „Kosten unbekannt“ (nie „0,00 $“) | „≈ {Hochrechnung} bis Monatsende“ (nur mit 7 vollständigen Tagen im Fenster, sonst „{turns} Anfragen seit dem 1.“); mit unbekanntem Anteil zusätzlich „{u} Anfragen ohne Kostenangabe“ |
| Probleme | Ursache bei der Verbindung → ref „Eins: App meldet sich nicht“, Wort „Bekannt“ · Ursache bei der Version → ref „Eins, durch v{N}“, Wort „Bekannt“ · Ursache unbekannt → err „Eins: {Tool} schlägt fehl“ (ein Tool über der Schwelle) bzw. „Eins: Anfragen schlagen fehl“ (Turn-Quote über der Schwelle) bzw. „Eins: Runtime meldet einen Fehler“ (nur `healthStatus = unhealthy`) · Metriken fehlen → ok „Keins bekannt“ · sonst ok „Ruhig seit {d} Tagen“ | „Rückweg: v{M}, bis {Datum} aktiv“ · „Hilft: App in {Umgebung} neu starten“ (Ursache Verbindung) · „Kein älterer gesunder Stand“ |

- **Fähigkeit** („Was kann mein Chat?“) wird aus den aktivierten Tools mit effektiver `riskClass` abgeleitet, als Spanne vom mildesten bis zum stärksten Recht:
  - Klasse `external` vorhanden → „Lesen bis Senden“
  - sonst `financial` → „Lesen bis Bezahlen“
  - sonst `delete` → „Lesen bis Löschen“
  - sonst `write` → „Lesen und ändern“
  - sonst Tools vorhanden → „Nur lesen“
  - sonst „Noch nichts“
  - `unknown` geht nicht in die Spanne ein; solche Tools stehen in der Prüf-Menge.
- **Prüf-Menge** = Tools mit `status ∈ {needs-attention, risk-raised}`, `description = null` oder `riskClass = unknown`. Fehler-Tools zählen nicht hinein, sie haben ihre eigene Zählung. Entfernte Tools (`status = removed`) zählen nie. Die Hinweis-Codes `risk-lower-available`, `override-lapsed-risk-raised` und `policy-entry-orphaned` sind Info und gehören nicht zur Prüf-Menge.
- **„Ruhig seit {d} Tagen“**: {d} = volle Tage seit dem Ende des letzten UTC-Tags mit `errorTurns > 0` oder `toolErrors > 0` im Übersichtsfenster. Gibt es im Fenster keinen solchen Tag: „Ruhig seit über {w} Tagen“ ({w} = Tage von `range.from` bis heute). Ist der letzte Fehlertag heute (unter der Schwelle): „Ruhig, {e} Fehler heute“. Die Lede sagt im ok-Zustand wörtlich dasselbe {d} (8.2.3).
- **Rückweg** = der jüngste Eintrag (nach `activatedAt`) aus `dep` mit `healthStatus = healthy` und `status ∈ {superseded, rolled_back}`, der
  - von keinem späteren Eintrag als `rolledBackFromId` genannt wird (von diesem Stand wurde schon einmal zurückgegangen; nach einem Rollback ist das gerade die fehlerhafte Version), und
  - sich in `configRevisionId` oder `agentRevisionId` vom aktiven Deployment unterscheidet (sonst änderte das Zurückgehen nichts; ein Rollback legt eine Kopie des Ziels an).

  Die Grundmenge ist genau die, die `rollback` im Store akzeptiert; die beiden Zusatzbedingungen sind UI-Regeln. „bis {Datum} aktiv“ ist `activatedAt` des nächstjüngeren Eintrags. Gibt es keinen Kandidaten: „Kein älterer gesunder Stand“.

#### 4.1.3 Netzzustände und Ursachenregel

Jede Hyphe hat einen eigenen Zustand (`ok | new | info | attn | err | cut | off | ref`). Die vier Szenarien des Prototyps sind Kombinationen daraus, ergänzt um den Zwischenzustand und die Momente. Es gilt das erste zutreffende Szenario von unten nach oben (der schwerste Zustand gewinnt): Zwischenzustand, stale, error, pending, wartet, ok.

| Szenario | Bedingung | Hyphen | Hero |
| --- | --- | --- | --- |
| ok | keine der folgenden | alle ok (Tools attn, wenn die Prüf-Menge nicht leer ist; Version info bei „Neu im Code“), Kometen auf allen gesunden | 4.1.8 |
| wartet | Tools mit `decisionPending`, aber `action ≠ apply`, und das aktive Deployment ist kein Rollback (die neue Version ist aktiv, der Runner hat sie noch nicht übernommen) | Version = neu ohne Ping, sonst wie ok | 4.1.8 |
| pending | `action = apply` | Version = neu (Knospe), Tools = attn, wenn die Prüf-Menge nicht leer ist | 4.1.8 |
| error | Fehlerbedingung (unten) | Ursache + Wirkung rot, Probleme = ref (oder rot bei unbekannter Ursache) | 4.1.8 |
| stale | `connection ∈ {stale, disconnected}` bei gesetztem `lastSeenAt` | Verbindung = cut (Produktion) bzw. off (Ursache), Chat = off „Unbekannt“ (keine Wirkung behauptet, 1.3), Probleme = ref, sonst ok ohne Kometen | 4.1.8 |
| Zwischenzustand | ein Anwenden oder Zurück aus diesem Tab läuft, oder `action = resume` | Kernring pulsiert, keine Kometen, Zustände wie zuvor | 4.1.4, 4.1.8 |

**Fehlerbedingung.** Ein Fehler liegt vor, wenn mindestens eines gilt:
- `healthStatus = unhealthy` des aktiven Deployments (Eintrag aus `dep` mit `id = ov.activeDeployment.id`). Nicht `ov.runtimeHealth`: Während ein Anwenden auf die Gesundheit wartet, liefert `connected-overview` dort die Gesundheit des **wartenden** Deployments (`reporting = composite`). Meldet das wartende Deployment `degraded` oder `unhealthy`, ist das der Zwischenzustand „Nicht angewendet“ (4.1.4), kein Fehler der aktiven Version.
- Im Fehlerfenster liegt die Turn-Quote (`errorTurns/turns`) oder die Quote eines Tools (`errors/calls` aus `tools[]`) der aktiven Version bei ≥ `ERROR_RATE_ALARM` = 2 %, mit mindestens `ERROR_MIN_SAMPLE` = 20 Turns bzw. Aufrufen.

`ov.candidate.status = failed` ist **kein** Fehler des Chats: Die aktive Version läuft weiter. Es erscheint nur als „Update fehlgeschlagen“ in der Version (4.1.2), sonst würde das UI einen Rollback der gesunden Version empfehlen.

Das **Fehlerfenster** reicht von `max(activatedAt, jetzt − ERROR_WINDOW)` (auf die Stunde abgerundet) bis jetzt, mit `ERROR_WINDOW` = 24 h. Abfrage: `GET /v2/apps/:appId/metrics?environmentId=&revisionId=<agentRevisionId des aktiven Deployments>&from=<Fensterbeginn>&granularity=hour`.

**Fehlerregel (verbindlich, Philipp 2026-10-05):** Rot ab `ERROR_RATE_ALARM` = 2 % bei mindestens `ERROR_MIN_SAMPLE` = 20 Aufrufen bzw. Anfragen im Fehlerfenster `ERROR_WINDOW` = 24 h, bei einer jüngeren Version seit ihrer Aktivierung. Die drei Werte sind Konstanten im View-Model und gelten überall, wo das UI die Regel nennt (4.1.8, 4.1.9, 4.4). Das Fenster ist nötig, weil ein Fehler in einer seit Wochen laufenden Version in der Quote seit Aktivierung untergehen würde.

**Ursache.**
- Die **Version** ist Ursache, wenn sie im Fehlerfenster aktiviert wurde (`activatedAt` liegt im Fenster) und der Rückweg-Kandidat v{M} (4.1.2) in seinem letzten aktiven Zeitraum (`from = activatedAt` von v{M}, `to = activatedAt` der aktiven Version, gleiche Abfrage mit seiner `agentRevisionId`) mindestens 20 Turns hatte und unter der Schwelle lag. Dann sind Version und Chat rot, Probleme verweist zurück („Eins, durch v{N}“), und nur dann sagt der Hero „Zurück zu v{M} hilft.“.
- Die **Verbindung** ist Ursache im Zustand stale.
- Sonst ist die Ursache **unbekannt**: Probleme ist rot, der Chat als Wirkung ebenfalls, die Version bleibt ok.

Es ist nie mehr als eine Ursache rot, und nie mehr als eine Wirkung.

**Statuszeile** (Mono, Versalien):

| Zustand | Statuszeile |
| --- | --- |
| ok, wartet, pending | „RUNNER MELDETE SICH VOR 11 S“ mit glühendem Live-Punkt |
| error, ein Tool über der Schwelle | „▲ FEHLER SEIT {hh:mm} · {e} VON {n} AUFRUFEN FEHLGESCHLAGEN“ ({e} = `toolErrors`, {n} = `toolCalls` im Fehlerfenster); unter 360 px nur „▲ FEHLER SEIT {hh:mm}“ |
| error, Turn-Quote | „▲ FEHLER SEIT {hh:mm} · {e} VON {n} ANFRAGEN MIT FEHLER“ ({e} = `errorTurns`, {n} = `turns`) |
| error, nur `unhealthy` | „▲ RUNTIME MELDET FEHLER SEIT {hh:mm}“ ({hh:mm} = `updatedAt` des aktiven Deployments) |
| stale (Produktion) | „GETRENNT SEIT {hh:mm}“ |
| stale (andere Umgebung) | „STILL SEIT {hh:mm}“ |
| Zwischenzustand | „WARTET AUF DEN RUNNER · {s} S“ |

`{hh:mm}` bei error ist die Aktivierungszeit, wenn die Version Ursache ist, sonst der Beginn der ersten Stunde mit Fehlern in der Stundenreihe des Fehlerfensters; bei stale ist es `lastSeenAt`. Weil die Metriken stündlich aggregiert und bis zu 10 min verzögert sind, steht im Ledger-Abschnitt „Abgerufen {hh:mm}, Werte bis zu 10 Minuten alt“.

#### 4.1.4 Zustände der Seite

| Zustand | Darstellung |
| --- | --- |
| Laden | Netz statisch und neutral (kein Einzeichnen, keine Kometen, keine Zustandsfarben); Skeleton-Zeilen für H1, Lede und Faden; Ledger-Skeletons. Das Einzeichnen startet erst, wenn alle fünf Antworten da sind. |
| Keine App | Graft mit Caption „Hier würde es anwachsen.“, H1 „Noch keine App verbunden.“, Primäraktion „App verbinden“ → `/connect` |
| App ohne Lebenszeichen (`lastSeenAt = null`) | wie „Keine App“, aber mit App-Name und dem Pairing-Befehl `glirastes connect` als Codeblock |
| Code-Stand nicht gemeldet (`codeVersion.status ∈ {not-reported, artifact-missing}`, vor P04) | Die Chat-Antwort lautet „Noch kein Code-Bericht“ (off), Meta „Kommt mit dem nächsten Start der App“; alle anderen Antworten normal |
| Metriken nicht verfügbar (P09 fehlt: 404; oder 5xx) | Kosten-Antwort „Noch keine Messwerte“ (off), Probleme-Antwort „Keins bekannt“ (ok, Meta mit dem Rückweg). Die Fehlerbedingung stützt sich nur auf `healthStatus` des aktiven Deployments; Ruhe-Aussagen („Ruhig seit …“, „ohne Fehler“) entfallen in Faden und Lede |
| Platform-Fehler | Band oben, Netz neutral, letzte bekannte Antworten grau mit „Stand {hh:mm}“ |
| Zwischenzustand (Anwenden) | siehe unten |
| Zwischenzustand (Zurück) | siehe unten |

**Zwischenzustand beim Anwenden.** Die API aktiviert ein wartendes Deployment nicht von selbst: Der Runner meldet nur seine Gesundheit (`heartbeat` setzt `healthStatus` des wartenden Deployments), aktiviert wird erst, wenn jemand dasselbe Anwenden erneut aufruft (`settle` in `publish-and-deploy.service.ts`; `connected-overview` meldet so lange `action = resume`). Ablauf:
1. Antwort `step = active` → weiter mit Schritt 4.
2. Antwort `step = awaiting_health` → H1 „v{N+1} wird angewendet.“ / „Wartet auf den Runner.“, 2-px-Amber-Linie als unbestimmte Fortschrittsanzeige (`role=progressbar`, `aria-valuetext="läuft, seit 12 s"`), Kernring pulsiert. Der Tab liest alle 2 s `deployments` (und hört SSE `runtime.deployment.pending`/`activated` auf `GET /v1/stream/events?targetAppId=`).
3. Sobald das wartende Deployment (`id = deploymentId` der Antwort) `healthStatus = healthy` meldet, ruft **derselbe Tab** denselben Endpunkt mit demselben Body genau einmal erneut auf (Fortsetzen; die API erkennt das Deployment an seiner festen ID und aktiviert es). Meldet es `degraded` oder `unhealthy`: Zustand „Nicht angewendet“ (H1 „Nicht angewendet.“ / „v{N} läuft weiter.“, Texte in 4.1.8), Primär „Erneut versuchen“ (gleicher Aufruf), Sekundär „Was wir geprüft haben“. Das ist ein Zustand, kein Abbruch: Meldet der Runner später `healthy`, geht es mit Schritt 3 weiter.
4. Aktiv (`ov.activeDeployment.id = deploymentId`): Moment „angewendet“ (4.1.8), Fokus auf die neue H1, Toast mit „Rückgängig machen“ (10 s, ⌘Z). Tools mit `decisionPending` danach zeigen „Wartet auf den Runner“ als Zustand (Szenario „wartet“), nicht als Fortschrittsbalken.

Ein anderer Tab, ein Neuladen oder ein anderer Nutzer sieht `action = resume`: Version „Wird angewendet“, Hero mit Primär „Fortsetzen“ (gleicher Endpunkt; nur mit Anwenden-Recht) und ohne automatischen Aufruf.

**Zwischenzustand beim Zurückgehen.** `rollback` legt sofort ein aktives, gesundes Deployment an (`drizzle-runtime-deployment.store.ts`, kein Health-Gate). Eine Bestätigung des Runners gibt es erst mit D1 (`lastAppliedDeploymentId`). Deshalb:
- vor D1: kein Fortschrittsbalken. Nach der 200-Antwort folgt sofort der Moment „zurück“ mit „Der Runner übernimmt es beim nächsten Abgleich.“ (4.1.8);
- ab D1: H1 „Zurück zu v{M} läuft.“ / „Wartet auf den Runner.“ mit Fortschrittslinie, bis `runner.lastAppliedDeploymentId` der neuen Deployment-ID entspricht; danach „Der Chat nutzt es schon.“

**Aktualisierung.**
- `connected-overview` alle 15 s, solange die Seite sichtbar ist (bestehender `connected-refresh-scheduler`).
- Im Zwischenzustand `connected-overview` und `deployments` alle 2 s, ergänzt um SSE.
- `capabilities` und `metrics` nach jedem Anwenden sowie alle 5 min.

#### 4.1.5 Diagnosekarte „Was wir geprüft haben“

Jede Prüfung hat ein Wort (OK, Fehler, Getrennt, Nicht prüfbar), eine Glyphe und eine Zeit. Geprüft wird nur, was eine Quelle hat:

| Prüfung | Quelle |
| --- | --- |
| Platform erreichbar | erfolgreicher Abruf |
| Umgebung vorhanden | `environments` |
| Letztes Lebenszeichen | `lastSeenAt` |
| Zustand der Runtime | `healthStatus` des aktiven Deployments (`dep`); ein wartendes Deployment erscheint als eigene Zeile „Neue Version: {healthStatus}“ |
| Letzter angewandter Stand und Runner-Version | D1; vorher „Nicht prüfbar“ |
| API-Schlüssel gültig | „Nicht prüfbar“; kein Endpunkt |

#### 4.1.6 Anwenden und Zurück (Dialoge)

**Anwenden.**
- Der Base-UI-`AlertDialog` öffnet sich auf „Abbrechen“. Kopf: Badge „Neu: v{N+1}“, Frage „v{N+1} anwenden?“ (vor D2: „Neue Regeln anwenden?“), Beschreibung „Der Chat in {App} nutzt danach die Regeln aus v{N+1}, sobald der Runner sie bestätigt. v{N} bleibt gespeichert.“
- **Zuerst die Risiken** („Was sich ändert“, links): jedes Tool mit `decisionPending`, mit dem gespeicherten Stand in Worten aus den Feldern mit `origin.* = platform` („ausgeschaltet“, „fragt vorher“, „fragt nicht mehr vorher“, „Risiko: Löscht“, „nur Admin“). „Fragt nicht mehr vorher“ ist eine Lockerung (`requiresApproval = false` mit `origin.requiresApproval = platform`, 4.2.4); davor steht derselbe Satz wie im Formular: „Der Chat fragt dann nicht mehr nach, bevor er „{Tool}“ ausführt.“
- Ein Tool mit `decisionPending` ohne ein Feld mit `origin = platform` heißt „Zurück auf den Code-Wert“: Die laufende Version trägt eine Entscheidung, die gespeicherte nicht mehr. Das lockert, wenn die Entscheidung einschränkte, und verschärft, wenn sie die Rückfrage abschaltete; welches von beiden, sagt die API ohne D15 nicht. Sicher lockernd ist es nur, wenn das Tool danach nicht vorher fragt (dann konnte keine Lockerung bestehen) oder Stufe 3 hat. Geht ein Tool der Stufe 3 auf den Code-Wert zurück, steht davor ein Hinweis mit drei Pips: „{Tool} darf danach wieder {Wort aus 3.8}, {fragt vorher | ohne Rückfrage}.“ Ist noch nichts veröffentlicht (`cap.comparedTo = null`), steht dort „Erste Version: {n} Tools“.
- „Was gleich bleibt“ (rechts): „{n − k} Tools unverändert“, „Code-Stand (nur Regeln, kein neuer Code)“.
- Lockert die Änderung sicher etwas ({l} ≥ 1; {l} = Tools mit „fragt nicht mehr vorher“ plus sicher lockernde „Zurück auf den Code-Wert“), sagt der Dialog: „Lockert {l} Tool-Regeln. Das braucht eine Sicherheitsfreigabe; als Owner oder Admin gibst du sie mit dem Anwenden selbst, sie wird protokolliert.“ (`selfApproveCritical`, `runtime-revision.service.ts`; Rollen in Abschnitt 4). Einen zweiten Bestätigungsschritt gibt es nicht.
- Sicherheitszeile: „Rückweg: v{N}, über Historie & Rollback.“ Keine Zeit- oder Beobachtungszusage (1.3).
- Aufruf:
  - mit bekannter Revision (aus der `PATCH`-Antwort dieser Sitzung oder aus D3): `POST /v2/apps/:appId/runtime-setup/configurations/:configurationRevisionId/apply` mit `{ environmentId }`
  - sonst bei `ov.action = apply` und vorhandenem Kandidaten: `POST /v2/apps/:appId/runtime-setup/runs/:runId/apply` mit `{ environmentId }` (dieser Pfad wendet die ausstehende Konfiguration zuerst an). Er gilt nur für die erste Pipeline-Umgebung mit frischem Runner (`assertConnectedEnvironment`). Für Pro-Umgebungen dahinter ist D3 deshalb Voraussetzung, kein Komfort.
- Antwort `PublishAndDeployResult { compositeId, step: 'awaiting_health' | 'active', deploymentId, healthStatus }`; weiter wie in 4.1.4.

| Fehler (Text der API) | Bedeutung | UI |
| --- | --- | --- |
| 403 „Publish & Deploy requires publisher and security-approver roles“ | Rolle fehlt (`assertActorCanRun`, gilt für jedes Anwenden, auch für reine Verschärfungen) | flacher Knopf „Anwenden dürfen Owner und Admins.“ (Abschnitt 4, Rollen) |
| 403 „Revision publication was denied“ | Ein `security-approver` hat genau diese Revision über die Revisions-API abgelehnt (`assertPublicationAllowed`; im Foundation-Profil ohne UI, 2.1). Die Revisions-ID folgt aus den Entscheidungen, die Ablehnung bleibt also, bis sich eine Entscheidung ändert | „Diese Regeln wurden abgelehnt. Ändere eine Regel, um eine neue Version zu erzeugen.“; nie als Rollenfehler |
| 409 „The app configuration is not the revision that signs the current tool decisions“ | Jemand hat inzwischen weiter entschieden | neu laden, Dialog mit dem neuen Stand erneut zeigen |
| 409 „The app configuration can no longer be applied“ | Revision veraltet | neu laden |
| 404 „App configuration revision not found“ | Revision unbekannt | neu laden |
| 409 „Terminal composite deployment cannot be resumed“ | Das Deployment dieser Revision ist schon beendet (z. B. zurückgerollt) | neu laden; „Erneut anwenden“ gibt es erst mit D8 |
| 409 „Connected runtime is not fresh“ (nur `runs/:runId/apply`) | Runner länger still als das Frische-Fenster | Zustand stale |
| 409 „A newer configuration signs the current tool decisions; this setup run can no longer be resumed“ (nur `runs/:runId/apply`) | Lauf durch eine Regel-Revision ersetzt | neu laden |

Die 403 „security approval role required“ aus `publishBatchResumable` ist über diese Endpunkte nicht erreichbar, weil `assertActorCanRun` dieselbe Bedingung vorher prüft; sie wird wie die erste 403 behandelt.

**Zurück** (`POST /v1/apps/:appId/environments/:environmentId/deployments/:deploymentId/rollback`, Hauptrolle Owner, Admin oder Publisher):
- Der `AlertDialog` öffnet sich auf „Abbrechen“. Kopf: Badge („v{N} schlägt fehl“ im Fehlerzustand, sonst „v{M} war gesund“), Frage „Zu v{M} zurückkehren?“. Er nennt:
  - die Zielversion und ihren aktiven Zeitraum („von {Datum} bis {Datum}“)
  - „v{N} bleibt gespeichert.“
  - „Regeln, die du nach v{M} gespeichert hast, bleiben gespeichert. Sie wirken nach dem Zurückgehen erst wieder, wenn du sie erneut anwendest.“ (Die Tools zeigen dann `decisionPending`; das erneute Anwenden kommt mit D8.)
  - „Was gleich bleibt: Verbindung und Schlüssel, Kosten und Historie.“
  - „Rückgängig: 10 Sekunden lang per Knopf, danach steht v{N} in der Historie.“
- Eine Liste „Was sich ändert“ (Tools, die wegfallen oder zurückkommen) entfällt bis D15; es gibt keinen Vergleich zweier Konfigurationen.
- Fehler: 404 „Approved rollback deployment not found“ → „Dieser Stand ist nicht mehr als gesund bestätigt.“; 409 „Target deployment is already active“ → neu laden; 403 „Publisher role required“ → flacher Knopf „Zurückgehen dürfen Owner und Admins.“

**Rückgängig machen** (Toast 10 s, ⌘Z, im Hero als Sekundärknopf, solange der Toast steht). Wie im freigegebenen Prototyp ohne zweiten Dialog, aber nur, wenn die Rolle die Gegenaktion erlaubt:
- nach Anwenden: `rollback` auf das Deployment, das vor dem Anwenden aktiv war (ID beim Öffnen des Dialogs gemerkt; es ist danach `superseded` und `healthy`, also zulässig). Toast danach: „Rückgängig gemacht. v{N} ist wieder aktiv.“
- nach Zurück: `rollback` auf das Deployment, von dem zurückgegangen wurde (`rolled_back` und `healthy`, also zulässig).
- nach „Regeln ändern“ im Drawer: `PATCH` mit der Umkehrung (jedes geänderte Feld auf seinen vorigen Platform-Wert oder `null`), danach dasselbe Anwenden. Die Umkehrung einer Verschärfung lockert; die Umkehrung einer Lockerung (`requiresApproval: null`) verschärft. Beides braucht das Anwenden-Recht (Owner, Admin).

#### 4.1.7 Free und Pro

| | Free (`productMode = connected_free`) | Pro (`managed`) |
| --- | --- | --- |
| Umgebungen | eine; kein Umgebungswechsel, der Schalter zeigt den Hinweis „Weitere Apps und Umgebungen gibt es mit Pro“ | Wechsel im Sidebar-Schalter, geordnet nach `promotionOrder` |
| Version | Platform-Regeln anwenden | zusätzlich Info „In {Vorumgebung} aktiv: v{N+1}“, wenn eine frühere Umgebung (kleinere `promotionOrder`) eine andere `configRevisionId` aktiv hat (je Umgebung `GET …/deployments`, nur auf `/manage`). Übernehmen bietet die UI erst mit D8 an. Die Expertenroute `/rollouts` mit ihrem Promote, das gespeicherte Entscheidungen weglassen kann (P08b Task 14, Punkt 4), ist im Foundation-Profil ausgeblendet (2.1) |
| Probleme-Rückweg | wie Pro | wie Free |
| Kosten-Antwort | Monat, Umgebung | wie Free |

#### 4.1.8 Hero-Texte pro Zustand

Jede H1 sind genau zwei kurze Sätze (3.4, `fitHero`). Platzhalter kommen aus dem View-Model: {n} = aktivierte, nicht entfernte Tools; {p} = Größe der Prüf-Menge; {k} = Tools mit `decisionPending`; {l} = davon sicher lockernd (4.1.6); {d} = Ruhetage (4.1.2); {Tool} = Name nach 4.2.2; v{N}/v{M} = Versionsnummern nach D2 (vorher „die aktuelle Konfiguration“ bzw. „die Konfiguration vom {Datum}“). Ein in Klammern genannter Teilsatz entfällt, wenn seine Bedingung nicht gilt.

| Zustand | H1 (Zeile 1 / Zeile 2) | Lede (Desktop, Tablet) | Kurzzeile (Telefon) | Primär | Sekundär |
| --- | --- | --- | --- | --- | --- |
| ok | „Alles läuft ruhig.“ / „Nichts wartet.“ | „Der Runner meldet sich, {n} Tools sind bereit(, {p} brauchen einen Blick), und seit {d} Tagen gab es keinen Fehler.“ Ohne Metriken endet der Satz mit „…, und v{N} ist seit {Datum} aktiv.“ | „Runner da · {n} Tools · {d} Tage ohne Fehler“ | „Nutzung ansehen“ im Sekundärstil (keine Amber-Aktion) → `/manage/usage` | – |
| wartet | „Alles läuft.“ / „Der Runner übernimmt.“ | „v{N} ist aktiv. Bis der Runner sie bestätigt, gelten für {k} Tools noch die vorigen Regeln.“ | „v{N} aktiv · Runner bestätigt noch“ | „Was sich geändert hat“ im Sekundärstil → `/manage/history` | – |
| pending | „Alles läuft.“ / Amber-Phrase „Version {N+1} ist bereit.“ (vor D2: „Neue Regeln sind bereit.“) | „v{N+1} ändert die Regeln für {k} Tools(, {l} davon gelockert). v{N} bleibt aktiv, bis du anwendest.“ | „{k} Tool-Regeln · umkehrbar“ | „v{N+1} anwenden…“ (`U`; ohne Recht flach) | „Was sich ändert“ (springt zum Abschnitt Version) |
| Zwischenzustand Anwenden | „v{N+1} wird angewendet.“ / „Wartet auf den Runner.“ | „Glirastes verteilt v{N+1} an den Runner in {Umgebung}. Sobald er sie gesund meldet, steht es hier. v{N} bleibt gespeichert.“ | „Wartet auf den Runner · {s} s“ | Fortschrittslinie und „Wartet auf den Runner“; in fremdem Tab bei `action = resume` stattdessen „Fortsetzen“ | – |
| Nicht angewendet | „Nicht angewendet.“ / „v{N} läuft weiter.“ | „Der Runner meldet v{N+1} als {eingeschränkt \| fehlerhaft}. Der Chat nutzt weiter v{N}.“ | „v{N+1} nicht gesund · v{N} läuft“ | „Erneut versuchen“ | „Was wir geprüft haben“ |
| Zwischenzustand Zurück (ab D1) | „Zurück zu v{M} läuft.“ / „Wartet auf den Runner.“ | „Der Runner stellt auf v{M} um. Sobald er es bestätigt, steht es hier. v{N} bleibt gespeichert.“ | „Wartet auf den Runner · {s} s“ | Fortschrittslinie | – |
| Moment angewendet | „v{N+1} ist aktiv.“ / „Der Runner hat sie bestätigt.“ | „{k} Tool-Regeln wirken jetzt. v{N} bleibt gespeichert, der Rückweg steht unten.“ | „v{N+1} aktiv · Rückweg v{N}“ | „Geänderte Tools ansehen“ → `/manage/tools?view=changed` | „Rückgängig machen“, solange der Toast steht; danach „Was sich geändert hat“ |
| Moment zurück | „Zurück auf v{M}.“ / „v{N} bleibt gespeichert.“ | vor D1: „Der Runner übernimmt v{M} beim nächsten Abgleich. Regeln, die du nach v{M} gespeichert hast, ruhen, bis du sie erneut anwendest.“ Ab D1, nach Bestätigung: „Der Chat nutzt v{M} seit {hh:mm}. …“ | „v{N} gespeichert · Regeln ruhen“ | „Historie öffnen“ → `/manage/history` | „Rückgängig machen“, solange der Toast steht |
| error, Ursache Version | „v{N} hat ein Problem.“ / „Zurück zu v{M} hilft.“ | Tool: „Seit {hh:mm} schlagen bei „{Tool}“ {e} von {c} Aufrufen fehl.( Alle anderen Tools arbeiten normal.) v{M} lag in seiner Zeit unter 2 %.“ – „Alle anderen …“ nur, wenn `toolErrors` im Fenster gleich den Fehlern dieses Tools ist. Turns: „Seit {hh:mm} enden {e} von {n} Anfragen mit Fehler. v{M} lag in seiner Zeit unter 2 %.“ | „Nur „{Tool}“ betroffen · umkehrbar“ bzw. „{e} von {n} Anfragen · umkehrbar“ | „Zu v{M} zurückkehren…“ | „Was wir geprüft haben“ |
| error, Ursache unbekannt | „Ein Tool schlägt fehl.“ bzw. „Anfragen schlagen fehl.“ bzw. „Die Runtime meldet Fehler.“ / „Die Ursache ist offen.“ | „Seit {hh:mm} schlagen bei „{Tool}“ {e} von {c} Aufrufen fehl. v{N} läuft seit {Datum}, der Fehler begann später.“ (Turn- und Runtime-Fall sinngemäß) | „Seit {hh:mm} · Ursache offen“ | Tool-Fall: „„{Tool}“ ansehen“ (öffnet den Drawer); sonst „Was wir geprüft haben“ | Tool-Fall: „Was wir geprüft haben“ |
| stale, Produktion | „Deine App meldet sich“ / „seit {hh:mm} nicht.“ | „Der Runner in {Umgebung} hat sich zuletzt um {hh:mm} gemeldet. Ob der Chat gerade läuft, sehen wir von hier aus nicht. Ein Neustart der App verbindet sie neu.“ | „Still seit {hh:mm} · App neu starten“ | „Verbindung jetzt prüfen“ (lädt sofort neu) | „Was wir geprüft haben“ |
| stale, andere Umgebung | „{Umgebung} ist still.“ / „Seit {hh:mm}.“ | wie Produktion | wie Produktion | wie Produktion | wie Produktion |

Keine App, App ohne Lebenszeichen, Laden und Platform-Fehler stehen in 4.1.4.

#### 4.1.9 Ledger-Abschnitte

Jeder Abschnitt: Eyebrow (Frage), Satz, Unterzeile, Körper, höchstens ein nächster Schritt. Was im Prototyp stand, aber keine Quelle hat, steht in der letzten Spalte und entfällt.

| Abschnitt | Satz und Unterzeile (je Zustand) | Körper (Quelle) | Nächster Schritt | Entfällt |
| --- | --- | --- | --- | --- |
| Verbindung (5) | verbunden: „Der Runner meldet sich, zuletzt vor {s} s.“ · eingeschränkt: „Der Runner meldet sich, die Runtime ist eingeschränkt.“ · stale: „Nein. Seit {hh:mm} kein Lebenszeichen.“ | Fakten: Umgebung „{name} ({kind})“; Letztes Lebenszeichen (`lastSeenAt`, tickend); Zustand der Runtime (`healthStatus` des aktiven Deployments: Gesund / Eingeschränkt / Fehlerhaft / Unbekannt); ab D1 Runner-Version und „Zuletzt übernommen: v{N}“ | verbunden: „Weiteres Gerät verbinden →“ (`/connect`); stale: „Diagnose ansehen →“ | Server-Zeilen, Region, Latenz, Lebenszeichen-Leiste (1.3) |
| Chat (7) | Fehler: „„{Tool}“ schlägt fehl(, {p} weitere brauchen einen Blick).“ · Prüf-Menge: Satz aus den Gründen, nur Teile ungleich 0: „{a} sind nicht beschrieben, {b} konnte Glirastes nicht einordnen, bei {c} ist das Risiko gestiegen.“ · sonst: „Die meisten lesen nur, {k3} dürfen löschen, versenden oder bezahlen.“ (wenn Stufe 0–1 die Mehrheit ist; sonst „{k2} ändern Daten, {k3} dürfen löschen, versenden oder bezahlen.“) · still: „Die Tools sind gemeldet. Ob der Chat sie gerade nutzt, sehen wir nicht.“ | Risikobalken mit Legende (Zählung je Pip-Stufe, 3.8). Mit Prüf-Menge: die ersten drei mit Glyphe, Grund und „Prüfen →“ (zugänglicher Name „Prüfen: {Tool}“), darunter „und {x} weitere“. Ohne: die drei meistgenutzten Tools aus `tools[]` des Übersichtsfensters, beschriftet „Am häufigsten genutzt, letzte 30 Tage“ | „Alle {p} prüfen →“ (`/manage/tools?view=attn`) bzw. „Alle Tools ansehen →“ | „oft falsch aufgerufen“ (P05) |
| Version (5) | pending: „{k} Tool-Regeln ändern sich(, {l} davon gelockert).“ / „Gespeichert, noch nicht angewendet.“ · error (Ursache Version): „Seit {hh:mm} aktiv, {e} von {n} Aufrufen fehlgeschlagen.“ / „Rot ab 2 % bei mindestens 20 Aufrufen. v{M} ist der letzte gesunde Stand.“ · wartet: „Aktiv seit {hh:mm}, der Runner bestätigt noch.“ · Neu im Code: „{k} Tools sind neu im Code und schon aktiv.“ · ok: „Seit {Datum} aktiv.“ / „Code-Bericht {reportedAt}.“ | pending: die ersten drei Tools mit `decisionPending` und ihr neuer Stand (wie im Dialog, 4.1.6), Spur „Gespeichert ✓ → Anwenden: wartet auf dich“. error: Fakten „v{N} im Fehlerfenster“ = ofN(`toolErrors`, `toolCalls`), „„{Tool}“ allein“ = ofN(`errors`, `calls`), „Die anderen Tools“ = Rest (nur bei Rest-Aufrufen > 0). ok: Fakt „Anfragen ohne Fehler, letzte 24 h“ = ofN(`turns − errorTurns`, `turns`); „Nächste Version: keine bereit“; Spur der letzten vier Deployments aus `dep` (Nummer, Datum; zurückgerollt markiert, wenn `status = rolled_back` oder als `rolledBackFromId` genannt). Neu im Code: Namen der neuen Tools | „Historie öffnen →“ | „in Staging ohne Fehler“, „Synchronisiert von …“, „Betroffen: nur Server 2“, „15 Minuten Beobachtung“ (1.3) |
| Kosten (7) | mit Hochrechnung: „Auf Kurs für etwa {proj} in diesem Monat.“ · ohne: „{knownUsd} seit dem 1. {Monat}.“ · Varianten mit „mindestens“ bzw. „Kosten unbekannt“ wie in 4.1.2 | Aufteilung „laut Anbieter“ (Summe `providerReportedUsd`) und „geschätzt“ (Summe `priceTableUsd`, Unterzeile „Tokens × Preisliste“); bei unbekanntem Anteil „{u} Anfragen ohne Kostenangabe“. Minibalken über die 30 UTC-Tage des Übersichtsfensters (Vormonat in `chart-3`, geschätzter Anteil schraffiert), Versionsmarker aus `dep.activatedAt`, die bereite Version als Amber-Marker am heutigen Tag | „Kosten ansehen →“ | Budget und „% vom Budget“ (D10) |
| Probleme (12) | error, Ursache Version: „Eins, und seine Ursache ist bekannt.“ / „Was jetzt hilft, steht oben.“ · error, unbekannt: „Eins: {Tool} schlägt fehl.“ / „v{N} läuft seit {Datum}, der Fehler begann {hh:mm}.“ · stale: „Eins, und seine Ursache ist bekannt.“ / „Die App meldet sich seit {hh:mm} nicht.“ · Moment zurück: „Zurück auf v{M} seit {hh:mm}.“ · ok: „Zuletzt am {Datum} ein Fehler.“ bzw. „Kein Fehler seit {range.from}.“ / „Rot wird es ab 2 % Fehlerquote bei mindestens 20 Aufrufen in 24 Stunden.“ | Fakten error Version: Ursache „v{N}, siehe Version“, Erkannt „ab {hh:mm}“, Rückweg „v{M}, bis {Datum} aktiv“. error unbekannt: „{Tool}“ ofN, Rückweg, „Hilft ein Rollback?“ „Unklar, der Fehler begann nach der Aktivierung“. stale: Ursache „keine Meldung, siehe Verbindung“, „Hilft ein Rollback?“ „Nein, die Verbindung fehlt“, „Was hilft“ „App in {Umgebung} neu starten“. Moment zurück: „v{N}: gespeichert, inaktiv“, „{k} Regeln ruhen bis zum erneuten Anwenden“. ok: Letzter Fehlertag mit Anzahl, Regel, Rückweg | error Version: „Zu v{M} zurückkehren… →“ (Dialog); error unbekannt: „„{Tool}“ ansehen →“; stale: „Diagnose ansehen →“; sonst „Historie öffnen →“ | „Alarm um …“, „Prüfung läuft jede Minute“, „17 Anfragen“ (1.3) |

Ein Fehlerabschnitt trägt die rote Linie, ein „Bekannt“-Abschnitt die neutrale (3.5).

#### 4.1.10 Befehlspalette und Kürzel

Die Palette (⌘K / Ctrl K, `components/command-palette.tsx` mit shadcn `Command` im Dialog, Radius 20) hat drei Gruppen:

| Gruppe | Einträge |
| --- | --- |
| Springen | Übersicht (`G O`), Was kann mein Chat? (`G T`), Kosten & Nutzung (`G K`), Historie & Rollback (`G H`), Gerät verbinden (`G V`), Einstellungen, Team. Keine Expertenrouten (2.1) |
| Aktionen | „v{N+1} anwenden…“ (`U`), „Zu v{M} zurückkehren…“, „Helles Design“ / „Dunkles Design“, „Sprache: English“ (im Englischen „Language: Deutsch“, 2.4), „Tastenkürzel anzeigen“ (`?`). Kein „Neustart-Befehl kopieren“ (1.3) |
| Tools | nur mit Suchtext: bis zu sechs Treffer aus `cap.tools` in Name, Titel (D4) oder `toolId`; öffnet `/manage/tools?tool=<toolId>` |

Nicht verfügbare Einträge stehen grau mit Grund darunter („Keine neue Version bereit“, „Kein älterer gesunder Stand“, „Anwenden dürfen Owner und Admins.“); Enter auf einem grauen Eintrag zeigt den Grund als Toast. Fußzeile: „↑↓ auswählen · ↵ ausführen · Graue Befehle sagen dir, warum sie gerade nicht gehen.“ Leerer Treffer: „Nichts gefunden für „{q}“.“ Der Kürzel-Dialog (`?`) listet alle Kürzel aus 6.1 und enthält den Schalter „Kürzel mit einzelnen Tasten“ mit dem Hinweis „Schalte sie aus, wenn du Spracheingabe oder eine Bildschirmtastatur nutzt. ⌘K und ⌘Z bleiben.“

### 4.2 Was kann mein Chat? (`/manage/tools`)

#### 4.2.1 Kopf und Band

- Seitenkopf: Kicker-Pill (Zustand der Chat-Antwort, z. B. „1 Fehler“ + „◆ +5 prüfen“), Mono-Frage, H1 „Was kann mein Chat?“, Lede „{n} Tools in {m} Bereichen, Stand v{N}. Hier machst du jedes Tool strenger oder schaltest seine Rückfrage ab, solange es höchstens Daten ändert. Was löscht, versendet, bezahlt oder nicht eingeordnet ist, fragt immer.“ (vor D4 ohne „in {m} Bereichen“; vor D16 lautet der zweite Satz „Hier kannst du jedes Tool strenger machen.“ und der dritte entfällt) Dahinter die Platte der Tools-Hyphe.
- Zusammenfassungsband 4/3/2/3 auf drei gemeinsamen Zeilen (Label / Zahl / Zeile). Auf dem Telefon 2 × 2, Zahlen 28 px.

| Kennzahl | Quelle |
| --- | --- |
| Risiko | Balken und Legende aus der Tier-Zählung der aktivierten Tools |
| Brauchen einen Blick | Prüf-Menge. Im Fehlerfall „1 Fehler“ und darunter ein Pfeil-Link mit dem Namen des Tools, der den Drawer öffnet (zugänglicher Name „1 Fehler: {Tool}, Details öffnen“), dann leise „◆ +5 prüfen“ |
| Fragen vorher | Zählung `requiresApproval = true` |
| Von dir geändert | Tools mit mindestens einem Feld, dessen `origin = platform` ist; Zeile „{e} strenger · {r} gelockert“ ({r} = Tools mit `requiresApproval = false` und `origin.requiresApproval = platform`, {e} = die übrigen; ein Teil mit 0 entfällt), darunter „wirken nach dem Anwenden“ bzw. „{k} warten aufs Anwenden“, wenn `decisionPending` |

#### 4.2.2 Werkzeugleiste und Tabelle

- **Werkzeugleiste:**
  - Suche (`/`, kündigt „n Treffer“ an)
  - Segmente als Base-UI-`ToggleGroup` mit stabilen Keys (der Fokus bleibt erhalten): Alle · Prüfen (bzw. Fehler) · Fragen vorher · Von dir geändert (`view=changed`: mindestens ein Feld mit `origin = platform`, strenger oder gelockert) · Neu im Code
  - Auswahl Bereich (`module`, D4) und Risiko
- **Tabelle:** rahmenlos, gruppiert nach Bereich, innerhalb der Gruppe nach Risiko absteigend.
  - Spalte 1: Name, Beschreibung, Hinweis-Badges
  - Spalte 2: Risiko-Pips mit Wort
  - Spalte 3: 7 Tage (Aufrufe)
  - Gruppenköpfe sind Überschriften, mit derselben Zählregel („▲ 1 Fehler +5“)
  - Auf dem Telefon nur Spalte 1
- **Name eines Tools:** `title` (D4). Vorher `name` in JetBrains Mono, darunter die erste Zeile von `description`.
- **Hinweis-Badges pro Zeile:**
  - Neu im Code (`status = new`, Blau)
  - Geändert (`changed`, Mono `~`)
  - Risiko gestiegen (`risk-raised`, Violett)
  - Entfernt (`removed`, durchgestrichen, `enabled = false`, ganz unten in der Gruppe)
  - Fragt vorher
  - Eingeschränkt (Schloss; ein Feld mit `origin = platform` und strengerem Wert)
  - Gelockert (offenes Schloss, neutral; `requiresApproval = false` mit `origin.requiresApproval = platform`, ab D16)
  - Wartet aufs Anwenden (`decisionPending`, Amber)
  - Lockerung wartet auf den Code (`relaxationPending`, neutral; nach D16 nicht mehr erreichbar, 4.2.4)
- **7 Tage:** `GET /v2/apps/:appId/metrics?environmentId=&from=<heute 00:00 UTC − 7 Tage>&granularity=day` → `tools[]` (Top 20) und `totals.toolCalls`. Ein Tool, das in `tools[]` fehlt, zeigt „0“ nur dann, wenn die Summe der `calls` in `tools[]` gleich `totals.toolCalls` ist (dann ist jeder Aufruf zugeordnet). Sonst zeigt es „–“ mit dem Tooltip „nicht unter den 20 meistgenutzten“, bis D6 geliefert ist.
- **Ausschlüsse** (`cap.exclusions`) stehen unter der Tabelle als einklappbarer Abschnitt „Bewusst keine Tools“ mit `stableKey` (Mono) und Herkunft.

#### 4.2.3 Drawer (`?tool=<toolId>`, shadcn `Sheet`)

Der Fokus liegt auf dem Titel; Esc schließt und gibt den Fokus an den Auslöser zurück. Reihenfolge:

1. **Kopf:** Bereich und Badge, Titel (Geist 28), `toolId` in Mono.
2. **Beschreibung** (`description`, oder „Für dieses Tool gibt es keine Beschreibung.“). Meta-Zeile:
   - Risiko-Pips mit Wort
   - Fragt vorher / Fragt nicht vorher
   - Herkunft der Beschreibung: `quality.descriptionSource` human → „von Hand geschrieben“, code → „aus dem Code“, agent → „vom Agenten abgeleitet“, template → „aus Vorlage“, fehlt → „Herkunft nicht gemeldet“
3. **„So behebst du es“** (nur bei Befund), mit Mono-Schrittnummern:

| Befund | Schritte |
| --- | --- |
| Beschreibung fehlt | Datei im Code öffnen und beschreiben (oder die Arbeitsliste `glirastes tools describe --print <tool>` dem eigenen Coding-Agenten geben, Spec 4.6), dann `glirastes tools refresh` |
| Beschreibung kommt vom Agenten (`descriptionSource = agent`) | Beschreibung im Code prüfen, dann `glirastes tools verify <tool>` |
| `needs-attention` | „Glirastes konnte dieses Tool nicht sicher einordnen“, dann `glirastes tools status` |
| Fehler | Rate mit Anzahl; Rückweg-Knopf „Zu v{M} zurückkehren…“, wenn die Version die Ursache ist |
| `risk-lower-available` | `glirastes tools policy accept <tool>` (Info) |

   Befehle stehen im Codeblock mit Kopierknopf. Es werden nur Befehle gezeigt, die es laut Spec 4.2 gibt; `<tool>` ist der Bezeichner, den `glirastes tools status` für dieses Tool ausgibt. `describe`, `verify` und `policy` kommen erst mit P04/P05 in die CLI (Release 0.5.0); der Drawer zeigt sie nur, wenn die Runner-Version aus D1 ≥ 0.5.0 ist, sonst nur `refresh` und `status`.
4. **„Letzte 7 Tage“** in der aktuellen Umgebung: Aufrufe, Fehler und Fehlerquote mit Anzahl (aus `tools[]`). Die Tagesbalken kommen erst mit D6; vorher stehen nur die Summen. Eine Latenz pro Tool gibt es nicht.
5. **„Regeln ändern“** (4.2.4; im Prototyp „Strenger machen“).
6. **„Technische Details“** (eingeklappt):
   - `kind` und `method path`
   - Herkunft je Feld (`origin`)
   - `quality.contractSource`, `quality.schemaSource`
   - `warnings` als Codes
   - `codeVersion`, beschriftet als „Endpunkt-Inventar {digest kurz} · gemeldet {reportedAt}“, dazu der Satz „Dieser Stand deckt nur die Endpunkte ab; UI-Aktionen können aus einem neueren Build stammen.“ (Roadmap-Zeile zum `discoveryDigest`, bis P05/P13 den Digest über das ganze Artefakt bilden). Die lesbare Version „v{N}“ meint überall die Konfigurationsrevision, nie den Code-Stand.

#### 4.2.4 Formular „Regeln ändern“ (strenger machen, Rückfrage lockern bis Stufe 2, nur Abweichungen)

Philipp am 2026-10-05 zum Lockern im Dashboard: „ich würde sagen dass man das kann. Machen wir es nicht zu kompliziert.“ Das Formular macht Tools deshalb strenger und lockert genau eine Sache: Owner und Admins können die Rückfrage eines Tools abschalten, dessen wirksame Risikoklasse höchstens Stufe 2 hat (`safe-read`, `read-sensitive`, `write`). Stufe 3 (`delete`, `external`, `financial`, `unknown`) ist nie lockerbar. Die Lockerung wird als Entscheidung gespeichert und mit dem normalen Anwenden ausgerollt; einen eigenen Freigabe-Ablauf gibt es nicht (Abschnitt 4, Rollen). Das Lockern setzt D16 voraus; vorher bietet das Formular es nicht an und kündigt es auch nicht an (1.1).

Ein reines Modul `lib/view-models/override-draft.ts` beschreibt Choices und Body. Grundlage sind die wirksamen Werte aus `cap.tools[i]`, die Herkunft je Feld (`origin`) und die eigenen Rollen (Abschnitt 4).

Was die API **nicht** liefert, und was daraus folgt:
- Den Code-Wert eines Felds mit `origin = platform` gibt keine Route heraus. `capabilities` liefert nur den wirksamen Wert, und `GET …/runtime-setup` überschreibt im Artefakt-Auszug die Tool-Werte ebenfalls mit den wirksamen (`artifactSummary`). Für `enabled` und `requiresApproval` ist der Code-Wert trotzdem eindeutig: Die Platform kann `enabled` nur ausschalten und kehrt bei `requiresApproval` den Code-Wert nur um (einschalten oder, als Lockerung, abschalten); bei `origin = platform` ist der Code-Wert also das Gegenteil des wirksamen. Für `riskClass` und `allowedRoles` ist er unbekannt.
- Die gespeicherte Entscheidung selbst gibt keine Route heraus. `origin = platform` heißt nur „eine gespeicherte Entscheidung ändert diesen Wert“; ein gespeichertes No-op ist unsichtbar (D9 verwirft es serverseitig).

Deshalb bezieht das Formular jede Wahl auf den **wirksamen** Wert: Es bietet Werte an, die strenger sind als der wirksame, als einzige Lockerung das Abschalten der Rückfrage (unten) und für Felder mit `origin = platform` „Auf den Code-Wert zurück“. Außer bei der Rückfrage liegt der wirksame Wert nie unter dem Code-Wert, jede andere Wahl bleibt also über dem Code-Wert. Mit D14 kann das Formular den Code-Wert nennen und Zwischenstufen zwischen Code- und Platform-Wert anbieten.

| Feld | Angebotene Wahl | Nicht angeboten (mit sichtbarem Grund) |
| --- | --- | --- |
| Tool ausschalten (`enabled`) | Schalter „aus“, wenn das Tool wirksam an ist | Einschalten eines im Code deaktivierten Tools („Im Code ausgeschaltet.“); entfernte Tools (`status = removed`) haben kein Formular („Nicht mehr im Code.“) |
| Vorher nachfragen (`requiresApproval`) | **Einschalten**, wenn es wirksam aus ist, die Stufe < 3 und `origin.requiresApproval ≠ platform` (eine gelockerte Rückfrage schaltet „Auf den Code-Wert zurück“ wieder ein, ohne eine zusätzliche Entscheidung `true` zu speichern). **Ausschalten (Lockern)**, wenn alles gilt: (a) wirksam an mit `origin.requiresApproval = code-default`; (b) wirksame Stufe ≤ 2; (c) `origin.riskClass ≠ platform`, und der Entwurf hebt das Risiko nicht an (die API pinnt die Lockerung an die gemeldete Klasse, jede Anhebung lässt sie verfallen, `override-lapsed-risk-raised`); (d) die Rolle darf anwenden (Abschnitt 4; ist die Rolle unbekannt, gilt sie als berechtigt und die API entscheidet); (e) D16 ist geliefert. **„Auf den Code-Wert zurück“**, wenn `origin.requiresApproval = platform` (an oder gelockert) und `origin.riskClass ≠ platform` | Es gilt der erste zutreffende Grund: Stufe 3: „Löscht, versendet oder bezahlt: fragt immer.“, bei `unknown`: „Nicht eingeordnet: fragt immer.“ · `origin = local-policy`: „In `tool-policy.json` eingeschaltet. Ausschalten geht nur dort.“ (eine lokale Härtung gewinnt, Spec 10 Punkt 5) · `origin = null`: „Woher die Rückfrage kommt, meldet die App nicht. Ausschalten geht hier nicht.“ · Risiko angehoben (gespeichert oder im Entwurf): „Mit angehobenem Risiko fragt das Tool immer.“; das gilt auch für „Auf den Code-Wert zurück“, weil die Platform die Rückfrage dann aus dem angehobenen Risiko ableitet (`raisedIntoConfirmation`, `origin.requiresApproval = platform` auch ohne eigene Entscheidung) und `requiresApproval: null` nichts änderte · vor D16: „Im Code eingeschaltet. Ausschalten geht nur dort.“ · Rolle ohne Anwenden-Recht: flach „Lockern dürfen Owner und Admins.“ |
| Risiko anheben (`riskClass`) | nur Klassen mit höherer Stufe als der wirksame Wert: Stufe 1 „Liest Sensibles“ (`read-sensitive`), Stufe 2 „Ändert Daten“ (`write`), Stufe 3 einzeln „Löscht“ (`delete`), „Versendet / extern“ (`external`), „Bezahlt“ (`financial`). Darunter: „Unter „{Wort}“ senken geht nur im Code.“ | gleiche oder niedrigere Stufe (die API lehnt das gegenüber dem Code-Wert mit `risk-class-lowered` / `risk-class-relabelled` ab); bei Stufe 3 oder `unknown` gibt es nichts anzuheben |
| Wer darf es benutzen? (`allowedRoles`) | Abwählen aus den wirksamen `allowedRoles` (bei `origin ≠ platform` sind das die vom Code gemeldeten); mindestens eine Rolle bleibt („Zum Abschalten nutze ‚Tool ausschalten‘“) | Rollen hinzufügen. Meldet der Code keine Rollen (es gilt die Autorisierung des Endpunkts), steht dort: „Es gelten die Rechte des Endpunkts. Rollen einschränken geht hier, sobald die App ihre Rollen meldet.“ (D5) |
| Beschreibung | – | wird im MVP nicht im Dashboard bearbeitet und nie gesendet (Roadmap: Dashboard-Speichern würde signierte Beschreibungen einfrieren). Beschreibungen ändert man im Code (Skill `describing-glirastes-tools`, P05). |

**Body-Regel.** Gesendet wird ausschließlich, was der Nutzer in diesem Entwurf geändert hat, bezogen auf den angezeigten wirksamen Wert:

| Aktion im Formular | Gesendet |
| --- | --- |
| Feld unberührt oder auf den angezeigten Wert zurückgestellt | nichts |
| Feld verschärft (Entwurf strenger als der wirksame Wert) | `feld: wert` |
| „Vorher nachfragen“ ausgeschaltet (Lockern, Bedingungen oben) | `requiresApproval: false`; die API pinnt die Lockerung an die gemeldete Risikoklasse (`baselineRiskClass`) |
| „Auf den Code-Wert zurück“ bei `origin.feld = platform` | `feld: null` |
| „Gespeicherte Lockerung verwerfen“ bei `relaxationPending = true` | `requiresApproval: null` |

- Ist der Body leer, ist „Speichern“ deaktiviert, und es gibt keine Anfrage.
- `description` wird nie gesendet. `requiresApproval: false` wird nur als Lockern unter den Bedingungen oben gesendet, nie bei Stufe 3 (die API antwortet dort mit 422 `tier-3-always-requires-approval`) und nie zusammen mit einer Anhebung von `riskClass`.
- Rollen werden sortiert und dedupliziert; eine Auswahl gleich den wirksamen Rollen gilt als unberührt.
- Gespeichert wird weiterhin nur die Abweichung (Body-Regel oben, D9).

**Lockern.** Enthält der Body `requiresApproval: false`, steht direkt über dem Speichern-Knopf eine Zeile in `ink` mit dem offenen Schloss (am Knopf per `aria-describedby`): „Der Chat fragt dann nicht mehr nach, bevor er „{Tool}“ ausführt.“ Einen zusätzlichen Dialog gibt es nicht. Gespeichert und angewendet wird wie bei jeder Entscheidung (unten); das Anwenden gibt die Sicherheitsfreigabe selbst und protokolliert sie (Abschnitt 4, Rollen). Danach trägt das Tool das Badge „Gelockert“, die Meta-Zeile im Drawer sagt „Fragt nicht vorher (von dir gelockert)“, und unter dem Feld steht „Auf den Code-Wert zurück“ (`requiresApproval: null`, verschärft wieder). Die Historie nennt die Lockerung ab D7 (4.4).

**Gespeicherte Lockerung (bis D16).** Zeigt ein Tool `relaxationPending` (eine gespeicherte Lockerung der Rückfrage, die die Runtime vor D16 nicht übernimmt), steht unter „Vorher nachfragen“: „Eine gespeicherte Lockerung wartet auf den Code. Das Tool fragt bis dahin weiter.“ und der Link „Gespeicherte Lockerung verwerfen“. Das verschärft und braucht keine Sicherheitsfreigabe. Mit D16 meldet `capabilities` eine gültige Lockerung als wirksam, `relaxationPending` ist dann `false`.

**Einschränkung aufheben.** Das ist eine gesonderte Aktion pro Feld mit `origin = platform`: „Auf den Code-Wert zurück“ sendet `feld: null`. Sie steht nicht zwischen den Verschärfungen, sondern als Link unter dem Feld, mit dem Hinweis „Lockert: braucht beim Anwenden eine Sicherheitsfreigabe.“ (bei einer gelockerten Rückfrage stattdessen „Das Tool fragt danach wieder vorher.“). Eine Wahl unterhalb des Code-Werts bietet das Formular nur beim Abschalten der Rückfrage an.

**Speichern** heißt „Speichern und in {Umgebung} anwenden“:
1. `PATCH /v2/apps/:appId/runtime-setup/runs/:runId/tools/:toolId` mit dem Body. `runId` ist `cap.codeVersion.runId`; ohne Code-Bericht ist das Formular deaktiviert mit „Noch kein Code-Bericht“.
2. Die Antwort `{ …setup, policyRevision: { configurationRevisionId, created } | null }` liefert die Revision.
3. Ist `policyRevision` gesetzt und hat die Rolle das Anwenden-Recht (Abschnitt 4), ruft die UI direkt `POST …/configurations/:id/apply` für die gewählte Umgebung auf und zeigt den Zwischenzustand im Drawer: „Gespeichert. Wartet auf den Runner…“; danach weiter wie in 4.1.4 (Fortsetzen bei Gesundheit). Ohne Anwenden-Recht heißt der Knopf nur „Speichern“, und der Drawer sagt danach „Gespeichert. Anwenden dürfen Owner und Admins.“ Zeigte vor dem Speichern außer diesem Tool ein weiteres Tool der gewählten Umgebung `decisionPending` (eine fremde Entscheidung oder Regeln, die seit einem Rollback ruhen), wendet der Drawer nicht direkt an: Der Knopf heißt „Speichern“, und danach öffnet sich der Anwenden-Dialog (4.1.6) mit allen Änderungen, weil das Anwenden alle gespeicherten Entscheidungen signiert (Abschnitt 4, Rollen).
4. Ist `policyRevision = null` (noch nichts veröffentlicht): „Gespeichert. Wirkt, sobald die erste Version angewendet ist.“ Die Übersicht bietet dann `action = apply` an (Kandidat `ready`, `pendingChange = unpublished-decisions`).
5. Bei Pro bleiben weitere Umgebungen mit `decisionPending`; die Übersicht bietet dort „Anwenden“ an (D3, 4.1.6).

| Fehler | UI |
| --- | --- |
| 422 `{ code: 'tool_override_out_of_bounds', field, reason }` (`cannot-enable-disabled-tool`, `risk-class-lowered`, `risk-class-relabelled`, `tier-3-always-requires-approval`, `relaxation-requires-reviewed-pin`) | Kann nur bei einem Wettlauf mit einem neuen Code-Bericht auftreten (`relaxation-requires-reviewed-pin` gar nicht, weil die API beim Entscheiden der Rückfrage immer neu pinnt). Klartext am Feld, z. B. „Der Code meldet dieses Tool inzwischen mit höherem Risiko. Wir haben neu geladen.“, bei einer Lockerung mit `tier-3-always-requires-approval`: „„{Tool}“ ist inzwischen als „{Wort aus 3.8}“ gemeldet und fragt immer. Wir haben neu geladen.“; `capabilities` werden neu geladen |
| 404 „Neither the setup run nor any environment reports that tool“ | „Dieses Tool meldet die App nicht mehr.“ |
| 403 „Editor role required“ (`PATCH`) | flacher Knopf „Ändern dürfen Owner und Admins.“ |
| 403 beim anschließenden Anwenden | Die Entscheidung ist gespeichert; Drawer „Gespeichert. Anwenden dürfen Owner und Admins.“, Badge „Wartet aufs Anwenden“ |

Weitere Aktionen: „Verwerfen“ setzt den Entwurf zurück, der Fokus geht auf den Titel. Ein Entwurf geht beim Schließen ohne Rückfrage verloren, wenn er leer ist; sonst fragt der Drawer „Änderungen verwerfen?“.

Dieses Formular ersetzt `components/runtime-setup/tool-override-form.tsx` für den Foundation-Pfad. Das alte Formular sendet immer `riskClass`, `requiresApproval` und `enabled`, also auch No-op-Felder (Roadmap-Zeile „boundToolOverride speichert … No-op-Felder“).

#### 4.2.5 Zustände, Free und Pro

| Zustand | Darstellung |
| --- | --- |
| Laden | Band-Skeleton, 8 Zeilen-Skeleton |
| Leer (`tools = []`, Bericht vorhanden) | „Deine App meldet noch keine Tools.“ plus `glirastes tools refresh` |
| Code-Stand nicht gemeldet | „Sobald deine App mit Glirastes ab Version 0.5 startet, steht hier, was der Chat kann.“; die Platte ist off |
| Kein Filtertreffer | „Kein Tool passt dazu.“ plus „Filter zurücksetzen“ |
| Fehler | Band „Platform nicht erreichbar“ |

Free und Pro unterscheiden sich nur in der Umgebung: Pro wählt sie im Schalter, die Zahlen gelten pro Umgebung.

### 4.3 Kosten & Nutzung (`/manage/usage`)

Quelle ist `GET /v2/apps/:appId/metrics` (P09) mit `environmentId`, `revisionId`, `model`, `from`, `to`, `granularity`. Die Antwort heißt `RuntimeMetricsOverview { range { from, to, granularity }, retention { days, availableFrom }, totals, series[], tools[] }`. Zeiträume bis 48 h kommen stündlich, längere als UTC-Tage; 12 Monate holt die Seite tageweise und summiert im Client zu UTC-Monaten. Vergleiche nutzt nur Pro: `GET /v2/apps/:appId/metrics/compare?by=environment|revision|model|tool` → `rows[]` (für `tool`: `{ key, calls, errors }`, sonst `RuntimeMetricsView & { key }`).

| Abschnitt | Inhalt und Felder |
| --- | --- |
| Kopf | Kicker aus der Kosten-Antwort, H1 „Was kostet es?“, Lede „Was der Chat in {App} kostet: was der Anbieter gemeldet hat und was wir aus Tokens und Preisliste schätzen.“ |
| Werkzeugleiste | Zeitraum-Segmente: Dieser Monat (Standard) · 7 Tage · 30 Tage · bei Pro 12 Monate. Frühere Zeiträume als `retention.availableFrom` sind deaktiviert mit Grund („Free hält 30 Tage“). Ghost-Chips: **Version** (Werte aus `dep`, Filter `revisionId = agentRevisionId`, beide Pläne), **Modell** (nur Pro, Werte aus `compare?by=model`; Free hat keine Quelle für die Modellliste), **Umgebung** (nur Pro, zusätzlich „Alle Umgebungen“ = ohne `environmentId`). |
| KPI-Band 4/3/2/3 (wie im Prototyp) | **Kosten (4):** Summe `cost.knownUsd`, darunter die Herkunft „{providerReportedUsd} laut Anbieter · {priceTableUsd} geschätzt“; ist ein Teil unbekannt, steht „mind.“ davor und „{unknownCostTurns} Anfragen ohne Kostenangabe“ darunter; ist alles unbekannt: „–“ mit Fußnote, nie 0. **Hochrechnung (3):** „≈ {proj}“ für den Monat (gepunkteter blauer Schlüssel), darunter die Methode in Kurzform; ohne 7 vollständige Tage „–“ mit „ab 7 Tagen Daten“. **Anfragen (2):** `turns`, darunter „{input + output} Tokens“. **Fehlerquote (3):** ofN(`errorTurns`, `turns`), darunter „p95 je Stunde ≤ {p95TotalMs} s“ (`latency.p95TotalMs` ist das höchste stündliche p95); im Fehlerzustand stattdessen die rote Zeile „seit {hh:mm}: {e} von {n} …“ aus 4.1.3 |
| Kosten im Verlauf (7) | Satz „Werktags zuletzt Ø {x} am Tag, am Wochenende Ø {y}.“ aus den letzten 7 vollständigen UTC-Tagen (nur wenn beide Mengen Tage haben). Tagesbalken aus `series[]`: durchgezogen = `providerReportedUsd` („laut Anbieter“), schraffiert = `priceTableUsd` („geschätzt, Preisliste“). Ein Tag mit `unknownCostTurns > 0` bekommt einen hohlen Platzhalter mit „–“ über dem bekannten Anteil. Achsen in Mono; Versionsmarker aus `deployments.activatedAt`. Tooltip pro Tag: Datum, Kosten nach Herkunft, Anfragen. Tabellenansicht per Umschalter (shadcn `Table`) mit denselben Werten. |
| Monat, aufsummiert (5) | kumulierte Linie; Hochrechnung als gepunktete blaue Linie bis Monatsende. Methode als eine Zeile: „So rechnen wir hoch: Ø der letzten 7 vollständigen Tage × verbleibende Tage + bisher.“ Dafür fragt die Ansicht „Dieser Monat“ ab `min(Monatsanfang, heute − 7 Tage)` ab und zeigt nur den Monatsteil. Ist ein Teil unbekannt, steht „mindestens“ davor. |
| Aufgeteilt nach … | Free: Tools aus `tools[]` (Spalten Tool, Aufrufe, Fehler als ofN; Name nach 4.2.2), Satz „„{Tool}“ hat die meisten Aufrufe.“ Pro: Segmente Tool · Umgebung · Version (`revision`, Schlüssel = `agentRevisionId` → Version über `deployments`, D2) · Modell aus `compare`; Spalten Schlüssel, Anfragen, Tokens, Kosten, laut Anbieter, geschätzt; Satz „{Schlüssel} trägt {x} % der bekannten Kosten.“ `key = null` heißt „nicht gemeldet“. Fußnote „„–“ heißt: unbekannt, nicht null.“ 403 bei Free wird nie ausgelöst, weil Free den Aufruf nicht macht. |
| Budget-Hinweis | entfällt (kein Monatsbudget in der API, D10) |

| Zustand | Darstellung |
| --- | --- |
| Laden | Skeleton-Band und leere Achsen |
| Keine Anfragen | „Noch keine Anfragen in diesem Zeitraum.“, Achsen ohne Balken |
| Metrik-API fehlt (vor P09: 404) oder 5xx | „Noch keine Messwerte. Sie erscheinen, sobald deine App Glirastes 0.5 mit Metriken nutzt.“; bei 5xx das Platform-Band |
| Zeitraum gekürzt (`range.from` > angefragter Beginn) | Kopf und KPI sagen „seit {Datum}“ (Abschnitt 4) |
| Fehlerzustand der Übersicht | KPI „Fehlerquote“ mit roter Zeile, Versionsmarker der fehlerhaften Version rot; sonst unverändert |
| Verzögerung | Fußzeile „Stündlich zusammengefasst, abgerufen {hh:mm}; neue Anfragen erscheinen nach bis zu 10 Minuten. Tage und Monate in UTC.“ |

### 4.4 Historie & Rollback (`/manage/history`)

| Teil | Quelle und Darstellung |
| --- | --- |
| Kopf | Kicker (Zustand der Version), Mono-Frage, H1 „Historie & Rollback“, Lede „Jede angewendete Version und jeder Rückweg, die neueste oben.“ Die Prototyp-Zusage „in Sekunden“ entfällt (1.3). |
| Zeitstrahl | `GET /v1/apps/:appId/environments/:environmentId/deployments` → pro Eintrag `status`, `activatedAt`, `createdAt`, `healthStatus`, `rolledBackFromId`, `configRevisionId`, `agentRevisionId`, `rolloutMode`; neueste oben (`activatedAt`, sonst `createdAt`). Ganz oben steht bei `ov.action = apply` ein bereiter Eintrag (Amber-Linie, gestrichelter Amber-Zweig, Nummer per D2/D3, Primär „v{N+1} anwenden…“ wie 4.1.6). Pro Eintrag: Nummer (D2; vorher „Konfiguration vom {Datum}“ und Kurz-ID in Mono), Zeitraum („aktiv seit …“ bzw. „aktiv von … bis …“, Ende = `activatedAt` des nächstjüngeren Eintrags), Badge (Aktiv · Bereit · Wartet auf Gesundheit = `pending` · Ersetzt = `superseded` · Zurückgerollt = `rolled_back` oder von einem späteren Eintrag als `rolledBackFromId` genannt). Ein Eintrag mit `rolledBackFromId ≠ null` heißt „Zurück zu v{M}“ mit „von v{N}“. Gesundheitszeile: für die aktive Version dieselbe Aussage wie in der Übersicht (gleiche Funktion); für frühere Versionen nur bei Pro aus `compare?by=revision` („{x} von {n} Anfragen ohne Fehler“), bei Free keine. „Zu v{M} zurückkehren… →“ steht nur an Einträgen, die die Rückweg-Regel aus 4.1.2 erfüllen. „Technische Details“ (eingeklappt): Deployment-ID, `configRevisionId`, `agentRevisionId`, `runtimeDigest` kurz, `rolloutMode`. Mono-Zeiten links (auf dem Telefon über jedem Eintrag, als echter Text; die Desktop-Spalte ist dann `display: none`). |
| Schiene | eine ruhige Hyphe: 1,5 px in `ink-2` mit langer, flacher Welle (± 2 px über 420 px), die über ihre letzten 36 px zu einer Wurzelspitze unter dem ältesten Eintrag schmal wird; jeder Knoten hängt an einem Zweig, der die Schiene in einem 24-px-Bogen verlässt; der Zweig zur bereiten Version ist Amber und gestrichelt. Die aktive Version trägt eine `ink-3`-Linie, eine zurückgerollte die Pfeil-Glyphe. Gezeichnet per ResizeObserver wie `alignRoot`; `aria-hidden`. |
| Änderungsliste pro Version | entfällt bis D15 (kein Vergleich zweier Konfigurationen). |
| Eingriffe von Hand | `GET /v1/audit/events?type=runtime.app_setup.tool_override` (Payload `toolId`, `decidedFields`, `direction`), `runtime.deployment.rolled_back`, `runtime.revision.decision`, `runtime.revision.published`. Ohne App-Filter für Dashboard-Nutzer ist das heute tenantweit, deshalb D7. Bis dahin zeigt die Historie nur Deployments. Ab D7 nennt sie jede Lockerung als eigenen Eintrag: `tool_override` mit `direction = loosening` heißt „Gelockert: „{Tool}“ · {Felder}“ (`decidedFields` in Worten: Rückfrage, Risiko, Rollen, Ein/Aus; die Werte stehen nicht im Payload). Die Version, mit der eine Lockerung angewendet wurde, trägt „Sicherheitsfreigabe beim Anwenden, protokolliert“ (`runtime.revision.decision` mit `approvalKind = security`, `selfApproved = true`). Das Audit hält das immer fest; vor D7 nennen in Citadel nur der Anwenden-Dialog (4.1.6) und das Badge „Gelockert“ (4.2.2) die Lockerung. |
| Filter | Alles · Versionen · Änderungen von Hand (ab D7; vorher deaktiviert mit „Kommt mit dem Audit pro App.“) · Vorfälle (Einträge mit `healthStatus ∈ {degraded, unhealthy}` und die aktive Version, wenn die Übersicht für sie die Fehlerbedingung meldet) |
| „Wenn etwas schiefgeht“ (4/12) | Ziel = Rückweg-Kandidat (4.1.2). Label im Fehlerzustand „Letzte gesunde Version“ mit „v{M} lag in seiner Zeit unter 2 %.“, sonst „Rückweg, falls v{N} Probleme macht“ mit „v{N} läuft ohne Befund, du brauchst den Rückweg gerade nicht.“; ohne Kandidat „Es gibt keinen älteren gesunden Stand.“ Drei Schritte mit Mono-Zählern: 01 „Du siehst es hier zuerst. Rot wird es ab 2 % Fehlerquote bei mindestens 20 Aufrufen in 24 Stunden; die Werte sind bis zu 10 Minuten alt.“ 02 „Zurück mit einer Bestätigung. Der Chat nutzt die alte Version, sobald der Runner sie übernommen hat.“ 03 „Nichts geht verloren. v{N} bleibt gespeichert; Regeln, die du danach gespeichert hast, ruhen, bis du sie erneut anwendest.“ Im Fehlerzustand Primärknopf „Zu v{M} zurückkehren…“, sonst Pfeil-Link; ohne Recht flacher Knopf „Zurückgehen dürfen Owner und Admins.“ |

| Zustand | Darstellung |
| --- | --- |
| Leer | „Noch nichts angewendet.“ |
| Laden | Skeleton |
| Fehler | Platform-Band |

Free und Pro unterscheiden sich darin, dass Pro pro Umgebung wählt und für frühere Versionen eine Gesundheitszeile hat.

### 4.5 Verbinden (`/connect`, `/connect/pair`)

| Schritt | Quelle und Darstellung |
| --- | --- |
| 01 Befehl | Codeblock (Landing `.l-code-block`) mit `glirastes connect`; der Kopierknopf ist tastaturbedienbar |
| 02 Code bestätigen (`/connect/pair?user_code=`) | `GET /v1/runtime-connect/pairings/claim?userCode=` → `localAppId`, `localAppName`, `artifactDigest`, `status` (`pending`/`authorized`/`denied`/`consumed`/`expired`), `expiresAt`. Der Code steht in JetBrains Mono 40 px („KQ7M – 4TXP“), mit einem Countdown bis `expiresAt` in Mono; darunter „{localAppName}“ und `artifactDigest` kurz in Mono. |
| 03 Ziel wählen | Die API lässt nur die App zu, deren ID die CLI mitbringt (`select` verlangt `appId = localAppId`). Deshalb: **Gibt es `localAppId` in `GET /v1/apps`**, zeigt der Schritt nur diese App, und die Radio-Karten (Radius 12) sind ihre Umgebungen (`GET /v1/apps/:appId/environments`) plus „Neue Umgebung anlegen“ (Felder Schlüssel und Name; `POST /v1/apps/:appId/environments { key, name }`, Schlüssel `^[a-z0-9][a-z0-9-]{0,63}$`). Bestätigen = `POST …/authorize { userCode, action: 'select', appId, environmentId }`. **Sonst** gibt es eine Karte „Neue App „{localAppName}“ anlegen“: `POST …/authorize { userCode, action: 'create' }` → `{ adopted: true, appId }`; die Kopplung bleibt offen, die neue App hat noch keine Umgebung, also folgt das Anlegen einer Umgebung (Vorschlag `production` / „Production“) und dann `select`. Der Graft zeigt „Hier würde es anwachsen.“ in Instrument Serif. |
| Bestätigt (`authorized`) | „Bestätigt. Wartet auf den ersten Start der App.“ |
| Erfolg | H1 „Verbunden.“ / „Die Tools sind da.“, sobald `connected-overview` der gewählten Umgebung `connection = connected` meldet (Abfrage alle 2 s, solange die Seite offen ist) |
| Ablehnen | `POST …/deny { userCode }` → „Abgelehnt. Die CLI bricht ab.“, dazu die Karte „Warst du das nicht?“ mit dem Hinweis, den Schlüssel unter Einstellungen zu prüfen |
| Status `denied`, `expired`, `consumed` beim Öffnen | „Diese Anfrage ist schon abgelehnt.“ · „Code abgelaufen.“ · „Dieser Code wurde schon benutzt.“, jeweils mit Schritt 01 |
| Erweitert | Env-Block (`GLIRASTES_APP_ID`, Schlüssel aus Einstellungen) unter „Erweitert“, wie Spec 7 |

| Fehlercode | UI |
| --- | --- |
| `pairing_unavailable` | „Code abgelaufen oder schon benutzt.“ |
| `pairing_owner_required` | flacher Knopf mit „Geräte verbinden dürfen Owner und Admins.“ (`pairingApprover` erlaubt `owner` und `admin`) |
| `pairing_dashboard_session_required` | „Bitte melde dich im Dashboard an.“ |
| `pairing_rate_limited`, `pairing_rate_limit_unavailable` | „Zu viele Versuche. Bitte warte einen Moment.“ |
| `invalid_pairing_request` | „Dieser Code hat nicht das richtige Format.“ |
| `pairing_app_identity_mismatch`, `pairing_environment_mismatch` | Klartext und neu wählen |
| `connected_free_limit_reached` (`resource: app \| environment`) | „Free erlaubt eine App und eine Umgebung.“ plus Pro-Hinweis (ein Satz, ein Link) |
| 403 „A verified owner or admin is required to create environments“ | flacher Knopf „Umgebungen anlegen dürfen Owner und Admins.“ |

Die bestehenden Meldungen aus `lib/runtime-pairing-feedback.ts` werden in diese Texte überführt.

### 4.6 Einstellungen und Team (minimal)

Diese Seiten werden nur neu eingekleidet. Neue Funktionen gibt es nicht; ihre Texte stehen wie alle anderen in beiden Katalogen (2.4).

| Route | Inhalt | Quelle |
| --- | --- | --- |
| `/settings` | Seitenkopf, Abschnitt „Arbeitsbereich“ (Slug ändern), Plan-Zeile (lesend) | `GET/PATCH /v1/tenant`. Der Abschnitt Optimizer (`/v1/optimization/*`) wird im Foundation-Profil ausgeblendet. |
| `/settings/apps` | Apps und Umgebungen | `GET /v1/apps`, `DELETE /v1/apps/:appId` (AlertDialog auf „Abbrechen“) |
| `/settings/api-keys` | Schlüssel | `GET/POST /v1/tenant/api-keys` |
| `/settings/team` | Mitglieder, Einladungen, Rollen | `GET /v1/tenant/team`, `POST …/invite`, `PATCH`/`DELETE /v1/tenant/team/:id` |

Alle vier Seiten nutzen Seitenkopf (Eyebrow, H1 52, Lede), `LedgerSection`, Knöpfe nach `.l-btn` und die Tabellen-Typografie aus Abschnitt 3; in der Seitenleiste haben sie keine Platten-Grafik.

---

## 5. Komponentenarchitektur

### 5.1 Grundsätze

- **Der Netz-Renderer ist eine isolierte Client-Komponente.** Sie holt keine Daten, kennt keinen API-Typ und bekommt ein serialisierbares `NetworkModel`. Sie rendert SVG, kein Canvas. Gründe:
  - die Geometrie ist klein (5 Hyphen, 10 Zweige, Textur)
  - SVG ist auf jeder Pixeldichte scharf
  - Tokens wirken direkt als CSS-Variablen
  - Forced Colors funktioniert ohne Sonderpfad
  - Labels und Reveal-Masken bleiben deklarativ

  Keine Bibliotheken, kein WebGL. Die Geometrie (`sCurve`, Verjüngung, `extendCurve`, `rootCurve`, Band, Platte) besteht aus reinen, deterministischen Funktionen, die auf Server und Client identisch rechnen. Das SVG wird statisch per SSR ausgeliefert; Animationen hängen erst nach der Hydration an (`data-animate`).
- **Ein View-Model pro Bildschirm.** Es ist eine reine Funktion von API-Antworten auf Darstellungsmodelle; die Komponenten rechnen nicht selbst. Darauf zielen die Unit-Tests (Abschnitt 7).
- **Kein Text im Markup.** Texte kommen ausschließlich aus dem Katalog der gewählten Sprache (`useCopy()` im Client, `getCopy(locale)` auf dem Server, 2.4); View-Models liefern `CopyRef`s. ESLint `react/jsx-no-literals` gilt für `components/citadel`, `components/living-network`, `components/shell`, `components/tools` und `app/(dashboard)/**`, `app/(auth)/**`, mit `allowedStrings` nur für Glyphen und Satzzeichen.
- **shadcn/Base UI wiederverwenden statt forken.** Die Aliase aus 3.2 machen stock-Komponenten markenkonform. Abweichungen leben als Varianten in den vorhandenen `components/ui/*`-Dateien.

### 5.2 Wiederverwendete und neue Primitive

| Zweck | Primitive |
| --- | --- |
| Knöpfe | `ui/button.tsx` (Base UI). Varianten werden auf `.l-btn` umgestellt: `default` = Amber mit `--btn-primary-shadow`, Hover heller/−1 px; `outline` = `.l-btn-secondary`; `link` + Pfeil = `.go`; `destructive` = `err-fill`/`on-err`; deaktiviert = flaches `surface-3`. Ein Fokusring für alle: `outline: 2px solid var(--ring); outline-offset: 2px` statt `ring-3 ring-ring/50`. |
| Drawer | `ui/sheet.tsx` (Base UI); Overlay `[data-slot$="overlay"] { background: var(--scrim); backdrop-filter: blur(3px) }` |
| Riskante Bestätigung | neu `ui/alert-dialog.tsx` (Base UI `AlertDialog`, `bunx --bun shadcn@latest add alert-dialog`, Stil `base-nova`), öffnet auf „Abbrechen“ |
| Dialog, Palette | `ui/dialog.tsx` (Radius 20), `ui/command.tsx` (cmdk) in `components/command-palette.tsx` |
| Segmente | neu `ui/toggle-group.tsx` (Base UI `ToggleGroup`, stabile Keys) |
| Formular | `ui/switch.tsx`; neu `ui/checkbox.tsx`, `ui/radio-group.tsx` |
| Seitenleiste | neu `ui/sidebar.tsx` (shadcn `Sidebar collapsible="offcanvas"`). Geschlossen = `inert` + `visibility: hidden` (README-Patch 11). Aktiver Eintrag = `--sidebar-accent`, Zustand als `SidebarMenuBadge` |
| Sonst | `ui/tooltip.tsx`, `ui/popover.tsx`, `ui/table.tsx`, `ui/badge.tsx` (Variante `status` mit Glyphe, Variante `pill` = `.l-tag`), `ui/skeleton.tsx`, `ui/sonner.tsx` (Toast als gehobene Karte), `ui/input.tsx`, `ui/separator.tsx` |
| Landing-Bausteine | `landing/brand.tsx` (`LogoMark`, `Wordmark`), `landing/mycelium-phrase.tsx` (`tone="primary"` liest Tokens, 3.3) |
| Kopfleiste | neu `ui/breadcrumb.tsx` (shadcn `Breadcrumb`), Suche als `Button variant="ghost"` mit ⌘K-Hinweis, Theme-Schalter und Menü-Knopf als `Button size="icon"` |
| Regeln für Stock-Komponenten (README-Patches 1–13) | Rot als Fläche nur als Paar `bg-destructive text-destructive-foreground`; roter Text nur `text-err`, nie `text-destructive`. Seitenabschnitte sind `LedgerSection` (`<section>` mit Linie oben), nie `Card`; `Card` nur für Diagnose, Drawer, Dialoge, Palette, Toast und Code. Das Morgenlicht (`--ambient`) und das Punktraster (`--dots`, 1 px alle 32 px, nach oben maskiert) liegen fix als `::before`/`::after` der App-Shell mit `z-index: -1`, wie `.landing::before/::after`; die Seitenleiste ist auf dem Desktop transparent, damit das Licht durchreicht. |

### 5.3 Dateilayout (`apps/citadel`)

```
scripts/build-tokens.mjs                  tokens.mjs → src/app/tokens.css (+ --check)
src/design/tokens.mjs                     einzige Quelle der Tokens (aus dem Prototyp)
src/app/tokens.css                        generiert, eingecheckt
src/app/globals.css                       @import tokens.css; @theme inline; Varianten dark/light; Basis-Overrides
src/app/layout.tsx                        entfällt; jede Gruppe hat ihr Root-Layout (2.4)
src/app/global-not-found.tsx              404 ohne gemeinsames Root-Layout (2.4)
src/app/fonts.ts                          Geist, JetBrains Mono, Instrument Serif (next/font), von allen Root-Layouts genutzt
src/app/(dashboard)/layout.tsx, (auth)/layout.tsx   Root-Layouts: <html lang={locale}>, Fonts, ThemeProvider, CopyProvider
src/app/(marketing)/layout.tsx            Root-Layout: <html lang="en">, Fonts, Wrapper data-theme="dark"
src/components/landing/landing.css        liest geteilte Tokens statt eigener Literale
src/app/(dashboard)/manage/page.tsx       Übersicht
src/app/(dashboard)/manage/tools/page.tsx
src/app/(dashboard)/manage/usage/page.tsx
src/app/(dashboard)/manage/history/page.tsx
src/app/(dashboard)/connect/page.tsx, connect/pair/page.tsx
src/components/living-network/
  mycelium-network.tsx    'use client'; variant hero|band; Props: NetworkModel, moment?, switching?
  geometry.ts             reine Geometrie (Tests), Konstanten aus c-net.js
  comets.tsx              Kometen + Zeichen (SMIL), pausierbar
  network-labels.tsx      HTML-Labels (aria-hidden)
  hypha-plate.tsx, graft.tsx, root-knot.tsx
  use-fit-hero.ts, use-align-root.ts, use-animation-gate.ts   (Reduced Motion, Sichtbarkeit, Sitzung)
  network.css             auf die Komponente beschränkte Klassen
src/components/citadel/
  eyebrow.tsx, status-glyph.tsx, status-badge.tsx, faden.tsx, page-head.tsx, ledger-section.tsx,
  kpi-band.tsx, go-link.tsx, diagnosis-card.tsx, in-between-status.tsx, code-block.tsx (ersetzt components/code-block.tsx)
  charts/cost-chart.tsx, charts/cumulative-chart.tsx, charts/risk-bar.tsx, charts/usage-summary.tsx
src/components/shell/
  citadel-sidebar.tsx, app-env-switcher.tsx, top-bar.tsx, theme-toggle.tsx, shortcuts.tsx,
  user-menu.tsx (Sprache, Abmelden), copy-provider.tsx ('use client'; Katalog der gewählten Sprache)
src/components/tools/
  tools-table.tsx, tool-drawer.tsx, rules-form.tsx, apply-dialog.tsx, rollback-dialog.tsx
src/lib/clients/capabilities-client.ts, metrics-client.ts   (zod), bestehende Clients erweitert
src/lib/view-models/overview.ts, capabilities.ts, override-draft.ts, costs.ts, history.ts, connect.ts
src/lib/format.ts                          Intl nach Locale (de-DE | en-US), NBSP, USD, relative Zeit, ofN()
src/lib/copy.de.ts                         alle UI-Texte Deutsch (Referenz; Typ Copy)
src/lib/copy.en.ts                         alle UI-Texte Englisch (satisfies Copy)
src/lib/i18n/locale.ts                     Locale = 'de' | 'en', resolveLocale(cookie, acceptLanguage), Cookie citadel-locale
src/lib/i18n/t.ts                          t(): Platzhalter, Plural über Intl.PluralRules, CopyRef
e2e/                                       Playwright (Abschnitt 7)
```

`components/sidebar.tsx`, `app-management/connected-overview.tsx` und `runtime-setup/tool-override-form.tsx` bleiben für das Profil `full` und dessen Expertenrouten bestehen. Das Foundation-Profil nutzt die neuen Komponenten. In `lib/product-profile.ts` enthält `FOUNDATION_ROUTE_PREFIXES` danach nur `/manage`; die Expertenpräfixe entfallen (2.2).

---

## 6. Barrierefreiheit und Performance

### 6.1 Barrierefreiheit (WCAG 2.2 AA, beide Themes)

- **Kontrast:**
  - Text ≥ 4,5:1 und Markierungen ≥ 3:1, berechnet aus den Tokens. Die niedrigsten Paare laut `contrast2.mjs`: dunkel `on-err`/`err-fill` 5,3, `ink-3` auf `surface-3` 5,1; hell `amber-ink` auf `amber-tint` 4,8.
  - `ink-4` ist nie Text.
  - Dekorativ (ohne Kontrastanspruch, aber nie alleiniger Träger eines Zustands): Glühen, Bloom, Halos, Feld, Morgenlicht, Punktraster, Kometen und ihre Zeichen, Eyebrow-Strich.
- **Struktur:**
  - Skip-Link (Amber; der nächste Tab landet auf der Primäraktion), Landmarken.
  - Genau eine H1 pro Bildschirm, nach jedem Routenwechsel fokussiert; `document.title` = „{Seite} | {App} | Glirastes Citadel“.
  - Abschnitte sind über ihr Eyebrow benannt; Toolgruppen und Historieneinträge sind Überschriften.
  - Netz, Labels und Platten sind `aria-hidden`; der Faden und der Kicker tragen dieselbe Information als Text.
- **Tastatur:**
  - ⌘K/Ctrl K öffnet die Palette, `G` gefolgt von `O/T/K/H/V` navigiert, `U` wendet an, `/` springt in die Suche, `?` zeigt alle Kürzel, ⌘Z macht rückgängig, solange der Toast steht.
  - Einzeltasten-Kürzel sind abschaltbar (WCAG 2.1.4, `localStorage` `citadel-single-keys` in try/catch) und über `aria-keyshortcuts` ausgewiesen. Die Kürzel sind in beiden Sprachen gleich (2.4).
  - Filter verlieren den Fokus beim Neu-Rendern nicht.
  - Tab bleibt im obersten Dialog; Esc gibt den Fokus an den Öffner zurück.
  - Die Off-canvas-Seitenleiste ist geschlossen `inert` und `visibility: hidden`; geöffnet ist `main` `inert`, der Fokus liegt auf dem aktuellen Eintrag, Esc oder ein Klick auf den Scrim schließen und geben den Fokus an den Menü-Knopf zurück.
- **Fokus:** ein Ring für alles, 2 px `--focus` mit 2 px Abstand (fast weiß im Dunkel-, fast schwarz im Hell-Theme).
- **Namen:**
  - Dialoge mit `aria-labelledby` und `aria-describedby`.
  - Zeilenaktionen „Prüfen: {Tool}“.
  - Sidebar-Badges mit Wörtern („…, 5 prüfen“, „…, 1 Fehler, dazu 5 prüfen“, „…, unbekannt: App meldet sich nicht“).
  - Dekorative `<kbd>`-Hinweise sind `aria-hidden`; riskante Bestätigungen sind `alertdialog`.
  - Diagramme mit `aria-label`-Zusammenfassung; das Kosten-Diagramm zusätzlich mit Tabellenansicht.
  - Der Zwischenzustand hat `role=status`, der Toast-Bereich ebenfalls; die Suche kündigt „n Treffer“ an.
- **Forced Colors:**
  - Netz, Motive, Faden, Knoten und Versionsspur werden `CanvasText` bei gleicher Geometrie.
  - Glühen, Bloom, Halos, Feld, Morgenlicht und Raster fallen weg; der Kern wird eine Scheibe.
  - Die Amber-Phrase wird zur Wellenunterstreichung, Risiko-Pips behalten Höhe und Anzahl, die aktive Seitenleistenzeile wird umrandet.
- **Telefon:**
  - 44 × 44 px Ziele.
  - Alle fünf Antworten samt Rückweg im ersten Viewport bei 768×1024, 390×844, 390×664, 360×640 und 320×568 in allen Zuständen.
  - KPI-Bänder 2 × 2; kein horizontales Scrollen von 320 bis 1440 px.
- **Sprache:**
  - Die Landingpage ist englisch (`metadata.openGraph.locale = en_US`) und hat ein eigenes Root-Layout mit `<html lang="en">`.
  - Die Root-Layouts von `(dashboard)` und `(auth)` setzen `<html lang>` auf die gewählte Sprache (`de` | `en`, 2.4); beim Umschalten setzt der Client `document.documentElement.lang` sofort, ohne auf das Neurendern zu warten.
  - Im Sprachmenü trägt jede Option ihren Namen in der eigenen Sprache und das passende `lang` („Deutsch“ mit `lang="de"`, „English“ mit `lang="en"`); die gewählte ist `aria-checked`.
  - Codeblöcke, IDs und Befehle tragen `translate="no"`.
  - Axe läuft in beiden Sprachen (Abschnitt 7). Versalien kommen aus CSS (`text-transform`), damit Screenreader normale Wörter lesen.

### 6.2 Performance-Budgets

Gemessen mit Playwright gegen `next build && next start`, API gemockt, System-Chrome mit CPU-Drosselung 4×:

| Budget | Wert |
| --- | --- |
| LCP `/manage` (390×844, 4× CPU, „Fast 3G“-Profil) | ≤ 2,5 s |
| CLS jeder `/manage/*`-Route | ≤ 0,02 (H1-Platz reserviert, Fonts mit `size-adjust` von `next/font`) |
| Lange Tasks nach dem Einzeichnen | keine > 50 ms durch das Netz; Einzeichnen insgesamt ≤ 1 Task > 50 ms |
| JS des Netz-Moduls (`living-network/*`) | ≤ 20 KB gzip, keine neue Laufzeitabhängigkeit |
| JS der eigenen Charts | ≤ 12 KB gzip, keine Chart-Bibliothek |
| Zusätzliches CSS (Tokens + Citadel-Komponenten + `network.css`) | ≤ 30 KB gzip |
| Animation | nur `transform`, `opacity`, `stroke-dashoffset`, SMIL `startOffset`; keine JS-rAF-Schleife; Filter nur pro Farbgruppe (≤ 4 `drop-shadow`-Gruppen + 1 Blur-Gruppe) |
| Bildrate | ≥ 55 fps im Hero bei 1440 (Apple M1), ≥ 50 fps im Band auf einem simulierten Mittelklasse-Telefon; die Kometen pausieren außerhalb des Bildes |
| Anfragen pro Übersicht | 5 parallel beim Laden, danach höchstens 2 abhängige Metrik-Abfragen (2.3), einmal pro Sitzung `tenant`, `apps`, `team`; Polling 15 s nur bei sichtbarer Seite, im Zwischenzustand 2 s |
| Fonts | Geist vorgeladen; JetBrains Mono 400/500; Instrument Serif nicht vorgeladen |
| Sprachkatalog | nur der Katalog der gewählten Sprache geht an den Client, ≤ 10 KB gzip; keine i18n-Bibliothek; Umschalten per `router.refresh()` ohne vollen Seitenwechsel (2.4) |

---

## 7. Tests

| Ebene | Inhalt | Werkzeug |
| --- | --- | --- |
| Tokens | `build-tokens.mjs --check`: `tokens.css` entspricht `tokens.mjs`. Kontrast-Test: alle Text-Paare ≥ 4,5:1 und Markierungs-Paare ≥ 3:1 in beiden Themes; oklch → sRGB als Test-Helfer, keine Laufzeitabhängigkeit; Port von `contrast2.mjs`. Gleichheit Landing dunkel: jede Landing-Variable hat denselben berechneten Wert wie vor der Umstellung. Verschachteltes Theme: unter `<html data-theme="light">` hat der Landing-Wrapper für jeden Alias (`--fg`, `--card`, `--primary`, `--border`, `--background`) den Dunkel-Wert (3.1). | Vitest + Playwright |
| Geometrie | `geometry.ts`: Spitzenkoordinaten, Kontrollpunkte, Verjüngung, Band und Platte gegen die Prototyp-Werte (Goldene Pfade aus `c-net.js` als Fixture) | Vitest |
| View-Models | `overview.ts`: alle Szenarien aus 4.1.3 (ok, wartet, pending, error mit Ursache Version / unbekannt / nur `unhealthy`, stale Produktion / andere Umgebung, Zwischenzustand, `action = resume`, Nicht angewendet, Momente) und alle Sonderzustände aus 4.1.4; jede Zeile der Hero-Tabelle 4.1.8 und der Ledger-Tabelle 4.1.9 als Fixture; Regel „schwerster Zustand gewinnt“; Ursache einmal rot; stale behauptet keine Wirkung auf den Chat; `candidate.status = failed` ist kein Fehlerzustand; `runtimeHealth` des wartenden Deployments löst keinen Fehler der aktiven Version aus; Version ist nur Ursache, wenn v{M} gemessen unter der Schwelle lag; Produktion = höchste `promotionOrder`; Zählregel „1 Fehler +n prüfen“; Fähigkeit pro Risikomix inkl. `unknown`; „Ruhig seit“ und Lede aus derselben Funktion (8.2.3); Rückweg-Auswahl inkl. der beiden UI-Ausschlüsse (nach Rollback nie die fehlerhafte Version, nie gleiche Konfiguration wie aktiv); Rollback-Ruhe („Regeln ruhen“) statt „Wartet auf den Runner“. `capabilities.ts`: Gruppierung, Prüf-Menge, Badges, Risiko-Abbildung 3.8. `override-draft.ts`: Tabelle aller Felder × {`origin` = `code-default` / `local-policy` / `platform` / `null`} × {wirksamer Wert} × {Aktion} × {Rolle mit / ohne Anwenden-Recht} × {D16 ja/nein}, die genau den Body aus 4.2.4 erzeugt; leerer Body ⇒ keine Anfrage; nie `description`; `requiresApproval: false` genau dann, wenn das Lockern angeboten (Bedingungen a–e) und gewählt ist; nie bei Stufe 3 oder `unknown`, nie bei `local-policy` oder `origin = null`, nie mit angehobenem Risiko (gespeichert oder im selben Entwurf), nie ohne Anwenden-Recht, nie vor D16; nie eine andere Wahl unter dem wirksamen Wert als „Auf den Code-Wert zurück“ und das Abschalten der Rückfrage; Rollen nur Teilmenge, mindestens eine; „Gespeicherte Lockerung verwerfen“ und „Auf den Code-Wert zurück“ an einer gelockerten Rückfrage ⇒ `requiresApproval: null`, nie `requiresApproval: true`; bei `origin.riskClass = platform` kein „Auf den Code-Wert zurück“ an der Rückfrage; bei mehreren gleichzeitig zutreffenden Gründen erscheint der erste aus 4.2.4. Anwenden-Dialog: {l} zählt nur sichere Lockerungen (4.1.6), „Zurück auf den Code-Wert“ an Stufe-≤-2-Tools mit Rückfrage zählt nicht. `costs.ts`: `null`/unbekannt nie 0, „mind.“ bei unbekanntem Anteil, UTC-Tage und -Monate, gekürzter Zeitraum ⇒ „seit {Datum}“, Hochrechnung nur mit 7 vollständigen Tagen, Provenienz-Aufteilung, „0“ vs. „–“ für Tools außerhalb der Top 20. `history.ts`: Badges, Rückweg-Links, Vorfälle aus der Übersichtsfunktion. `connect.ts`: `localAppId` vorhanden/fehlt, alle Fehlercodes und Status → Texte. Rollen-Tabelle aus Abschnitt 4 → aktive bzw. flache Knöpfe. | Vitest |
| Formatierer | `format.ts` in `de-DE` und `en-US`: NBSP, USD („15,18 $“ / „$15.18“), Prozent, Datum („3. Okt.“ / „Oct 3“), Uhrzeit („um 14:21“ / „at 2:21 PM“), relative Zeiten an den Grenzen (59 s, 60 s, 59 Min.), `ofN(3, 31)` = „3 von 31 Aufrufen = 9,7 %“ / „3 of 31 calls = 9.7%“ | Vitest |
| Sprache | Kataloge: Schlüsselgleichheit zur Compile-Zeit (`satisfies Copy`, `tsc --noEmit` im Gate) und zur Laufzeit (gleiche Schlüsselpfade, gleiche Platzhaltermenge je Eintrag, Pluralobjekte mit `one` und `other`, kein leerer Wert). `resolveLocale`: gültiges Cookie gewinnt; ohne Cookie `de`, `de-DE`, `de-AT` und `en;q=0.8, de;q=0.9` ⇒ `de`; `en-GB`, `fr-FR`, `de;q=0.5, en`, fehlender oder ungültiger Header ⇒ `en`; Cookie `fr` wird ignoriert. `t()`: Platzhalter, Plural über `Intl.PluralRules`, fehlender Wert wirft im Test. ESLint `react/jsx-no-literals` grün (5.1). Playwright: Kontext `locale: 'de-DE'` ⇒ Deutsch, `'en-GB'` und `'fr-FR'` ⇒ Englisch; Umschalten im Nutzermenü ändert Texte und `<html lang>` ohne Seitenwechsel, Filter und offener Drawer bleiben, und die Wahl überlebt ein Neuladen; die Landing bleibt bei Cookie `de` auf `lang="en"`; in der englischen Übersicht und im englischen Drawer erscheint kein Wert aus `copy.de.ts` (Werte ab 12 Zeichen, die sich vom englischen Wert unterscheiden) | Vitest + Playwright |
| Navigation und Profil | `product-profile.ts`: im Foundation-Profil sind die Expertenrouten unsichtbar und `/manage`, `/manage/tools`, `/manage/usage`, `/manage/history` sichtbar, im Profil `full` ist alles sichtbar. Playwright: `/runtime-setup`, `/rollouts`, `/revisions`, `/approvals`, `/audit-stream` leiten im Foundation-Profil auf `/manage` um; Palette, Seitenleiste und Seiten enthalten keinen Link darauf | Vitest + Playwright |
| Komponenten | Faden, Sidebar-Badge (zugängliche Namen), Drawer-Fokus, Regeln-Formular (sendet exakt den erwarteten Body über einen Fake-Client; die Warnzeile „Der Chat fragt dann nicht mehr nach, …“ steht genau dann, wenn der Body `requiresApproval: false` enthält, und ist am Speichern-Knopf per `aria-describedby` verbunden; zeigt außer dem bearbeiteten Tool ein weiteres `decisionPending`, ruft das Speichern nur `PATCH` auf und öffnet danach den Anwenden-Dialog statt direkt anzuwenden). Zwischenzustand: nach `awaiting_health` ruft der auslösende Tab dasselbe Anwenden genau einmal erneut auf, sobald das wartende Deployment `healthy` meldet, und nie bei `degraded`/`unhealthy`; ein fremder Tab (`action = resume`) ruft nie selbst auf. Rückgängig ruft `rollback` mit der beim Öffnen gemerkten Deployment-ID auf. | Vitest + Testing-Setup wie `manage-page.test.tsx` |
| Screenshots | **Übersicht:** {ok, ok mit Prüf-Menge, wartet, pending, stale, stale andere Umgebung, error Ursache Version, error Ursache unbekannt, keine App, App ohne Lebenszeichen, Code nicht gemeldet, Metriken fehlen, Platform-Fehler, Laden, Zwischenzustand, Nicht angewendet, Moment angewendet, Moment zurück} × {dunkel, hell} × {1440×900, 768×1024, 390×844}. **Unterseiten:** {tools, tools mit Fehler, Drawer normal, Drawer eingeschränkt, Drawer Lockern mit Warnzeile, Drawer gelockert, Drawer Lockern flach (ohne Anwenden-Recht), Drawer Fehler-Tool, usage, usage teilweise unbekannt, history, connect, pair, pair erledigt, settings, team} × beide Themes × drei Breiten. **Dialoge:** anwenden, lockernd anwenden (mit „fragt nicht mehr vorher“), zurück, Palette (leer, mit Suchtext, mit grauem Eintrag), Kürzel-Dialog, Nutzermenü mit Sprachwahl. **Sprache:** die Matrix oben auf Deutsch; zusätzlich auf Englisch die Übersicht {ok, pending, wartet, error Ursache Version, error Ursache unbekannt, stale, Zwischenzustand, Nicht angewendet} × {dunkel, hell} × {1440×900, 768×1024, 390×844} und der Drawer {normal, Fehler-Tool, Lockern mit Warnzeile, gelockert} × {dunkel, hell} × {1440×900, 390×844}. **Pairing:** pending mit vorhandener App, pending ohne App (anlegen), bestätigt, abgelehnt, abgelaufen. **Sonderformen:** Reduced Motion (`reducedMotion: 'reduce'`) und Forced Colors (`forcedColors: 'active'`) für Übersicht/Fehler und Tools. **Landing:** Gleichheitsaufnahme glirastes.io-Route vor/nach. Animationen eingefroren (`animations: 'disabled'`, `data-still`), `document.fonts.ready` abgewartet, `maxDiffPixelRatio 0.002`. | `@playwright/test` mit `channel: 'chrome'` (neue devDependency in `apps/citadel`); API über `page.route('/v1/**', '/v2/**')` mit Fixture-Bauern, die gegen dieselben zod-Schemas validieren wie die Clients |
| Axe | jede Seite × Zustand × Theme mit `@axe-core/playwright`, Tags `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`; 0 Verstöße; auf Englisch mindestens die englischen Aufnahmen aus der Zeile Screenshots | Playwright |
| Kontrast gerendert | Port von `audit.mjs` (Quelle: `checks/` im Archiv, siehe Grundlage): Textkontrast aller sichtbaren Textknoten gegen den tatsächlichen Hintergrund, auch über dem warmen Feld; 0 Fehler | Playwright |
| Layout | Port von `tmp/fold.mjs` (Quelle wie oben) (fünfte Antwort samt Rückweg im ersten Viewport, Größen aus 6.1) und `tmp/ovf.mjs` (kein horizontales Scrollen bei 320/360/390/641/700/768/820/834/940/1024/1280/1440); `fitHero`: H1 genau zwei Zeilen, Amber-Phrase eine Zeile bei 1440×900, 1366×657, 1280×720, 1024×768. Für die Übersicht in beiden Sprachen, weil die englischen Sätze andere Längen haben | Playwright |
| Tastatur | Skip-Link → Primäraktion; `G T` → Tools; Drawer: Fokus auf Titel, Esc zurück zum Auslöser; Palette; Einzeltasten abschaltbar; Off-canvas `inert` | Playwright |
| Performance | Budgets aus 6.2 über `PerformanceObserver` (LCP, CLS, Longtask) und Bundle-Größen aus `.next/` | Playwright + Skript |
| Ende-zu-Ende | gegen den Get-It-Done-Piloten mit lokaler Wegwerf-Postgres (Freigabe ausstehend, Roadmap P11/P13): Tool einschränken → anwenden → Runner bestätigt → `decisionPending = false`; Rückfrage eines Stufe-2-Tools lockern → anwenden → der Chat führt es ohne Rückfrage aus (nach D16); Rollback; Pairing mit Ablehnung | Playwright, nach P11 |

### 7.1 Abnahmekriterien pro Bildschirm

Jedes Kriterium ist ein Test aus der Tabelle oben; ein Bildschirm ist abgenommen, wenn alle seine Kriterien in beiden Themes und, wo die Zeile Sprache oder ein Kriterium es nennt, in beiden Sprachen grün sind.

| Bildschirm | Kriterien |
| --- | --- |
| Übersicht | (1) Für jede Fixture aus 4.1.3/4.1.4 stimmen H1, Lede, Kurzzeile, Primär und Sekundär wörtlich mit 4.1.8 überein (Deutsch) bzw. mit den zugehörigen Einträgen in `copy.en.ts` (Englisch). (2) In jedem Zustand ist höchstens eine Ursache rot und höchstens eine Wirkung. (3) Die fünf Faden-Antworten und die Sidebar-Badges kommen aus demselben View-Model-Objekt (Test vergleicht die Texte). (4) Alle fünf Antworten samt Rückweg liegen im ersten Viewport bei den Größen aus 6.1. (5) Kein Text aus der Spalte „Entfällt“ (1.3, 4.1.9) erscheint. (6) Der auslösende Tab setzt ein wartendes Anwenden genau einmal fort; bei `unhealthy` erscheint „Nicht angewendet.“ (7) LCP ≤ 2,5 s und CLS ≤ 0,02 (6.2). |
| Was kann mein Chat? | (1) Zahlen im Band = Zählungen aus `capabilities` der gewählten Umgebung. (2) Jedes Badge aus 4.2.2 erscheint genau bei seiner Bedingung. (3) Für jedes Feld × Ausgangslage sendet „Speichern“ genau den Body aus 4.2.4, ein leerer Entwurf sendet nichts, `description` wird nie gesendet. (4) `requiresApproval: false` wird nur gesendet, wenn das Lockern nach 4.2.4 angeboten und gewählt ist (wirksame Stufe ≤ 2, Herkunft `code-default`, kein angehobenes Risiko, Rolle mit Anwenden-Recht, D16); bei Stufe 3 und `unknown` ist es nie wählbar. Eine andere Wahl unter dem wirksamen Wert ist nur als „Auf den Code-Wert zurück“ erreichbar. (5) Vor dem Speichern einer Lockerung steht die Zeile „Der Chat fragt dann nicht mehr nach, bevor er „{Tool}“ ausführt.“; es gibt keinen zusätzlichen Dialog. (6) Mit Speicher-, aber ohne Anwenden-Recht ist das Lockern flach mit „Lockern dürfen Owner und Admins.“; ohne Speicherrecht ist das ganze Formular flach mit „Ändern dürfen Owner und Admins.“; vor D16 steht „Im Code eingeschaltet. Ausschalten geht nur dort.“ für jede Rolle. (7) Nach dem Anwenden trägt das Tool das Badge „Gelockert“, und die Meta-Zeile sagt „Fragt nicht vorher (von dir gelockert)“. Wird eine gespeicherte Lockerung über den Anwenden-Dialog angewendet, nennt er sie mit „fragt nicht mehr vorher“ und dem Satz zur Sicherheitsfreigabe (4.1.6). (8) Zeigt außer dem bearbeiteten Tool ein weiteres Tool `decisionPending`, wendet „Speichern“ nicht direkt an, sondern öffnet den Anwenden-Dialog mit allen Änderungen. (9) 422/404/403 zeigen die Texte aus 4.2.4 und laden `capabilities` neu. (10) Drawer: Fokus auf dem Titel, Esc zurück zum Auslöser, `?tool=` öffnet direkt. (11) Auf Englisch: Drawer ohne deutschen Katalogtext, Axe 0 Verstöße. |
| Kosten & Nutzung | (1) Kein Betrag „0,00 $“ bzw. „$0.00“, wenn `unknownCostTurns = turns > 0`; „mind.“ bzw. der englische Katalogwert bei unbekanntem Anteil. (2) Tagesgrenzen sind UTC und die Fußzeile sagt es. (3) Bei gekürztem Zeitraum steht „seit {Datum}“. (4) Free ruft `compare` nie auf; Pro zeigt alle vier Aufteilungen. (5) Tabellenansicht enthält dieselben Werte wie das Diagramm. |
| Historie & Rollback | (1) Einträge in der Reihenfolge und mit den Badges aus 4.4. (2) „Zu v{M} zurückkehren…“ steht genau an den Einträgen, die die Rückweg-Regel erfüllen; nach einem Rollback nie an der fehlerhaften Version. (3) Der Rollback-Dialog öffnet auf „Abbrechen“ und nennt keine Zeitzusage. (4) „Änderungen von Hand“ ist vor D7 deaktiviert mit Grund. (5) Ab D7 steht jede Lockerung als „Gelockert: „{Tool}“ · {Felder}“, und die Version, mit der sie angewendet wurde, trägt den Vermerk der selbst gegebenen Sicherheitsfreigabe (4.4). |
| Verbinden | (1) Mit vorhandener `localAppId` ist nur diese App wählbar; ohne sie führt „anlegen“ über eine neue Umgebung zu `select`. (2) Jeder Fehlercode und Status aus 4.5 zeigt seinen Text. (3) „Verbunden.“ erscheint erst bei `connection = connected`. (4) Kopierknopf und Radio-Karten sind per Tastatur bedienbar. |
| Einstellungen, Team | (1) Neu eingekleidet ohne neue Funktion; der Optimizer-Abschnitt fehlt im Foundation-Profil. (2) Axe 0 Verstöße. |
| Landing | (1) Gleichheitsaufnahme dunkel vor/nach ohne Abweichung über `maxDiffPixelRatio`. (2) Bei `citadel-theme = light` bleibt die Landing dunkel (Alias-Test 3.1). (3) `<html lang="en">` auf der Landing, auch bei Cookie `citadel-locale = de`; im Dashboard `<html lang>` = gewählte Sprache. |
| Sprache (alle Bildschirme) | (1) `copy.de.ts` und `copy.en.ts` sind schlüsselgleich (Compile-Zeit und Test). (2) Ohne Cookie folgt die Sprache `Accept-Language` (`de*` ⇒ Deutsch, sonst Englisch). (3) Das Umschalten im Nutzermenü wirkt sofort, ohne Seitenwechsel, und überlebt ein Neuladen. (4) Zahlen, Datum, Uhrzeit und Beträge folgen der gewählten Sprache (`format.ts`). (5) Übersicht und Tools-Drawer auf Englisch: kein deutscher Katalogtext, H1 genau zwei Zeilen, fünf Antworten im ersten Viewport, Axe 0 Verstöße. (6) Die Kürzel sind in beiden Sprachen gleich. |
| Navigation und Profil | (1) Im Foundation-Profil sind die Expertenrouten nicht erreichbar (Umleitung auf `/manage`), weder in Seitenleiste noch Palette noch als Link. (2) Das Profil `full` behält alle Routen. (3) Eine unbekannte URL zeigt die 404 aus `global-not-found.tsx` mit gesetztem `<html lang>` (2.4). |

---

## 8. Nicht-Ziele, Entscheidungen und Abhängigkeiten

### 8.1 Nicht-Ziele

- Benachrichtigungen und Alarme („wir melden uns“), Beobachtungsfenster mit Versprechen.
- Monatsbudget und Budgetwarnung (D10).
- Währungsumrechnung (USD bleibt).
- Latenz pro Tool.
- Anzeige pro Instanz bzw. Server.
- Beschreibung oder Schema im Dashboard bearbeiten.
- Lockern im Dashboard über das Abschalten der Rückfrage bis Stufe 2 hinaus: kein Senken oder Umbenennen der Risikoklasse, kein Hinzufügen von Rollen, kein Einschalten eines im Code ausgeschalteten Tools, kein Lockern bei Stufe 3 oder `unknown` und keins gegen eine lokale Härtung (`tool-policy.json`). Das Abschalten der Rückfrage bis Stufe 2 bietet das Formular seit Version 1.2 an (Philipp, 2026-10-05; 4.2.4). Damit folgt diese Spec Spec 4.10.8 („Lockern nur bis Stufe 2 mit Hinweis auf Sicherheitsfreigabe“): Den Hinweis auf die Sicherheitsfreigabe geben der Anwenden-Dialog (4.1.6) und ab D7 die Historie (4.4); im Drawer, der direkt anwendet, steht nach Philipps „nicht zu kompliziert“ nur die einzeilige Warnung, protokolliert wird die Freigabe immer (Abschnitt 4, Rollen). Prinzip 11 des Prototyps („Restrict-only“) gilt für alles andere weiter. Die Roadmap-Zeile P08c („Override-Formular nur einschränkend und nur Abweichungen“) ist anzupassen: „… einschränkend plus Abschalten der Rückfrage bis Stufe 2 (nach D16), nur Abweichungen“ (siehe D16). Das Aufheben einer eigenen Platform-Einschränkung bleibt möglich (4.2.4).
- Ein eigener Freigabe-Ablauf für Lockerungen im UI (zweite Person, Anfrage an einen `security-approver`). Die Sicherheitsfreigabe gibt der Owner oder Admin mit dem Anwenden selbst; das Audit hält sie fest (Abschnitt 4, Rollen).
- Eine Speicherung der Sprachwahl am Nutzerkonto und weitere Sprachen als Deutsch und Englisch (2.4).
- Neugestaltung der Routen des Profils `full` und der Expertenrouten; sie übernehmen nur die Tokens.
- Managed Tool-Generierung (P10).
- Neugestaltung der Landingpage und ihrer Hero-Animation (P12; die Neufassung des Hero-Loops läuft als eigener Auftrag, siehe 8.5). P08c ändert an der Landingpage nur die Token-Quelle und die Schriftladung, ohne sichtbare Änderung (3.1, Gleichheitsaufnahme).

### 8.2 Restliste der Prüfung (eingearbeitet)

1. **Eyebrow-Strich nur an Abschnittsköpfen.** Der 20×1-px-Strich (`brow`) steht nur am ersten Label eines Abschnitts (LedgerSection, Seitenkopf-Frage, Drawer-Abschnitt). KPI-Labels, Tabellenköpfe, Unterlabels im Drawer und Palettengruppen tragen keinen Strich. `Eyebrow` hat dafür `rule` mit Standard `false`; `LedgerSection` und `PageHead` setzen `rule`.
2. **Glyphe ersetzt den Strich.** Steht vor einem Label eine Zustandsglyphe oder ein Legendenschlüssel („▲ Brauchen einen Blick“, gepunktetes Blau „Hochrechnung“), entfällt der Strich. Nie Strich und Glyphe zusammen.
3. **Lede und Faden sagen dasselbe.** Im ok-Zustand kommt die Ruhe-Aussage der Lede aus derselben Funktion wie die Faden-Antwort „Ruhig seit {d} Tagen“. Die Lede lautet „… und seit {d} Tagen gab es keinen Fehler.“ statt eines freien „ohne Probleme“. Sie nennt bewusst keine Version: „v{N} läuft seit {d} Tagen ohne Fehler“ wäre falsch, sobald v{N} jünger ist als der letzte Fehler. Ein Unit-Test sichert die Gleichheit.
4. **Keine Kometenzeichen an der Verbindungsknospe.** Die Verbindungshyphe läuft nach innen. Ihre Zeichenkette lag an der Knospe und überlagerte sie. Auf dieser Hyphe läuft nur der Komet, ohne Zeichen.

### 8.3 Entscheidungen (2026-10-05)

Offene Produktentscheidungen gibt es in dieser Spec keine mehr. Hell als abgeleitetes, nachrangiges Theme ist mit dem Prototyp freigegeben (1.2); die Beschriftung von `codeVersion` folgt der Roadmap und steht in 4.2.3.

**Philipp (verbindlich):**

| Punkt | Entscheidung | Umgesetzt in |
| --- | --- | --- |
| Lockern im Dashboard | „ich würde sagen dass man das kann. Machen wir es nicht zu kompliziert.“ Owner und Admins schalten im Drawer die Rückfrage eines Tools ab, dessen wirksame Risikoklasse höchstens Stufe 2 hat; Stufe 3 (`delete`, `external`, `financial`, `unknown`) nie (die API antwortet mit 422 `tier-3-always-requires-approval`, das Formular bietet es nicht an). Die Lockerung wird als Entscheidung gespeichert und mit dem normalen Anwenden ausgerollt, das die Sicherheitsfreigabe selbst gibt. Vor dem Speichern steht eine einzeilige Warnung; Historie und Audit nennen die Lockerung. Kein eigener Freigabe-Ablauf im UI. Voraussetzung: D16 | Abschnitt 4 (Rollen), 2.2, 3.8, 4.1.6, 4.1.8, 4.2.1–4.2.4, 4.4, 7, 7.1, 8.1, D16 |
| Fehlerregel | Bestätigt: rot ab 2 % bei mindestens 20 Aufrufen bzw. Anfragen im 24-h-Fenster, bei jüngerer Version seit Aktivierung | 4.1.3 |
| Sprache | „Beides zum MVP“: Deutsch und Englisch, typisierte Kataloge mit Schlüsselgleichheit zur Compile-Zeit, Umschalter im Nutzermenü, Standard aus `Accept-Language`, `<html lang>` folgt im Dashboard, Formate über `Intl`, beide Sprachen in der Playwright-Matrix | 2.1, 2.4, 3.1, 3.4, 4, 4.1.10, 4.6, 5.1, 5.3, 6.1, 6.2, 7, 7.1, 8.1 |
| Expertenrouten | Zum Release im Foundation-Profil ausgeblendet: nicht routbar, kein Palette-Eintrag, keine Links. Das gilt, bis P08d das Promote entscheidungserhaltend macht (D8) | 2.1, 2.2, 4.1.7, 4.1.10, 5.3, 7, 7.1 |

**Standardentscheidungen des Controllers (Veto möglich):**

| Punkt | Entscheidung | Umgesetzt in |
| --- | --- | --- |
| Versionen durch Regeln | Regel-Revisionen zählen fortlaufend weiter: Jede angewendete Entscheidung erzeugt eine neue Konfigurationsrevision und damit v{N+1} („nur Regeln, kein Code“), so wie die Datenbank zählt (`runtime_config_revisions.revision`, D2). Keine Unterversionen wie „v8.1“ | 1.3, 4.1.2, 4.1.6, 4.1.8, D2 |
| Landing-Hero und Citadel-Netz | Die Neufassung der Landing-Animation (8.5) bekommt einen eigenen Renderer-Pfad und nutzt nicht `components/living-network/`. Geteilt werden die Tokens, die Kometen-Mechanik (`stroke-dasharray` auf `pathLength=100`, SMIL `startOffset` für die Zeichen) und die Reduced-Motion-Regel. So bleibt der Look, den Philipp an der Landingpage mag, und beide sprechen dieselbe Bewegungssprache | 8.5 |

### 8.4 Abhängigkeiten (was die API noch nicht liefert)

| ID | Was fehlt | Wofür | Eigentümer | Ersatz bis dahin |
| --- | --- | --- | --- | --- |
| D1 | Lesezugriff Runner: `GET /v2/apps/:appId/environments/:environmentId/runners` → `runnerKey`, `version`, `status`, `lastSeenAt`, `lastAppliedDeploymentId` (Tabelle `runtime_runners`, eine Zeile pro Umgebung) | Verbindungs-Meta, Diagnose, Bestätigung des Zurückgehens durch den Runner (4.1.4) | P08c (API-Task vor den UI-Tasks) | `environments.lastSeenAt`, `connection`; Diagnose „Nicht prüfbar“ |
| D2 | Lesbare Versionsnummer: `configRevision: number` (`runtime_config_revisions.revision`, pro App fortlaufend) an der Deployment-Liste, an `capabilities.comparedTo` und am ausstehenden Wechsel | „v7“ statt IDs (Spec 7) | P08c (API) | „Konfiguration vom {Datum}“ und Kurz-ID |
| D3 | `connected-overview` liefert `pendingChange` (`{ kind: 'configuration', configurationRevisionId } \| { kind: 'unpublished-decisions' } \| null`; intern vorhanden als `PendingPlatformChange`) | Anwenden immer über `configurations/:id/apply`, Inhalt des Anwenden-Dialogs; Voraussetzung für Anwenden in Pro-Umgebungen hinter der ersten (`runs/:runId/apply` gilt nur für die erste Pipeline-Umgebung) | P08c (API) | erste Umgebung: `runs/:runId/apply` bei `action = apply`; sonst nur mit der Revision aus der `PATCH`-Antwort derselben Sitzung |
| D4 | `module` (im Artefakt vorhanden, in `CapabilityTool` nicht) und ein lokalisierter `title` pro Tool | Gruppierung nach Bereich, lesbare Namen | `module`: P08c (API); `title`: P05 (Stufe-2-Datenmodell, Skill) + P08c (Durchreichen) | Gruppe „Ohne Bereich“; `name` in Mono + erste Zeile der Beschreibung |
| D5 | Rollenvokabular der App im Capability-Bericht | Rollen einschränken, wenn der Code keine `allowedRoles` meldet | P05 (Vertrag) | Rollenwahl nur bei gemeldeten `allowedRoles` |
| D6 | Tool-Filter der Metrik-Abfrage (`toolId` → Tagesreihe `calls`/`errors` aus `runtime_metric_tool_hourly`) | 7-Tage-Balken im Drawer, „–“ für Tools außerhalb der Top 20 | P08c (API, nach P09 Teil B) | Summen aus `tools[]` (Top 20) |
| D7 | Audit-Ereignisse pro App für Dashboard-Nutzer (`targetAppId`-Filter, mehrere `type`: `runtime.app_setup.tool_override`, `runtime.deployment.rolled_back`, `runtime.revision.decision`, `runtime.revision.published`) | Historie „Änderungen von Hand“, Nennung von Lockerungen (4.4) | P08c (API) | Historie nur aus Deployments |
| D8 | Entscheidungserhaltendes Übernehmen (Promote) und erneutes Anwenden nach Rollback; Absicherung von `publish-and-deploy` und Promote gegen das Weglassen gespeicherter Entscheidungen | Pro-Übernahme, „Erneut anwenden“ nach Rollback, Wiedereinblenden der Expertenrouten (2.1) | P08d (Platform-Nachtrag, in Arbeit) | UI ruft `publish-and-deploy` und `environments/:id/promote` nicht auf und bietet kein Übernehmen an; nach einem Rollback ruhen gespeicherte Regeln („{k} Regeln ruhen“); Expertenrouten im Foundation-Profil ausgeblendet |
| D9 | Platform verwirft No-op-Felder serverseitig; Wettlauf beim Speichern | Absicherung zusätzlich zur Client-Regel 4.2.4 | P08d | Die Client-Regel sendet ohnehin nur Abweichungen |
| D10 | Monatsbudget | Budget-Hinweis | Produktentscheidung, nach MVP | Abschnitt entfällt |
| D11 | HEAD im Methoden-Enum der Platform-Schemas | HEAD-Tools in der Capability-Ansicht | P08d | – |
| D12 | Code-Bericht der Runner (`capabilities.discoveryDigest`, Artefakt-Upload) | Was kann mein Chat? überhaupt | P04 (SDK) + P11 (GID-Verdrahtung) | Zustand „Code-Stand nicht gemeldet“ |
| D13 | Metrik-Endpunkte `GET /v2/apps/:appId/metrics` und `/compare` | Kosten, Fehlerbedingung, Tool-Nutzung | P09 Teil B (Tasks 6–13, nach P08d) | Zustand „Noch keine Messwerte“; Fehler nur aus `healthStatus` des aktiven Deployments |
| D14 | Code-Werte je Feld in `capabilities` (`reported { riskClass, requiresApproval, enabled, allowedRoles }`; heute liefert keine Route den Code-Wert eines Felds mit `origin = platform`) | „Code-Wert: …“ im Drawer, Zwischenstufen zwischen Code- und Platform-Wert im Formular | P08c (API, optional) | Wahl relativ zum wirksamen Wert plus „Auf den Code-Wert zurück“ (4.2.4) |
| D15 | Vergleich zweier Konfigurationen (Tools neu, entfallen, geändert, Risiko, Regeln) | Änderungsliste pro Version in der Historie und im Rollback-Dialog; Richtung von „Zurück auf den Code-Wert“ im Anwenden-Dialog (4.1.6) | P08c (API) oder nach MVP | keine Liste; Technische Details mit `configRevisionId`; {l} zählt nur sichere Lockerungen |
| D16 | Wirksame Platform-Lockerung der Rückfrage bis Stufe 2. Heute ist `applyPolicyOverlay` restrict-only (`src/runtime/policy-overlay.ts`: `requiresApproval: false` ist „no-op, pinned or not“), P04 hält das als Ziel 1 fest („loosen on none“, auch im Turn-Snapshot), und die Platform meldet eine gespeicherte Lockerung deshalb als `relaxationPending` (`boundToolOverride`), also als unwirksam. Spec 4.9 („Wirksame Policy = `resolveToolPolicy(lokal wirksam, verifiziertes Platform-Overlay)`“) lässt gepinnte Lockerungen bis Stufe 2 schon zu; restrict-only war die strengere Umsetzung in P02/P04 und die Roadmap-Zeile eine Übergangsregel. D16 braucht also keine neue Produktentscheidung. Nötig: (a) SDK: Overlay und Turn-Snapshot übernehmen ein signiertes `toolOverrides`-Delta `requiresApproval: false` mit `pin { toolId = eigenes Tool, atRiskClass }` genau nach `relaxationAllowed` aus `resolveToolPolicy` (wirksame Stufe ≤ 2 und ≤ gepinnte Stufe, sonst `override-lapsed-risk-raised`; Stufe 3 nie; eine lokale Härtung gewinnt weiter). Die restrict-only-Fassung von P04 Tasks 1–3 ist auf `codex/mvp-tools` schon committet (`2d47280`, `489a124`, `584f5ae`); D16 ist dort ein Folge-Task, der sie ändert. (b) Platform: `boundToolOverride` und `capabilities` melden eine solche Lockerung als wirksam (`requiresApproval = false`, `origin.requiresApproval = platform`, `relaxationPending = false`). (c) Gleichlauf bei lokaler Härtung: Ein `requiresApproval: true` in `tool-policy.json` an einem Tool, das ohnehin fragt, meldet der Code-Bericht heute als `code-default` (`localPolicyOrigin` in `src/codegen/tools/pipeline.ts` übernimmt den aufgelösten Ursprung). Lässt die Runtime diese Härtung gewinnen (Spec 10 Punkt 5), zeigte Citadel „Gelockert“, während der Chat weiter fragt. Deshalb meldet der Code-Bericht jedes ausdrückliche lokale `requiresApproval: true` als `local-policy` (das Formular bietet dort kein Lockern an, 4.2.4), und SDK und Platform prüfen den Fall mit denselben Golden Vectors | Lockern im Dashboard (4.2.4). Ohne D16 wäre die Warnzeile „Der Chat fragt dann nicht mehr nach …“ unwahr (1.1) | SDK P04 (Folge-Task: Overlay, Turn-Snapshot, Ursprung im Code-Bericht, Golden Vectors) + Platform P08d (`boundToolOverride`, `capabilities`). Außerhalb dieser Datei anzupassen: P04 Ziel 1, die P08b-Zeile, nach der eine Lockerung ein No-op bleibt, die Roadmap-Zeile „Platform-„Lockern“ im Managed-Modus nur als wirksam anzeigen, wenn ein committeter lokaler Eintrag existiert“ und die Roadmap-Zeile P08c („Override-Formular nur einschränkend“, 8.1). Liegt D16 in SDK 0.5.0 (wie P04), braucht die UI keine Versionsweiche, weil der Code-Bericht ohnehin 0.5 voraussetzt (4.2.5); sonst meldet `capabilities` eine Lockerung nur für Umgebungen als wirksam, deren Runner D16 kann (D1), und nur dort bietet das Formular Lockern an | Das Formular bietet das Abschalten der Rückfrage nicht an; vorhandene Lockerungen erscheinen als `relaxationPending` (4.2.4) |

Reihenfolge für P08c:
1. API-Tasks D1–D4, D6 und D7 (optional D14, D15) im Worktree `mvp-platform`, nach P08d und P09 Teil B. D16 liefern P04 (SDK) und P08d; das Lockern in Schritt 5 setzt es voraus und gehört zum Release. Die Prüfskripte liegen bereits im Archiv (Grundlage).
2. Tokens, Shell und Sprachen (Root-Layouts, Kataloge, `resolveLocale`, Nutzermenü; 2.4).
3. Netz-Komponente.
4. Übersicht.
5. Tools inklusive Formular „Regeln ändern“ (Lockern nach D16).
6. Kosten.
7. Historie.
8. Verbinden.
9. Einstellungen.
10. Playwright-Matrix und Gate.

### 8.5 Schnittstelle zur Landing-Animation

Philipps Wunsch vom 2026-10-05 („auf der Landingpage … die Animation noch etwas besser“) läuft getrennt: Er mag den heutigen Look; Probleme sind die Unschärfe des Video-Loops (`components/landing/hero.tsx` spielt `/landing/hero-loop.webm|mp4`) und die kaputten KI-Glyphen. Daraus wird eine scharfe, im Code gerenderte Neufassung in zwei Varianten (Ledger: wf_5bba2f60-248), umgesetzt in P12, mit eigenem Renderer-Pfad (Standardentscheidung, 8.3). Berührungspunkte mit P08c:
- Die neue Hero-Animation liest dieselben Tokens (3.1: `net`, `net-core`, `net-tip`, `comet`, `comet-head`, `comet-glow`, `core-hot`, `lift`, `--core-glow`, `--hy-glow`) statt eigener Literale.
- Die Kometenzeichen sind echte Textknoten in JetBrains Mono (wie 3.6, `textPath`), keine gerenderten Glyphen; das behebt die kaputten KI-Glyphen und erfüllt Spec 8 („Hero-Glyphen als kontrollierte SVG-/Textebene lesbar“).
- Dieselbe Kometen-Mechanik wie das Citadel-Netz (3.6, 3.7: `stroke-dasharray` auf `pathLength=100`, SMIL `startOffset` für die Zeichen).
- Reduced Motion wie 3.7 (fertiges, stilles Bild), Pausieren außerhalb des Viewports und bei verborgenem Tab; Animationstechnik und Budgets wie 3.7 und 6.2, sofern P12 nichts anderes festlegt.
- Wer zuerst landet, ändert `landing.css`; die Gleichheitsaufnahme in Abschnitt 7 vergleicht gegen die dann gültige Landing-Fassung.

Pushes, Merges und Deployments gibt es nur nach Freigabe.
