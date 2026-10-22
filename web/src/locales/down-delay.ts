// Strings for the "report as down after" rule and the per-component incident hiding.
export const en = {
  'delay.label': 'Report as down after', 'delay.unit': 'Unit', 'delay.seconds': 'seconds', 'delay.minutes': 'minutes', 'delay.inherit': 'Instance rule',
  'delay.hintMonitor': 'Open an incident and alert only when the monitor has been failing this long, so restarts and short blips are ignored. Empty follows the instance rule ({value}).',
  'delay.hintGlobal': 'Applies live to every monitor without a value of its own. 0 reports right away.',
  'delay.off': 'immediately', 'delay.sec': '{n} s', 'delay.min': '{n} min',
  'statuspages.hideIncidents': 'Hide from past incidents', 'statuspages.hideIncidentsHint': 'Resolved incidents of this component are not listed on this page (open ones still are).',
};
export const de = {
  'delay.label': 'Als ausgefallen melden nach', 'delay.unit': 'Einheit', 'delay.seconds': 'Sekunden', 'delay.minutes': 'Minuten', 'delay.inherit': 'Globale Regel',
  'delay.hintMonitor': 'Vorfall und Alarm erst, wenn der Monitor so lange durchgehend ausfällt. Neustarts und kurze Aussetzer werden so ignoriert. Leer folgt der globalen Regel ({value}).',
  'delay.hintGlobal': 'Gilt sofort für jeden Monitor ohne eigenen Wert. 0 meldet sofort.',
  'delay.off': 'sofort', 'delay.sec': '{n} s', 'delay.min': '{n} Min.',
  'statuspages.hideIncidents': 'In vergangenen Vorfällen ausblenden', 'statuspages.hideIncidentsHint': 'Behobene Vorfälle dieser Komponente erscheinen nicht auf dieser Seite (offene weiterhin).',
};
