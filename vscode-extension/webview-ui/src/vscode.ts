import type { WebviewToHostMessage } from './types/messages';

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

// acquireVsCodeApi() can only be called once. Cache the result.
let _vscode: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!_vscode) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _vscode = (window as any).acquireVsCodeApi() as VsCodeApi;
  }
  return _vscode;
}
