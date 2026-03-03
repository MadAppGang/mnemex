import { randomBytes } from 'crypto';

/**
 * Generate a cryptographically random nonce for use in Content Security Policy headers.
 */
export function getNonce(): string {
  return randomBytes(16).toString('base64');
}
