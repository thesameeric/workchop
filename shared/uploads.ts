/** The answer to POST /api/offices/:id/uploads. */
export interface UploadedFile {
  id: string;
  /** Where to download it: /api/uploads/<id>/<name> (anyone with the link can). */
  url: string;
  name: string;
  contentType: string;
  size: number;
}

/** The message for a file over the size limit (the server's 413 and the client's own check). */
export function tooLarge(maxBytes?: number): string {
  return maxBytes ? `File too large (max ${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MB)` : 'File too large';
}
