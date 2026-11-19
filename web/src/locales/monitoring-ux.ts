// Strings for the reworked monitoring pages: dashboard filters and sorting, snooze, SLO, CSV export, browser notifications, status page bars.
export const en = {
  'mux.dash.sort': 'Sort', 'mux.dash.sort.status': 'Problems first', 'mux.dash.sort.name': 'Name', 'mux.dash.sort.latency': 'Slowest first', 'mux.dash.sort.uptime': 'Lowest uptime first',
  'mux.dash.statusFilter': 'Filter by status', 'mux.dash.chipTip': 'Show only: {label}', 'mux.dash.sloMissed': 'SLO missed', 'mux.dash.snoozed': 'Muted',
  'mux.dash.problems': 'Problems ({n})', 'mux.dash.more': '+{n} more', 'mux.dash.shown': '{n} of {total} monitors', 'mux.dash.history': 'Recent checks', 'mux.dash.col.latency': 'Response', 'mux.dash.stale': 'Last check {when}',

  'mux.form.slo': 'SLO target (%)', 'mux.form.sloHint': 'Uptime goal over 30 days, e.g. 99.9. Empty: no target.', 'mux.form.sloInvalid': 'Enter a value from 50 to below 100 with at most three decimals, or leave the field empty.',
  'mux.form.descPublic': 'Shown on public status pages that include this monitor.', 'mux.form.depsPicked': '{n} selected', 'mux.form.depsHint': 'Alerts are held back while a selected monitor is down.',
  'mux.form.errorCount': 'Please check {n} entries', 'mux.form.unsaved': 'Unsaved changes',

  'mux.detail.periodCount': '{n} periods',

  'mux.snooze.title': 'Mute', 'mux.snooze.hint': 'No notifications for a while. Checks, status and incidents carry on.', 'mux.snooze.h1': '1 hour', 'mux.snooze.h4': '4 hours',
  'mux.snooze.untilToday': 'Until {time}', 'mux.snooze.untilTomorrow': 'Until tomorrow {time}', 'mux.snooze.until': 'muted until {when}', 'mux.snooze.tooltip': 'Notifications muted until {when}',
  'mux.snooze.clear': 'Unmute', 'mux.snooze.done': 'Muted until {when}', 'mux.snooze.doneMany': '{n} monitors muted until {when}', 'mux.snooze.cleared': 'Notifications are on again',
  'mux.snooze.incidentHint': 'Mutes the notifications of all monitors in this incident.',

  'mux.slo.title': 'Service level objective', 'mux.slo.titleTarget': 'SLO {target}', 'mux.slo.window': 'last {n} days', 'mux.slo.met': 'On track', 'mux.slo.tight': 'Budget nearly used', 'mux.slo.missed': 'Missed', 'mux.slo.noData': 'Not enough data',
  'mux.slo.left': '{time} downtime left', 'mux.slo.budget': 'of {time}', 'mux.slo.usedPct': '{pct} % of the error budget used',
  'mux.slo.badge': 'SLO {target}', 'mux.slo.missedTip': '30-day uptime {uptime} is below the target of {target}',

  'mux.export.button': 'CSV', 'mux.export.title': 'Export as CSV', 'mux.export.download': 'Download', 'mux.export.kind': 'Content',
  'mux.export.events': 'Events', 'mux.export.heartbeats': 'Individual checks', 'mux.export.eventsHint': 'Status changes, maintenance and other events.', 'mux.export.heartbeatsHint': 'Every single check with status, response time and message.',
  'mux.export.range': 'Period', 'mux.export.p.24h': '24 h', 'mux.export.p.7d': '7 days', 'mux.export.p.14d': '14 days', 'mux.export.p.30d': '30 days', 'mux.export.p.custom': 'Custom',
  'mux.export.badRange': 'The start must be before the end.', 'mux.export.retention': 'Individual checks are kept only for a limited time (14 days by default); older ones are not in the file.',

  'mux.alert.down': '{name} is down', 'mux.alert.up': '{name} is back up', 'mux.alert.downBody': 'The check failed.', 'mux.alert.upBody': 'The check succeeds again.',

  'mux.public.legend': 'Bars: uptime per day over the last {n} days. The label on the right is the current status.',
  'mux.public.now': 'Now', 'mux.public.nowTip': 'Current status', 'mux.public.todaySoFar': 'Today so far',
  'mux.public.dayFull': '{day}: {up} available', 'mux.public.dayDown': '{day}: {up} available, {down} outage', 'mux.public.todayDown': 'Today: {pct} outage',

  'mux.tz.days': 'Days in time zone {tz}', 'mux.tz.hint': 'Days are counted in the time zone of this PulseWatch instance.',
};
export const de: typeof en = {
  'mux.dash.sort': 'Sortierung', 'mux.dash.sort.status': 'Probleme zuerst', 'mux.dash.sort.name': 'Name', 'mux.dash.sort.latency': 'Langsamste zuerst', 'mux.dash.sort.uptime': 'Geringste Verfügbarkeit zuerst',
  'mux.dash.statusFilter': 'Nach Status filtern', 'mux.dash.chipTip': 'Nur anzeigen: {label}', 'mux.dash.sloMissed': 'SLO verfehlt', 'mux.dash.snoozed': 'Stumm',
  'mux.dash.problems': 'Probleme ({n})', 'mux.dash.more': '+{n} weitere', 'mux.dash.shown': '{n} von {total} Monitoren', 'mux.dash.history': 'Letzte Prüfungen', 'mux.dash.col.latency': 'Antwort', 'mux.dash.stale': 'Letzte Prüfung {when}',

  'mux.form.slo': 'SLO-Ziel (%)', 'mux.form.sloHint': 'Verfügbarkeitsziel über 30 Tage, z. B. 99.9. Leer: kein Ziel.', 'mux.form.sloInvalid': 'Gib einen Wert von 50 bis unter 100 mit höchstens drei Nachkommastellen ein oder lass das Feld leer.',
  'mux.form.descPublic': 'Erscheint auf öffentlichen Status-Seiten, die diesen Monitor zeigen.', 'mux.form.depsPicked': '{n} ausgewählt', 'mux.form.depsHint': 'Alarme werden unterdrückt, solange ein ausgewählter Monitor offline ist.',
  'mux.form.errorCount': 'Bitte prüfe {n} Angaben', 'mux.form.unsaved': 'Ungespeicherte Änderungen',

  'mux.detail.periodCount': '{n} Abschnitte',

  'mux.snooze.title': 'Stummschalten', 'mux.snooze.hint': 'Eine Weile keine Benachrichtigungen. Prüfungen, Status und Vorfälle laufen weiter.', 'mux.snooze.h1': '1 Stunde', 'mux.snooze.h4': '4 Stunden',
  'mux.snooze.untilToday': 'Bis {time}', 'mux.snooze.untilTomorrow': 'Bis morgen {time}', 'mux.snooze.until': 'stumm bis {when}', 'mux.snooze.tooltip': 'Benachrichtigungen stumm bis {when}',
  'mux.snooze.clear': 'Stumm aufheben', 'mux.snooze.done': 'Stumm bis {when}', 'mux.snooze.doneMany': '{n} Monitore stumm bis {when}', 'mux.snooze.cleared': 'Benachrichtigungen sind wieder an',
  'mux.snooze.incidentHint': 'Schaltet die Benachrichtigungen aller Monitore dieses Vorfalls stumm.',

  'mux.slo.title': 'Service-Level-Ziel', 'mux.slo.titleTarget': 'SLO {target}', 'mux.slo.window': 'letzte {n} Tage', 'mux.slo.met': 'Im Plan', 'mux.slo.tight': 'Budget fast aufgebraucht', 'mux.slo.missed': 'Verfehlt', 'mux.slo.noData': 'Zu wenig Daten',
  'mux.slo.left': 'noch {time} Ausfall möglich', 'mux.slo.budget': 'von {time}', 'mux.slo.usedPct': '{pct} % des Fehlerbudgets verbraucht',
  'mux.slo.badge': 'SLO {target}', 'mux.slo.missedTip': 'Verfügbarkeit 30 Tage {uptime} liegt unter dem Ziel von {target}',

  'mux.export.button': 'CSV', 'mux.export.title': 'Als CSV exportieren', 'mux.export.download': 'Herunterladen', 'mux.export.kind': 'Inhalt',
  'mux.export.events': 'Ereignisse', 'mux.export.heartbeats': 'Einzelne Prüfungen', 'mux.export.eventsHint': 'Statuswechsel, Wartungen und andere Ereignisse.', 'mux.export.heartbeatsHint': 'Jede einzelne Prüfung mit Status, Antwortzeit und Meldung.',
  'mux.export.range': 'Zeitraum', 'mux.export.p.24h': '24 h', 'mux.export.p.7d': '7 Tage', 'mux.export.p.14d': '14 Tage', 'mux.export.p.30d': '30 Tage', 'mux.export.p.custom': 'Eigener',
  'mux.export.badRange': 'Der Beginn muss vor dem Ende liegen.', 'mux.export.retention': 'Einzelne Prüfungen werden nur begrenzt aufbewahrt (standardmäßig 14 Tage); ältere fehlen in der Datei.',

  'mux.alert.down': '{name} ist offline', 'mux.alert.up': '{name} ist wieder online', 'mux.alert.downBody': 'Die Prüfung ist fehlgeschlagen.', 'mux.alert.upBody': 'Die Prüfung ist wieder erfolgreich.',

  'mux.public.legend': 'Balken: Verfügbarkeit pro Tag der letzten {n} Tage. Rechts steht der aktuelle Status.',
  'mux.public.now': 'Jetzt', 'mux.public.nowTip': 'Aktueller Status', 'mux.public.todaySoFar': 'Heute bisher',
  'mux.public.dayFull': '{day}: {up} verfügbar', 'mux.public.dayDown': '{day}: {up} verfügbar, {down} Ausfall', 'mux.public.todayDown': 'Heute: {pct} Ausfall',

  'mux.tz.days': 'Tage in Zeitzone {tz}', 'mux.tz.hint': 'Tage werden in der Zeitzone dieser PulseWatch-Instanz gezählt.',
};
