/**
 * Generate a ULID-like identifier (26 chars, base32).
 * Format: timestamp (10 chars) + random (16 chars).
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = generateRandomPart(16);
  return `${timestamp}${random}`;
}

function generateRandomPart(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // Use base32 hex alphabet (0-9, a-v) for URL-safe IDs
  const chars = '0123456789abcdef';
  let result = '';
  for (const byte of bytes) {
    result += chars[byte & 0x0f];
    result += chars[(byte >> 4) & 0x0f];
  }
  return result.slice(0, length);
}

/**
 * Generate a correlation ID.
 */
export function generateCorrelationId(): string {
  return generateId();
}
