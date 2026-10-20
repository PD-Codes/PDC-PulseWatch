// Strings for the CA certificate store (Settings > Certificates).
export const en = {
  'settings.tab.certificates': 'Certificates',
  'certs.title': 'Trusted CA certificates', 'certs.intro': 'Certificates imported here are trusted in addition to the built-in root CAs by every TLS-capable check (HTTP, TLS, SMTP, databases, WebSocket, gRPC, MQTT) and by all probes. Use this for an internal or corporate CA.',
  'certs.import': 'Import certificate', 'certs.pem': 'PEM text', 'certs.pemHelp': 'One or more certificates starting with -----BEGIN CERTIFICATE-----, for example a whole CA bundle.', 'certs.file': 'Or choose a file (.pem, .crt, .cer)',
  'certs.name': 'Name (optional)', 'certs.empty': 'No certificates imported yet', 'certs.emptyHint': 'Only the built-in root CAs are trusted.',
  'certs.subject': 'Subject', 'certs.issuer': 'Issuer', 'certs.validUntil': 'Valid until', 'certs.fingerprint': 'SHA-256 fingerprint', 'certs.expired': 'expired',
  'certs.added': '{n} certificate(s) imported', 'certs.skipped': 'Skipped', 'certs.warnings': 'Notes', 'certs.readFailed': 'The file could not be read',
};
export const de: typeof en = {
  'settings.tab.certificates': 'Zertifikate',
  'certs.title': 'Vertrauenswürdige CA-Zertifikate', 'certs.intro': 'Hier importierte Zertifikate werden zusätzlich zu den eingebauten Root-CAs von allen TLS-fähigen Checks (HTTP, TLS, SMTP, Datenbanken, WebSocket, gRPC, MQTT) und allen Probes als vertrauenswürdig behandelt. Gedacht für eine interne oder Firmen-CA.',
  'certs.import': 'Zertifikat importieren', 'certs.pem': 'PEM-Text', 'certs.pemHelp': 'Ein oder mehrere Zertifikate, die mit -----BEGIN CERTIFICATE----- beginnen, zum Beispiel ein ganzes CA-Bundle.', 'certs.file': 'Oder eine Datei wählen (.pem, .crt, .cer)',
  'certs.name': 'Name (optional)', 'certs.empty': 'Noch keine Zertifikate importiert', 'certs.emptyHint': 'Es werden nur die eingebauten Root-CAs verwendet.',
  'certs.subject': 'Subject', 'certs.issuer': 'Aussteller', 'certs.validUntil': 'Gültig bis', 'certs.fingerprint': 'SHA-256-Fingerabdruck', 'certs.expired': 'abgelaufen',
  'certs.added': '{n} Zertifikat(e) importiert', 'certs.skipped': 'Übersprungen', 'certs.warnings': 'Hinweise', 'certs.readFailed': 'Die Datei konnte nicht gelesen werden',
};
