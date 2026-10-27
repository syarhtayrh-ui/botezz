import { MediaWorkflow } from '../workflows/media-workflow';
import { BotViewResponse } from '../workflows/pairing-workflow';

export class MediaHandler {
  constructor(private readonly mediaWorkflow: MediaWorkflow) {}

  public startSendMedia(adminId: number): BotViewResponse {
    return this.mediaWorkflow.start(adminId);
  }

  public attachSampleFile(adminId: number, sampleType: 'pdf' | 'png'): BotViewResponse {
    if (sampleType === 'pdf') {
      const samplePdfBuffer = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
        'utf-8'
      );
      return this.mediaWorkflow.handleFileUpload(adminId, {
        originalFilename: 'operation-report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: samplePdfBuffer.byteLength,
        contentBuffer: samplePdfBuffer,
        caption: 'تقرير العمليات المرفق',
      });
    }

    const samplePngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    return this.mediaWorkflow.handleFileUpload(adminId, {
      originalFilename: 'status-badge.png',
      mimeType: 'image/png',
      sizeBytes: samplePngBuffer.byteLength,
      contentBuffer: samplePngBuffer,
      caption: 'صورة توضيحية من لوحة التحكم',
    });
  }
}
