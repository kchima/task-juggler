// Simple ID generation (no UUID dependency needed)
import crypto from 'crypto';

export function generateId() {
  return crypto.randomUUID();
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function shortId(length = 8) {
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += ID_CHARS[bytes[i] % ID_CHARS.length];
  }
  return result;
}