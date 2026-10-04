declare function GM_getValue<T>(key: string, fallback?: T): T;
declare const unsafeWindow: Window & typeof globalThis;
declare const exportFunction: undefined | ((callback: Function, target: object) => Function);
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_addValueChangeListener(
  key: string,
  callback: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void,
): number;
declare function GM_registerMenuCommand(name: string, action: () => void): void;
declare function GM_xmlhttpRequest(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  anonymous: boolean;
  timeout: number;
  onload: (response: { status: number; responseText: string }) => void;
  onerror: () => void;
  ontimeout: () => void;
}): void;
