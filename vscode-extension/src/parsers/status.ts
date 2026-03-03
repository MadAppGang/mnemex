import type { IndexStatus } from '../types/messages.js';

/**
 * Parse the output of `claudemem status --agent`.
 *
 * Format:
 *   exists=<bool>
 *   [files=<n>]
 *   [chunks=<n>]
 *   [languages=<csv>]
 *   [model=<string>]
 *   [last_updated=<iso>]
 *
 * NOTE: model=none is emitted when no embedding model is configured.
 * This must be mapped to undefined, not propagated as the string "none".
 */
export function parseStatusOutput(raw: string): IndexStatus {
  const status: IndexStatus = { exists: false };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) {
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);

    switch (key) {
      case 'exists':
        status.exists = value === 'true';
        break;
      case 'files':
        status.files = parseInt(value, 10);
        break;
      case 'chunks':
        status.chunks = parseInt(value, 10);
        break;
      case 'languages':
        status.languages = value ? value.split(',').map((l) => l.trim()) : [];
        break;
      case 'model':
        // model=none means no embedding model configured
        status.model = value === 'none' ? undefined : value;
        break;
      case 'last_updated':
        status.lastUpdated = value;
        break;
    }
  }

  return status;
}
