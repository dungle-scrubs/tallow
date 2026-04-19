/** Supported image formats for lightweight header sniffing. */
export type ImageFormat = "gif" | "jpeg" | "png" | "webp";

/** Display metadata for a rendered image. */
export interface ImageMetadata {
	readonly displayHeight: number;
	readonly displayWidth: number;
	readonly format: ImageFormat | null;
	readonly originalHeight: number;
	readonly originalWidth: number;
	readonly resized: boolean;
	readonly sizeBytes?: number;
}

/**
 * Detect image format from the first bytes of a buffer.
 *
 * @param buffer - Input bytes
 * @returns Image format identifier or null when unknown
 */
export function detectImageFormat(buffer: Buffer): ImageFormat | null {
	if (buffer.length >= 8) {
		const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		if (pngSignature.every((value, index) => buffer[index] === value)) return "png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "jpeg";
	}
	if (buffer.length >= 6) {
		const header = buffer.subarray(0, 6).toString("ascii");
		if (header === "GIF87a" || header === "GIF89a") return "gif";
	}
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "webp";
	}
	return null;
}

/**
 * Convert a detected image format into a MIME type.
 *
 * @param format - Detected format
 * @returns MIME type string
 */
export function imageFormatToMime(format: ImageFormat): string {
	switch (format) {
		case "gif":
			return "image/gif";
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
	}
}

/**
 * Build image metadata from original and rendered dimensions.
 *
 * @param original - Original image dimensions
 * @param display - Displayed image dimensions
 * @param format - Detected image format
 * @param bytes - Optional file size in bytes
 * @returns Image metadata
 */
export function createImageMetadata(
	original: { heightPx: number; widthPx: number },
	display: { heightPx: number; widthPx: number },
	format: ImageFormat | null,
	sizeBytes?: number
): ImageMetadata {
	return {
		displayHeight: display.heightPx,
		displayWidth: display.widthPx,
		format,
		originalHeight: original.heightPx,
		originalWidth: original.widthPx,
		resized: original.heightPx !== display.heightPx || original.widthPx !== display.widthPx,
		sizeBytes,
	};
}

/**
 * Format image dimensions for user-facing display.
 *
 * @param meta - Image metadata
 * @returns Formatted dimensions string
 */
export function formatImageDimensions(meta: ImageMetadata): string {
	if (!meta.resized) {
		return `${meta.originalWidth}×${meta.originalHeight}`;
	}
	return `${meta.originalWidth}×${meta.originalHeight} → ${meta.displayWidth}×${meta.displayHeight}`;
}
