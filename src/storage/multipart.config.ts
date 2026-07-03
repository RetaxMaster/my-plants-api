import { memoryStorage } from 'multer';

// One image is 10 MB max. Named so it is trivial to tune (spec §2). `multer` is a DIRECT dependency
// declared in Phase 1 (imported here at runtime for memoryStorage); @types/multer supplies the types.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Shared FileInterceptor/FilesInterceptor options for EVERY image endpoint (fork prevention: one
// definition, imported — the Care-History controller reuses this verbatim). Memory storage means
// each file arrives as an in-memory Buffer on `file.buffer`, which ImageUploadService.upload()
// consumes. There is NO fileFilter on purpose: the client-declared MIME type is deliberately NOT
// trusted at the transport layer — validation happens by DECODING inside the service.
export const imageUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};
