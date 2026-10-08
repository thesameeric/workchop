/** The answer to POST /api/offices/:id/uploads. */
export interface UploadedFile {
  id: string;
  /** Where to download it: /api/uploads/<id>/<name> (anyone with the link can). */
  url: string;
  name: string;
  contentType: string;
  size: number;
}
