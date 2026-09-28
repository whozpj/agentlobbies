// Web-standard globals present in both Node 22+ and Cloudflare Workers. Declared here so the
// protocol package depends on neither @types/node nor DOM typings.
declare function btoa(data: string): string;
declare function atob(data: string): string;
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
declare const crypto: { getRandomValues<T extends Uint32Array>(array: T): T };
