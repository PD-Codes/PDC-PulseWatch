import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { post } from './api';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Sign in with a discoverable passkey. Resolves with the CSRF token of the new session. */
export async function passkeyLogin(): Promise<string> {
  const options = await post('/api/auth/passkeys/login/options');
  const credential = await startAuthentication({ optionsJSON: options });
  return (await post<{ csrf: string }>('/api/auth/passkeys/login/verify', { credential })).csrf;
}

/** Register a new passkey for the signed-in user. */
export async function passkeyRegister(name: string): Promise<void> {
  const options = await post('/api/auth/passkeys/register/options');
  const credential = await startRegistration({ optionsJSON: options });
  await post('/api/auth/passkeys/register/verify', { name, credential });
}
