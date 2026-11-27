/**
 * True for the keydown that confirms an IME composition (#1253). Chrome and Firefox deliver it
 * with `isComposing: true` and `keyCode: 229`. Safari may fire `compositionend` before the keydown,
 * leaving `isComposing` false, but the event still carries the legacy `keyCode` 229 (MDN "keydown
 * event", WebKit bug 165004), so both are checked.
 */
export function isConfirmingComposition(e: {
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return e.isComposing === true || e.nativeEvent?.isComposing === true || e.keyCode === 229 || e.nativeEvent?.keyCode === 229;
}
