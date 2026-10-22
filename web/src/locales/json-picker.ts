// "Fetch result" helper in the monitor form (HTTP(S) JSON query).
export const en = {
  'json.title': 'Fetch result',
  'json.intro': 'Call the URL once and pick the value to check from the answer instead of typing the path by hand.',
  'json.fetch': 'Fetch result',
  'json.use': 'Use',
  'json.expand': 'Expand',
  'json.collapse': 'Collapse',
  'json.more': '… {n} more entries not shown',
  'json.ideas': 'Suggested checks',
  'json.treeLabel': 'Response as a tree',
  'json.notJson': 'The answer is not JSON, so there is nothing to pick from. Check the URL, the method and the authentication above.',
  'json.pass': 'With this response the current condition passes.',
  'json.fail': 'With this response the current condition fails (value: {value}).',
  'json.missing': 'missing',
  'json.hint': 'Click a value to fill in path, condition and expected value. Containers (objects and lists) are checked with "exists". The request is sent from this server with the settings above, not from a probe.',
} as const;

export const de = {
  'json.title': 'Ergebnis abrufen',
  'json.intro': 'Ruft die URL einmal auf, damit du den zu prüfenden Wert aus der Antwort auswählen kannst, statt den Pfad von Hand zu tippen.',
  'json.fetch': 'Ergebnis abrufen',
  'json.use': 'Übernehmen',
  'json.expand': 'Aufklappen',
  'json.collapse': 'Zuklappen',
  'json.more': '… {n} weitere Einträge nicht angezeigt',
  'json.ideas': 'Vorgeschlagene Prüfungen',
  'json.treeLabel': 'Antwort als Baum',
  'json.notJson': 'Die Antwort ist kein JSON, es gibt also nichts auszuwählen. Prüfe URL, Methode und Authentifizierung oben.',
  'json.pass': 'Mit dieser Antwort ist die aktuelle Bedingung erfüllt.',
  'json.fail': 'Mit dieser Antwort ist die aktuelle Bedingung nicht erfüllt (Wert: {value}).',
  'json.missing': 'fehlt',
  'json.hint': 'Klicke auf einen Wert, um Pfad, Bedingung und Erwartungswert zu füllen. Objekte und Listen werden mit „exists“ geprüft. Die Anfrage wird von diesem Server aus mit den obigen Einstellungen gesendet, nicht von einer Probe.',
} as const;
