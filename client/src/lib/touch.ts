/**
 * Whether this device has a precise pointer (a mouse or trackpad). On touch screens, focusing a field
 * when a dialog opens pops up the keyboard and (iOS) zooms the page, so dialogs focus only here.
 */
export const finePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
