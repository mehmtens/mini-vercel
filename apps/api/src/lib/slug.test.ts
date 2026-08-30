import { describe, it, expect } from 'vitest';
import { validateSlug, normalizeSlug, slugify, RESERVED_SLUGS } from './slug';

describe('Slug Validation & Normalization Module', () => {
  describe('normalizeSlug', () => {
    it('trims leading and trailing whitespace and lowercases', () => {
      expect(normalizeSlug('  My-Project-App  ')).toBe('my-project-app');
      expect(normalizeSlug('UPPERCASE-SLUG')).toBe('uppercase-slug');
      expect(normalizeSlug('')).toBe('');
      expect(normalizeSlug(null)).toBe('');
      expect(normalizeSlug(undefined)).toBe('');
    });
  });

  describe('slugify', () => {
    it('converts arbitrary strings into valid slug candidates', () => {
      expect(slugify('My Awesome App!')).toBe('my-awesome-app');
      expect(slugify('  hello__world  ')).toBe('hello-world');
      expect(slugify('---leading-and-trailing---')).toBe('leading-and-trailing');
    });
  });

  describe('validateSlug - Valid Slugs', () => {
    const validSlugs = [
      'my-app',
      'app123',
      'web-shop-2',
      'abc',
      'nextjs-blog-demo',
      'a1b2c3d4-test',
      'production-cluster-01',
    ];

    validSlugs.forEach((slug) => {
      it(`accepts valid slug: "${slug}"`, () => {
        const result = validateSlug(slug);
        expect(result.isValid).toBe(true);
        expect(result.normalizedSlug).toBe(slug);
        expect(result.error).toBeUndefined();
      });
    });
  });

  describe('validateSlug - Length Constraints', () => {
    it('rejects slugs shorter than 3 characters', () => {
      expect(validateSlug('a').isValid).toBe(false);
      expect(validateSlug('ab').isValid).toBe(false);
      expect(validateSlug('a').error).toContain('at least 3 characters');
      expect(validateSlug('').isValid).toBe(false);
    });

    it('rejects slugs longer than 63 characters', () => {
      const longSlug = 'a'.repeat(64);
      const result = validateSlug(longSlug);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('not exceed 63 characters');
    });

    it('accepts slug with exact 63 characters', () => {
      const maxSlug = 'a'.repeat(63);
      const result = validateSlug(maxSlug);
      expect(result.isValid).toBe(true);
      expect(result.normalizedSlug).toBe(maxSlug);
    });
  });

  describe('validateSlug - Character Set and Formatting Constraints', () => {
    it('rejects slugs with uppercase characters (when un-normalized) and special chars', () => {
      expect(validateSlug('my_app').isValid).toBe(false);
      expect(validateSlug('my.app').isValid).toBe(false);
      expect(validateSlug('my@app').isValid).toBe(false);
      expect(validateSlug('my/app').isValid).toBe(false);
      expect(validateSlug('my app').isValid).toBe(false);
    });

    it('rejects slugs starting with a hyphen', () => {
      const result = validateSlug('-start-dash');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('start or end with a hyphen');
    });

    it('rejects slugs ending with a hyphen', () => {
      const result = validateSlug('end-dash-');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('start or end with a hyphen');
    });

    it('rejects slugs containing consecutive hyphens (--)', () => {
      const result = validateSlug('double--dash');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('consecutive hyphens');

      const multiDash = validateSlug('multi---dash');
      expect(multiDash.isValid).toBe(false);
      expect(multiDash.error).toContain('consecutive hyphens');
    });
  });

  describe('validateSlug - Reserved Words', () => {
    const reservedWords = ['api', 'admin', 'storage', 'web', 'app', 'auth', 'dashboard'];

    reservedWords.forEach((word) => {
      it(`rejects reserved word: "${word}"`, () => {
        const result = validateSlug(word);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('reserved');
      });

      it(`rejects uppercase reserved word: "${word.toUpperCase()}"`, () => {
        const result = validateSlug(word.toUpperCase());
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('reserved');
      });
    });
  });
});
