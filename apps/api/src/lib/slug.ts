/**
 * Centralized Slug Validation & Normalization Module
 *
 * Rules:
 * - Regex: ^[a-z0-9-]+$
 * - Cannot start or end with a hyphen
 * - Cannot contain consecutive hyphens (--)
 * - Length: Between 3 and 63 characters
 * - Reserved keywords: api, admin, storage, web (case-insensitive)
 */

export const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'storage',
  'web',
  'app',
  'auth',
  'dashboard',
  'static',
  'assets',
]);

export interface SlugValidationResult {
  isValid: boolean;
  normalizedSlug: string;
  error?: string;
}

/**
 * Normalizes input string to lowercase and trimmed slug
 */
export function normalizeSlug(rawSlug?: string | null): string {
  if (!rawSlug) return '';
  return String(rawSlug).trim().toLowerCase();
}

/**
 * Validates slug against all centralized rules
 */
export function validateSlug(rawSlug?: string | null): SlugValidationResult {
  const normalizedSlug = normalizeSlug(rawSlug);

  if (!normalizedSlug) {
    return {
      isValid: false,
      normalizedSlug: '',
      error: 'Slug is required',
    };
  }

  // Length check (3 to 63 chars)
  if (normalizedSlug.length < 3) {
    return {
      isValid: false,
      normalizedSlug,
      error: 'Slug must be at least 3 characters long',
    };
  }

  if (normalizedSlug.length > 63) {
    return {
      isValid: false,
      normalizedSlug,
      error: 'Slug must not exceed 63 characters',
    };
  }

  // Character set check: ^[a-z0-9-]+$
  if (!/^[a-z0-9-]+$/.test(normalizedSlug)) {
    return {
      isValid: false,
      normalizedSlug,
      error: 'Slug may only contain lowercase alphanumeric characters and hyphens',
    };
  }

  // Leading / Trailing hyphen check
  if (normalizedSlug.startsWith('-') || normalizedSlug.endsWith('-')) {
    return {
      isValid: false,
      normalizedSlug,
      error: 'Slug cannot start or end with a hyphen',
    };
  }

  // Consecutive hyphens check
  if (normalizedSlug.includes('--')) {
    return {
      isValid: false,
      normalizedSlug,
      error: 'Slug cannot contain consecutive hyphens',
    };
  }

  // Reserved keywords check (case-insensitive check on normalized value)
  if (RESERVED_SLUGS.has(normalizedSlug)) {
    return {
      isValid: false,
      normalizedSlug,
      error: `Slug "${normalizedSlug}" is a reserved word and cannot be used`,
    };
  }

  return {
    isValid: true,
    normalizedSlug,
  };
}

/**
 * Helper to generate a clean slug from human readable name
 */
export function slugify(name: string): string {
  let slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');

  while (slug.startsWith('-')) slug = slug.slice(1);
  while (slug.endsWith('-')) slug = slug.slice(0, -1);

  return slug;
}
