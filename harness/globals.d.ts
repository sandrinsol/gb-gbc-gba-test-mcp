// The page bridge (page.html) and EmulatorJS globals that driver code reaches
// through page.evaluate().
declare global {
  interface Window {
    Emu: any;
    EJS_emulator: any;
  }
}
export {};
