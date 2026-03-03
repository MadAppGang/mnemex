import { useEffect } from 'react';
import type { HostToWebviewMessage } from '../types/messages';

/**
 * Subscribe to messages from the VS Code extension host.
 * Calls handler with each typed message received.
 */
export function useVscodeMessages(handler: (message: HostToWebviewMessage) => void): void {
  useEffect(() => {
    const listener = (event: MessageEvent<HostToWebviewMessage>) => {
      handler(event.data);
    };

    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
    };
  }, [handler]);
}
