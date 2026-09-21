declare module "@novnc/novnc" {
  type RFBEvent = Event & { detail?: { clean?: boolean; reason?: string } };
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string } });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    addEventListener(type: string, listener: (event: RFBEvent) => void): void;
    disconnect(): void;
    focus(): void;
  }
}
