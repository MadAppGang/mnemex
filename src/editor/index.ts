/**
 * Editor Module
 *
 * Public exports for the code editing system.
 */

export { SymbolLocator, utf16ToByteOffset, byteToUtf16Offset } from "./locator.js";
export type { SymbolLocation } from "./locator.js";
export { EditValidator } from "./validator.js";
export { EditHistory } from "./history.js";
export type { EditSession } from "./history.js";
export { SymbolEditor, atomicWrite } from "./editor.js";
export type { InsertMode, EditOptions, EditResult } from "./editor.js";
