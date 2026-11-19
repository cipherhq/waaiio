// @vitest-environment jsdom
/**
 * The property check-in page downloads and prints from a ref to the QR canvas;
 * other pages find it by id. Both must keep working with StyledQRCode.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { StyledQRCode } from '../StyledQRCode';

afterEach(cleanup);

describe('StyledQRCode canvas in the DOM', () => {
  it('forwards the ref to the <canvas> and keeps the id', () => {
    const ref = createRef<HTMLCanvasElement>();
    const { container } = render(
      <StyledQRCode ref={ref} id="checkin-qr" value="https://waaiio.com/checkin/property/abc" size={256} renderAs="canvas" resolution={1024} />,
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(ref.current).toBe(canvas);
    expect(canvas!.id).toBe('checkin-qr');
  });
});
