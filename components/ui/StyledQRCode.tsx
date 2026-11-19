'use client';

/**
 * The one QR code component for the dashboard, onboarding and marketing pages.
 * Rounded modules, rounded finder eyes and a corner-bracket frame
 * (Owner request 2026-11-19). The encoded content is exactly `value`.
 *
 * renderAs="canvas" keeps the old QRCodeCanvas contract: pages that download
 * or draw the code find the <canvas> and call toDataURL()/drawImage(). Set
 * `resolution` to give that canvas more pixels than its on-screen size, so
 * downloads stay sharp in print.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from 'react';
import { drawStyledQr, styledQrGeometry, type QrMatrix } from '@/shared/styled-qr';
import { qrMatrix, type QrLevel } from '@/lib/qr/styled-qr';

export interface StyledQRCodeProps {
  value: string;
  /** On-screen size in CSS pixels. */
  size: number;
  level?: QrLevel;
  renderAs?: 'svg' | 'canvas';
  /** Canvas only: backing pixels per side. Defaults to size × devicePixelRatio. */
  resolution?: number;
  fgColor?: string;
  bgColor?: string;
  /** Corner brackets outside the quiet zone. Default true. */
  frame?: boolean;
  id?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  'aria-label'?: string;
}

function useMatrix(value: string, level: QrLevel): QrMatrix | null {
  return useMemo(() => {
    if (!value) return null;
    try {
      return qrMatrix(value, level);
    } catch {
      return null; // too long to encode — render nothing rather than crash the page
    }
  }, [value, level]);
}

export const StyledQRCode = forwardRef<HTMLCanvasElement | null, StyledQRCodeProps>(function StyledQRCode(
  { value, size, level = 'M', renderAs = 'svg', resolution, fgColor = '#000000', bgColor = '#ffffff', frame = true, id, className, style, title, ...rest },
  ref,
) {
  const matrix = useMatrix(value, level);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useImperativeHandle(ref, () => canvasRef.current as HTMLCanvasElement, []);

  useEffect(() => {
    if (renderAs !== 'canvas' || !matrix) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixels = Math.round(resolution ?? size * (window.devicePixelRatio || 1));
    canvas.width = pixels;
    canvas.height = pixels;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawStyledQr(ctx, matrix, pixels, { fgColor, bgColor, frame });
  }, [renderAs, matrix, size, resolution, fgColor, bgColor, frame]);

  const ariaLabel = rest['aria-label'];

  if (renderAs === 'canvas') {
    return (
      <canvas
        ref={canvasRef}
        id={id}
        className={className}
        style={{ width: size, height: size, ...style }}
        role={ariaLabel || title ? 'img' : undefined}
        aria-label={ariaLabel || title}
      />
    );
  }

  if (!matrix) {
    return <svg id={id} className={className} style={style} width={size} height={size} aria-hidden="true" />;
  }
  const g = styledQrGeometry(matrix, { frame });
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      id={id}
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox={`0 0 ${g.units} ${g.units}`}
      shapeRendering="geometricPrecision"
      role={ariaLabel || title ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      {title ? <title>{title}</title> : null}
      <rect width={g.units} height={g.units} fill={bgColor} />
      <path d={g.modulesPath} fill={fgColor} />
      <path d={g.findersPath} fill={fgColor} fillRule="evenodd" />
      {g.framePath ? (
        <path d={g.framePath} fill="none" stroke={fgColor} strokeWidth={g.frameStroke} strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
    </svg>
  );
});
