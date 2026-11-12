/**
 * Synthetic generated tool set shaped like a real task app after
 * `glirastes tools refresh`: ~100 tools, fragmented modules (`tasksReminder`,
 * `holidayCalendars`), one large `ui` module, German descriptions with
 * usage hints, and search synonyms keyed by model-facing name.
 */
export interface FixtureTool {
  name: string;
  module: string;
  description: string;
  executionKind: 'endpoint' | 'ui';
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  usageHints?: string[];
}

const endpoint = (
  name: string,
  module: string,
  method: FixtureTool['method'],
  description: string,
  usageHints?: string[],
): FixtureTool => ({ name, module, method, description, executionKind: 'endpoint', ...(usageHints ? { usageHints } : {}) });

const ui = (name: string, description: string, usageHints?: string[]): FixtureTool => ({
  name, module: 'ui', description, executionKind: 'ui', ...(usageHints ? { usageHints } : {}),
});

export const ROUTING_FIXTURE_TOOLS: FixtureTool[] = [
  // tasks (24)
  endpoint('tasks.list', 'tasks', 'GET', 'Listet Aufgaben mit Filtern nach Status, Priorität, Team und Fälligkeit.', ['Aufgaben anzeigen oder suchen, bevor eine Aufgabe geändert wird.']),
  endpoint('tasks.get', 'tasks', 'GET', 'Lädt eine einzelne Aufgabe mit allen Details.'),
  endpoint('tasks.create', 'tasks', 'POST', 'Legt eine neue Aufgabe an (Titel, Beschreibung, Fälligkeit, Priorität).', ['Neue Aufgabe oder To-do erstellen.']),
  endpoint('tasks.update', 'tasks', 'PATCH', 'Ändert Titel, Beschreibung, Fälligkeit oder Priorität einer Aufgabe.'),
  endpoint('tasks.delete', 'tasks', 'DELETE', 'Verschiebt eine Aufgabe in den Papierkorb.'),
  endpoint('tasks.restore', 'tasks', 'POST', 'Stellt eine Aufgabe aus dem Papierkorb wieder her.'),
  endpoint('tasks.deletePermanent', 'tasks', 'DELETE', 'Löscht eine Aufgabe endgültig.'),
  endpoint('tasks.assign', 'tasks', 'POST', 'Weist eine Aufgabe einer Person zu.'),
  endpoint('tasks.setStatus', 'tasks', 'PATCH', 'Setzt den Status einer Aufgabe (offen, in Arbeit, erledigt).', ['Aufgabe als erledigt markieren.']),
  endpoint('tasks.listActivity', 'tasks', 'GET', 'Zeigt den Verlauf und die Aktivitäten einer Aufgabe.'),
  endpoint('tasks.listSubtasks', 'tasks', 'GET', 'Listet die Unteraufgaben einer Aufgabe.'),
  endpoint('tasks.createSubtask', 'tasks', 'POST', 'Legt eine Unteraufgabe an.'),
  endpoint('tasks.updateSubtask', 'tasks', 'PATCH', 'Ändert eine Unteraufgabe.'),
  endpoint('tasks.deleteSubtask', 'tasks', 'DELETE', 'Löscht eine Unteraufgabe.'),
  endpoint('tasks.convertToPersonal', 'tasks', 'POST', 'Wandelt eine Teamaufgabe in eine persönliche Aufgabe um.'),
  endpoint('tasks.convertToTeam', 'tasks', 'POST', 'Wandelt eine persönliche Aufgabe in eine Teamaufgabe um.'),
  endpoint('tasks.bulkAssign', 'tasks', 'POST', 'Weist mehrere Aufgaben auf einmal zu.'),
  endpoint('tasks.bulkStatus', 'tasks', 'POST', 'Setzt den Status mehrerer Aufgaben auf einmal.'),
  endpoint('tasks.bulkDelete', 'tasks', 'POST', 'Verschiebt mehrere Aufgaben in den Papierkorb.'),
  endpoint('tasks.bulkRestore', 'tasks', 'POST', 'Stellt mehrere Aufgaben wieder her.'),
  endpoint('tasks.bulkUpdate', 'tasks', 'POST', 'Ändert Felder mehrerer Aufgaben auf einmal.'),
  endpoint('tasks.listTrash', 'tasks', 'GET', 'Listet die Aufgaben im Papierkorb.'),
  endpoint('tasks.calendar', 'tasksCalendar', 'GET', 'Aufgaben als Kalenderansicht nach Fälligkeit.'),
  endpoint('tasks.duplicate', 'tasksDuplicate', 'POST', 'Dupliziert eine Aufgabe.'),
  // task side modules (6)
  endpoint('tasksReminder.create', 'tasksReminder', 'POST', 'Legt eine Erinnerung für eine Aufgabe an.', ['Erinnere mich an eine Aufgabe.']),
  endpoint('tasksReminder.list', 'tasksReminder', 'GET', 'Listet die Erinnerungen einer Aufgabe.'),
  endpoint('tasksReminder.delete', 'tasksReminder', 'DELETE', 'Löscht eine Erinnerung.'),
  endpoint('tasksAttachments.list', 'tasksAttachments', 'GET', 'Listet die Anhänge einer Aufgabe.'),
  endpoint('tasksAttachments.upload', 'tasksAttachments', 'POST', 'Lädt eine Datei als Anhang zu einer Aufgabe hoch.'),
  endpoint('tasksAttachments.delete', 'tasksAttachments', 'DELETE', 'Entfernt einen Anhang von einer Aufgabe.'),
  // teams (10)
  endpoint('teams.list', 'teams', 'GET', 'Listet alle Teams.'),
  endpoint('teams.get', 'teams', 'GET', 'Lädt ein Team mit Details.'),
  endpoint('teams.create', 'teams', 'POST', 'Legt ein neues Team an.'),
  endpoint('teams.update', 'teams', 'PATCH', 'Benennt ein Team um oder ändert seine Beschreibung.'),
  endpoint('teams.delete', 'teams', 'DELETE', 'Löscht ein Team.'),
  endpoint('teamsMembers.list', 'teamsMembers', 'GET', 'Listet die Mitglieder eines Teams.'),
  endpoint('teamsMembers.add', 'teamsMembers', 'POST', 'Fügt eine Person einem Team hinzu.'),
  endpoint('teamsMembers.remove', 'teamsMembers', 'DELETE', 'Entfernt eine Person aus einem Team.'),
  endpoint('teamsMembers.setRole', 'teamsMembers', 'PATCH', 'Ändert die Rolle eines Teammitglieds.'),
  endpoint('teamsActivity.list', 'teamsActivity', 'GET', 'Zeigt die letzten Aktivitäten eines Teams.'),
  // templates (8)
  endpoint('templates.list', 'templates', 'GET', 'Listet Aufgabenvorlagen.'),
  endpoint('templates.get', 'templates', 'GET', 'Lädt eine Vorlage.'),
  endpoint('templates.create', 'templates', 'POST', 'Legt eine neue Vorlage an.'),
  endpoint('templates.update', 'templates', 'PATCH', 'Ändert eine Vorlage.'),
  endpoint('templates.delete', 'templates', 'DELETE', 'Löscht eine Vorlage.'),
  endpoint('templates.instantiate', 'templates', 'POST', 'Erstellt Aufgaben aus einer Vorlage.'),
  endpoint('templatesAttachments.list', 'templatesAttachments', 'GET', 'Listet die Anhänge einer Vorlage.'),
  endpoint('templatesAttachments.upload', 'templatesAttachments', 'POST', 'Lädt einen Anhang zu einer Vorlage hoch.'),
  // holidays (10)
  endpoint('holidays.list', 'holidays', 'GET', 'Listet die Feiertage eines Feiertagskalenders.'),
  endpoint('holidays.create', 'holidays', 'POST', 'Fügt einen Feiertag hinzu.'),
  endpoint('holidays.update', 'holidays', 'PATCH', 'Ändert einen Feiertag.'),
  endpoint('holidays.delete', 'holidays', 'DELETE', 'Löscht einen Feiertag.'),
  endpoint('holidayCalendars.list', 'holidayCalendars', 'GET', 'Listet die Feiertagskalender.'),
  endpoint('holidayCalendars.create', 'holidayCalendars', 'POST', 'Legt einen Feiertagskalender an.'),
  endpoint('holidayCalendars.update', 'holidayCalendars', 'PATCH', 'Ändert einen Feiertagskalender.'),
  endpoint('holidayCalendars.delete', 'holidayCalendars', 'DELETE', 'Löscht einen Feiertagskalender.'),
  endpoint('holidayCalendars.import', 'holidayCalendars', 'POST', 'Importiert gesetzliche Feiertage eines Bundeslands.'),
  endpoint('holidayCalendars.assign', 'holidayCalendars', 'POST', 'Weist einem Team einen Feiertagskalender zu.'),
  // users (6)
  endpoint('users.list', 'users', 'GET', 'Listet die Benutzer der Organisation.'),
  endpoint('users.get', 'users', 'GET', 'Lädt ein Benutzerprofil.'),
  endpoint('users.update', 'users', 'PATCH', 'Ändert Name oder Sprache eines Benutzers.'),
  endpoint('users.deactivate', 'users', 'POST', 'Deaktiviert einen Benutzer.'),
  endpoint('usersAvatar.upload', 'usersAvatar', 'POST', 'Lädt ein neues Profilbild hoch.'),
  endpoint('user.me', 'user', 'GET', 'Lädt das eigene Profil des angemeldeten Benutzers.'),
  // saved views (4)
  endpoint('savedViews.list', 'savedViews', 'GET', 'Listet gespeicherte Ansichten (gespeicherte Filter) der Aufgabenliste.'),
  endpoint('savedViews.create', 'savedViews', 'POST', 'Speichert die aktuellen Filter als Ansicht.'),
  endpoint('savedViews.update', 'savedViews', 'PATCH', 'Benennt eine gespeicherte Ansicht um.'),
  endpoint('savedViews.delete', 'savedViews', 'DELETE', 'Löscht eine gespeicherte Ansicht.'),
  // calendar (3)
  endpoint('calendar.events', 'calendar', 'GET', 'Listet Termine aus dem verbundenen Kalender.'),
  endpoint('calendar.parseDate', 'calendar', 'POST', 'Wandelt eine Datumsangabe wie "nächsten Freitag" in ein Datum um.'),
  endpoint('dashboard.get', 'dashboard', 'GET', 'Kennzahlen und Übersicht für das Dashboard.'),
  // tenant / settings / admin (8)
  endpoint('tenant.get', 'tenant', 'GET', 'Lädt die Einstellungen der Organisation.'),
  endpoint('tenant.update', 'tenant', 'PATCH', 'Ändert die Einstellungen der Organisation.'),
  endpoint('tenant.listAuditLog', 'tenant', 'GET', 'Zeigt das Audit-Log der Organisation.'),
  endpoint('mcpSettings.get', 'mcpSettings', 'GET', 'Zeigt die MCP-Verbindungseinstellungen.'),
  endpoint('mcpSettings.update', 'mcpSettings', 'PATCH', 'Ändert die MCP-Verbindungseinstellungen.'),
  endpoint('admin.listEntraUsers', 'admin', 'GET', 'Listet Benutzer aus Entra ID für den Import.'),
  endpoint('admin.inviteEntraUser', 'admin', 'POST', 'Lädt einen Entra-ID-Benutzer in die App ein.'),
  endpoint('syncTeams.create', 'syncTeams', 'POST', 'Synchronisiert Teams und Mitglieder aus Entra ID.'),
  // ui (22)
  ui('ui.navigate', 'Wechselt zu einer Seite der App (Dashboard, Aufgaben, Teams, Vorlagen, Einstellungen, Papierkorb).', ['Gehe zu einer Seite.']),
  ui('ui.action.navigate', 'Öffnet eine Detailseite mit ID, z. B. eine bestimmte Aufgabe oder ein Team.'),
  ui('ui.tasks.filters.apply', 'Wendet Filter auf die Aufgabenliste an (Status, Priorität, Team, Fälligkeit, Suchtext).', ['Aufgaben filtern oder Filter setzen.']),
  ui('ui.filter.tasks', 'Setzt URL-Filter der Aufgabenseite.'),
  ui('ui.filter.tasksKanban', 'Setzt Filter der Kanban-Ansicht der Aufgaben.'),
  ui('ui.filter.tasksItem', 'Setzt den Tab der Aufgaben-Detailseite.'),
  ui('ui.filter.teamsItem', 'Setzt den Tab der Team-Detailseite.'),
  ui('ui.filter.settings', 'Setzt den Tab der Einstellungsseite.'),
  ui('ui.tasks.savedView.apply', 'Wendet eine gespeicherte Ansicht auf die Aufgabenliste an.'),
  ui('ui.tasks.view.switch', 'Wechselt zwischen Listen- und Kanban-Ansicht der Aufgaben.'),
  ui('ui.taskDetails.open', 'Öffnet die Detailansicht einer Aufgabe.'),
  ui('ui.taskEditDialog.open', 'Öffnet den Bearbeiten-Dialog einer Aufgabe.'),
  ui('ui.taskCreateDialog.open', 'Öffnet den Dialog zum Anlegen einer Aufgabe.'),
  ui('ui.taskDeleteDialog.open', 'Öffnet den Löschen-Dialog einer Aufgabe.'),
  ui('ui.teams.create.open', 'Öffnet den Dialog zum Anlegen eines Teams.'),
  ui('ui.teams.edit.open', 'Öffnet den Bearbeiten-Dialog eines Teams.'),
  ui('ui.teams.delete.open', 'Öffnet den Löschen-Dialog eines Teams.'),
  ui('ui.teams.details.open', 'Öffnet die Detailansicht eines Teams.'),
  ui('ui.templateCreateDialog.open', 'Öffnet den Dialog zum Anlegen einer Vorlage.'),
  ui('ui.settings.tab.open', 'Öffnet einen Tab der Einstellungen.'),
  ui('ui.commandPalette.open', 'Öffnet die Befehlspalette.'),
  ui('ui.dashboard.refresh', 'Lädt das Dashboard neu.'),
];

export function fixtureModelName(name: string): string {
  return name.replace(/\./g, '_');
}

/** Search synonyms keyed by model-facing name, as `toolSearchSemantics` ships them. */
export const ROUTING_FIXTURE_SYNONYMS: Record<string, { synonyms: string[] }> = {
  tasks_list: { synonyms: ['Aufgaben', 'To-dos', 'tasks', 'meine Aufgaben', 'offene Aufgaben'] },
  tasks_create: { synonyms: ['Aufgabe anlegen', 'neue Aufgabe', 'create task', 'add todo'] },
  tasks_setStatus: { synonyms: ['erledigt', 'abhaken', 'mark done', 'complete task'] },
  tasks_assign: { synonyms: ['zuweisen', 'assign', 'verantwortlich'] },
  tasksReminder_create: { synonyms: ['Erinnerung', 'remind me', 'reminder'] },
  teams_list: { synonyms: ['Teams', 'Gruppen', 'teams'] },
  teamsMembers_add: { synonyms: ['Mitglied hinzufügen', 'add member'] },
  holidays_list: { synonyms: ['Feiertage', 'holidays', 'freie Tage'] },
  holidayCalendars_import: { synonyms: ['Feiertage importieren', 'Bundesland', 'import holidays'] },
  templates_list: { synonyms: ['Vorlagen', 'templates'] },
  savedViews_list: { synonyms: ['gespeicherte Ansichten', 'saved views', 'gespeicherte Filter'] },
  ui_navigate: { synonyms: ['gehe zu', 'öffne Seite', 'go to', 'navigate'] },
  ui_tasks_filters_apply: { synonyms: ['filtern', 'Filter', 'filter tasks', 'nur offene', 'nur meine'] },
  users_list: { synonyms: ['Benutzer', 'Mitarbeiter', 'users', 'people'] },
  dashboard_get: { synonyms: ['Übersicht', 'Kennzahlen', 'dashboard', 'statistics'] },
};
