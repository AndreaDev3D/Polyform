// Content-addressed image cache: SHA-256 hash -> decoded ImageBitmap.
// Bytes come from the project bundle's assets/ directory over IPC.

export class AssetCache {
  private bitmaps = new Map<string, ImageBitmap>()
  private pending = new Set<string>()
  private failed = new Set<string>()
  /** Called when an async load completes (schedule a redraw). */
  onLoad: (() => void) | null = null

  getBitmap(hash: string): ImageBitmap | null {
    const bmp = this.bitmaps.get(hash)
    if (bmp) return bmp
    if (!this.pending.has(hash) && !this.failed.has(hash)) {
      this.pending.add(hash)
      void this.load(hash)
    }
    return null
  }

  private async load(hash: string): Promise<void> {
    try {
      const data = await window.polyform.assetsRead(hash)
      if (!data) throw new Error('asset missing')
      const buf = data.bytes.buffer.slice(
        data.bytes.byteOffset,
        data.bytes.byteOffset + data.bytes.byteLength,
      ) as ArrayBuffer
      const blob = new Blob([buf], { type: data.mime })
      const bmp = await createImageBitmap(blob)
      this.bitmaps.set(hash, bmp)
      this.onLoad?.()
    } catch {
      this.failed.add(hash)
    } finally {
      this.pending.delete(hash)
    }
  }

  async primeFromBytes(hash: string, bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
    const existing = this.bitmaps.get(hash)
    if (existing) return existing
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const bmp = await createImageBitmap(new Blob([buf], { type: mime }))
    this.bitmaps.set(hash, bmp)
    return bmp
  }

  clear(): void {
    this.bitmaps.clear()
    this.pending.clear()
    this.failed.clear()
  }
}

export const assetCache = new AssetCache()
