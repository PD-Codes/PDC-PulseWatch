// Strings for the SAML single sign-on provider (shown in Settings > Authentication).
export const en = {
  'settings.auth.saml.kind': 'SAML 2.0 (Entra ID)',
  'settings.auth.saml.urls': 'Enter these values at your identity provider',
  'settings.auth.saml.acs': 'Reply URL (assertion consumer service)', 'settings.auth.saml.entityId': 'Identifier (entity ID)', 'settings.auth.saml.metadata': 'Service provider metadata',
  'settings.auth.saml.saveFirst': 'Save the provider first, the URLs contain its ID.',
  'settings.auth.saml.help': 'Entra ID: create an enterprise application (non-gallery), choose Single sign-on > SAML, enter the identifier and reply URL above, then copy "Login URL", "Microsoft Entra Identifier" and the Base64 certificate back into this form. Only sign-in started from PulseWatch is accepted (no IdP-initiated sign-in).',
};
export const de: typeof en = {
  'settings.auth.saml.kind': 'SAML 2.0 (Entra ID)',
  'settings.auth.saml.urls': 'Diese Werte beim Identity Provider eintragen',
  'settings.auth.saml.acs': 'Antwort-URL (Assertion Consumer Service)', 'settings.auth.saml.entityId': 'Bezeichner (Entity-ID)', 'settings.auth.saml.metadata': 'Service-Provider-Metadaten',
  'settings.auth.saml.saveFirst': 'Zuerst den Provider speichern, die URLs enthalten seine ID.',
  'settings.auth.saml.help': 'Entra ID: Unternehmensanwendung (nicht aus dem Katalog) anlegen, Einmaliges Anmelden > SAML wählen, Bezeichner und Antwort-URL von oben eintragen und danach "Anmelde-URL", "Microsoft Entra-Bezeichner" und das Base64-Zertifikat in dieses Formular übernehmen. Nur die Anmeldung, die von PulseWatch aus gestartet wird, wird akzeptiert (kein IdP-initiiertes Anmelden).',
};
