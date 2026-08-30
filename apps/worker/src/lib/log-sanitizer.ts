/**
 * Log Sanitizer & Secret Masking Utility
 * Normalizes ANSI and control characters and masks secret credentials
 */
export class LogSanitizer {
  private secrets: Set<string> = new Set();

  constructor(initialSecrets?: string[]) {
    if (initialSecrets) {
      this.addSecrets(initialSecrets);
    }
  }

  /**
   * Registers secret values to be masked in log streams
   */
  public addSecrets(secrets: string[]): void {
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.trim().length >= 3) {
        this.secrets.add(secret.trim());
      }
    }
  }

  /**
   * Clears registered secrets
   */
  public clearSecrets(): void {
    this.secrets.clear();
  }

  /**
   * Normalizes ANSI escape codes and dangerous control characters,
   * then masks all registered secrets with [REDACTED]
   */
  public sanitize(rawText: string): string {
    if (!rawText || typeof rawText !== 'string') {
      return '';
    }

    // 1. Strip ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    let cleaned = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

    // 2. Normalize carriage returns and remove dangerous ASCII control chars (preserving \n and \t)
    // eslint-disable-next-line no-control-regex
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 3. Mask registered secret values
    for (const secret of this.secrets) {
      if (secret.length >= 3) {
        // Escape regex special characters in secret value
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        cleaned = cleaned.replace(regex, '[REDACTED]');
      }
    }

    return cleaned;
  }
}

export const logSanitizer = new LogSanitizer();
