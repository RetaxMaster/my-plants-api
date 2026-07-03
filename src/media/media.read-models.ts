// The client-facing media view (excludes the internal R2 object key). `imageUrl` is what the admin
// copies into Markdown.
export interface MediaAssetView {
  id: string;
  imageUrl: string;
  filename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
}

export interface MediaRow {
  id: string;
  imageUrl: string;
  imageObjectKey: string;
  filename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export function toMediaView(row: MediaRow): MediaAssetView {
  return {
    id: row.id,
    imageUrl: row.imageUrl,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
  };
}
