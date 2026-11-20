import { KeyKiosk } from './kiosk/KeyKiosk';
import { SessionKiosk } from './kiosk/SessionKiosk';

/**
 * Wall display (/kiosk). Signed in, it follows a preset or the settings in the address; opened with a kiosk key
 * (/kiosk?preset=<slug>#key=pwk_...) it shows the key's preset without a session.
 */
export default function Kiosk({ kioskKey }: { kioskKey?: string }) {
  return kioskKey ? <KeyKiosk kioskKey={kioskKey} /> : <SessionKiosk />;
}
