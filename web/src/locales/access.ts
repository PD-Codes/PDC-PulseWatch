// Strings for group-restricted sign-in.
export const en = {
  'auth.error.no_access': 'Your account is not in a group that may use this application. Ask an administrator to add you.',
  'settings.auth.access.title': 'Who may sign in?',
  'settings.auth.access.body': 'Without an allow-list every user of this directory can sign in. Enter one or more groups to restrict access: members of the admin and editor groups below are always let in, everyone else is sent to the public status page (if one is published) or sees a notice that they have no permission. To keep out plain viewers altogether, turn on "Editors and admins only": then only members of the admin or editor groups get in.',
  'settings.auth.access.badge': 'Group restricted',
  'settings.auth.access.open': 'Open to every user of the directory',
} as const;

export const de = {
  'auth.error.no_access': 'Dein Konto ist in keiner Gruppe, die diese Anwendung nutzen darf. Bitte einen Administrator, dich hinzuzufügen.',
  'settings.auth.access.title': 'Wer darf sich anmelden?',
  'settings.auth.access.body': 'Ohne Gruppenliste kann sich jeder Benutzer des Verzeichnisses anmelden. Trage eine oder mehrere Gruppen ein, um den Zugang einzuschränken: Mitglieder der Admin- und Editor-Gruppen unten kommen immer hinein, alle anderen landen auf der öffentlichen Statusseite (sofern eine veröffentlicht ist) oder sehen den Hinweis, dass sie keine Berechtigung haben. Um reine Viewer auszuschließen, aktiviere „Editors and admins only“: dann kommen nur Mitglieder der Admin- oder Editor-Gruppen hinein.',
  'settings.auth.access.badge': 'Auf Gruppen beschränkt',
  'settings.auth.access.open': 'Offen für alle Benutzer des Verzeichnisses',
} as const;
