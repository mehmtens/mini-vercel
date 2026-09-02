import { describe, expect, it } from 'vitest';
import { buildPreviewUrl } from './index';

describe('buildPreviewUrl', () => {
  it('uses HTTP and the .localhost namespace for local previews', () => {
    expect(buildPreviewUrl('sample-app', 'abcdef0123456789', 'localhost')).toBe(
      'http://sample-app-abcdef0.localhost'
    );
  });

  it('uses HTTPS and the configured production base domain', () => {
    expect(buildPreviewUrl('sample-app', 'abcdef0123456789', 'Example.COM')).toBe(
      'https://sample-app-abcdef0.example.com'
    );
  });
});
