// Crockford's Base32 alphabet — international unambiguous charset used by ULID.
// Excludes I, L, O, U to avoid visual confusion and accidental obscenity.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRoomId(length = 7): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD_ALPHABET[bytes[i] & 31];
  }
  return out;
}

// Normalize user-entered Room IDs: uppercase, map commonly confused chars to
// the Crockford canonical (I/L → 1, O → 0, U → V) so manual entry is forgiving.
export function normalizeRoomId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}
