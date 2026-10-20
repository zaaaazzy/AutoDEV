// Nur der Teil von pngjs, den die visuelle Prüfung nutzt (das Paket bringt keine eigenen Typen mit).
declare module 'pngjs' {
  export class PNG {
    constructor(options?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
  const pngjs: { PNG: typeof PNG };
  export default pngjs;
}
