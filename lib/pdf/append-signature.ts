import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

interface AppendSignatureData {
  originalFileBuffer: Buffer;
  originalFileType: 'pdf' | 'image';
  businessName: string;
  title: string;
  signerName: string;
  signatureData: string; // base64 data URI
  signedAt: string;
  auditTrail: {
    ip: string;
    user_agent: string;
    device_type: string;
    signed_at: string;
  };
  contractId: string;
  logoBuffer?: Buffer;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Takes an uploaded document (PDF or image) and appends a signature page
 * with the signer's signature and Waaiio verification branding.
 */
export async function appendSignatureToUploadedPdf(data: AppendSignatureData): Promise<Buffer> {
  let pdfDoc: PDFDocument;

  if (data.originalFileType === 'pdf') {
    // Load existing PDF and append a signature page
    pdfDoc = await PDFDocument.load(data.originalFileBuffer);
  } else {
    // Image: create a new PDF with the image as the first page
    pdfDoc = await PDFDocument.create();
    const ext = data.originalFileBuffer[0] === 0x89 ? 'png' : 'jpg';

    let image;
    if (ext === 'png') {
      image = await pdfDoc.embedPng(data.originalFileBuffer);
    } else {
      image = await pdfDoc.embedJpg(data.originalFileBuffer);
    }

    // Fit image to A4 page with margins
    const a4Width = 595;
    const a4Height = 842;
    const margin = 40;
    const maxW = a4Width - margin * 2;
    const maxH = a4Height - margin * 2;

    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    const imgW = image.width * scale;
    const imgH = image.height * scale;

    const page = pdfDoc.addPage([a4Width, a4Height]);
    page.drawImage(image, {
      x: (a4Width - imgW) / 2,
      y: a4Height - margin - imgH,
      width: imgW,
      height: imgH,
    });
  }

  // Add signature page
  const sigPage = pdfDoc.addPage([595, 842]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const brandColor = rgb(0.1, 0.34, 0.86); // #1a56db
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const lightGray = rgb(0.6, 0.6, 0.6);

  let y = 780;

  // ── Waaiio branding (top-right) ──
  sigPage.drawText('waaiio', {
    x: 440, y: 800, size: 18, font: fontBold, color: brandColor,
  });
  sigPage.drawText('Electronic Signature', {
    x: 440, y: 785, size: 7, font, color: lightGray,
  });

  // ── Business logo (if provided) ──
  if (data.logoBuffer) {
    try {
      const isPng = data.logoBuffer[0] === 0x89;
      const logoImage = isPng
        ? await pdfDoc.embedPng(data.logoBuffer)
        : await pdfDoc.embedJpg(data.logoBuffer);
      const logoScale = Math.min(40 / logoImage.width, 40 / logoImage.height, 1);
      sigPage.drawImage(logoImage, {
        x: 50, y: y - 30, width: logoImage.width * logoScale, height: logoImage.height * logoScale,
      });
    } catch {
      // Skip logo if embedding fails
    }
  }

  // ── Header ──
  sigPage.drawText(data.businessName, {
    x: data.logoBuffer ? 100 : 50, y, size: 10, font, color: gray,
  });
  y -= 22;

  sigPage.drawText(data.title, {
    x: 50, y, size: 18, font: fontBold, color: black,
  });
  y -= 18;

  sigPage.drawText('Signature Certificate', {
    x: 50, y, size: 12, font, color: gray,
  });
  y -= 20;

  sigPage.drawText(`Date: ${formatDate(data.signedAt)}  |  Ref: ${data.contractId}`, {
    x: 50, y, size: 9, font, color: lightGray,
  });
  y -= 15;

  // Divider
  sigPage.drawLine({
    start: { x: 50, y },
    end: { x: 545, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 30;

  // ── Confirmation text ──
  sigPage.drawText('This document confirms that the attached document has been electronically', {
    x: 50, y, size: 10, font, color: black,
  });
  y -= 16;
  sigPage.drawText('reviewed and signed by the following party:', {
    x: 50, y, size: 10, font, color: black,
  });
  y -= 40;

  // ── Signer details ──
  sigPage.drawText('SIGNED BY', {
    x: 50, y, size: 9, font: fontBold, color: gray,
  });
  y -= 18;

  sigPage.drawText(data.signerName, {
    x: 50, y, size: 14, font: fontBold, color: black,
  });
  y -= 20;

  sigPage.drawText(`Date & Time: ${formatDate(data.signedAt)}`, {
    x: 50, y, size: 10, font, color: gray,
  });
  y -= 35;

  // ── Embed signature image ──
  sigPage.drawText('Signature:', {
    x: 50, y, size: 9, font: fontBold, color: gray,
  });
  y -= 10;

  try {
    const base64 = data.signatureData.replace(/^data:image\/\w+;base64,/, '');
    const sigBytes = Buffer.from(base64, 'base64');
    const sigImage = await pdfDoc.embedPng(sigBytes);

    const sigScale = Math.min(220 / sigImage.width, 90 / sigImage.height);
    const sigW = sigImage.width * sigScale;
    const sigH = sigImage.height * sigScale;

    sigPage.drawImage(sigImage, {
      x: 50, y: y - sigH, width: sigW, height: sigH,
    });
    y -= sigH + 10;
  } catch {
    sigPage.drawText('[Signature on file]', {
      x: 50, y: y - 15, size: 10, font, color: lightGray,
    });
    y -= 25;
  }

  // Signature line
  sigPage.drawLine({
    start: { x: 50, y },
    end: { x: 270, y },
    thickness: 1,
    color: black,
  });
  y -= 14;

  sigPage.drawText(data.signerName, {
    x: 50, y, size: 8, font, color: gray,
  });
  y -= 50;

  // ── Waaiio verification footer ──
  sigPage.drawLine({
    start: { x: 50, y },
    end: { x: 545, y },
    thickness: 0.5,
    color: rgb(0.88, 0.88, 0.88),
  });
  y -= 18;

  sigPage.drawText('Verified by waaiio', {
    x: 50, y, size: 10, font: fontBold, color: brandColor,
  });
  y -= 16;

  sigPage.drawText(
    'This document was electronically signed and verified through waaiio\'s secure signing platform.',
    { x: 50, y, size: 8, font, color: lightGray },
  );
  y -= 14;

  sigPage.drawText(`Document ID: ${data.contractId}`, {
    x: 50, y, size: 7, font, color: lightGray,
  });
  y -= 12;

  sigPage.drawText(`IP Address: ${data.auditTrail.ip}  |  Device: ${data.auditTrail.device_type}`, {
    x: 50, y, size: 7, font, color: lightGray,
  });
  y -= 12;

  sigPage.drawText(`User Agent: ${data.auditTrail.user_agent.slice(0, 100)}`, {
    x: 50, y, size: 6, font, color: rgb(0.75, 0.75, 0.75),
  });
  y -= 20;

  sigPage.drawText('waaiio.com  |  Legally binding electronic signature', {
    x: 180, y, size: 7, font, color: rgb(0.75, 0.75, 0.75),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
