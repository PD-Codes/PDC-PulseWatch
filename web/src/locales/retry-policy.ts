// Interval, retry and timeout wording as in Uptime Kuma.
export const en = {
  'monitors.interval': 'Heartbeat interval',
  'monitors.timeout': 'Request timeout',
  'monitors.retries': 'Retries',
  'monitors.retryInterval': 'Heartbeat retry interval',
  'monitors.form.checkEvery': 'Check every {n} seconds',
  'monitors.form.timeoutAfter': 'Timeout after {n} seconds, at most 80% of the interval',
  'monitors.form.retryEvery': 'Retry every {n} seconds',
  'monitors.form.retriesHint': 'Maximum retries before the service is marked as down and a notification is sent',
  'monitors.retrySummary': 'A monitor that stops answering is reported as down about {time} after its first failed check starts at the latest.',
  'monitors.retryNow': 'A failed check is reported as down right away.',
};
export const de: typeof en = {
  'monitors.interval': 'Heartbeat-Intervall',
  'monitors.timeout': 'Anfrage-Timeout',
  'monitors.retries': 'Wiederholungen',
  'monitors.retryInterval': 'Heartbeat-Wiederholungsintervall',
  'monitors.form.checkEvery': 'Prüfe alle {n} Sekunden',
  'monitors.form.timeoutAfter': 'Timeout nach {n} Sekunden, höchstens 80 % des Intervalls',
  'monitors.form.retryEvery': 'Wiederhole alle {n} Sekunden',
  'monitors.form.retriesHint': 'Maximale Wiederholungen, bevor der Dienst als ausgefallen markiert und eine Benachrichtigung gesendet wird',
  'monitors.retrySummary': 'Ein Monitor, der nicht mehr antwortet, wird spätestens etwa {time} nach Beginn der ersten fehlgeschlagenen Prüfung als offline gemeldet.',
  'monitors.retryNow': 'Eine fehlgeschlagene Prüfung wird sofort als offline gemeldet.',
};
