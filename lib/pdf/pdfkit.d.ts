declare module 'pdfkit' {
  class PDFDocument {
    constructor(options?: Record<string, unknown>);
    pipe(destination: NodeJS.WritableStream): this;
    font(name: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    text(text: string, x?: number, y?: number, options?: Record<string, unknown>): this;
    rect(x: number, y: number, w: number, h: number): this;
    fill(color?: string): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(color?: string): this;
    strokeColor(color: string): this;
    image(src: Buffer | string, x?: number, y?: number, options?: Record<string, unknown>): this;
    roundedRect(x: number, y: number, w: number, h: number, r: number): this;
    lineWidth(w: number): this;
    dash(length: number, options?: { space?: number }): this;
    undash(): this;
    opacity(o: number): this;
    moveDown(lines?: number): this;
    addPage(options?: Record<string, unknown>): this;
    end(): void;
    on(event: string, callback: (...args: any[]) => void): this;
    y: number;
    page: { width: number; height: number };
  }
  export = PDFDocument;
}
