/**
 * Typed error class for Meta WhatsApp Cloud API errors.
 *
 * Thrown by MetaCloudService.callApi when the HTTP response is not ok.
 * Consumers can use `instanceof MetaApiError` to distinguish explicit
 * provider rejections (4xx) from transport/network/5xx failures.
 */
export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly metaErrorCode?: number,
    public readonly metaErrorSubcode?: number,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}
