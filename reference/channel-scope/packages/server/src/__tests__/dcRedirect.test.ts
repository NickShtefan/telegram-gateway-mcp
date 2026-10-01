import { describe, it, expect } from 'vitest';
import { isDcRedirectError } from '../telegram/processors/processMediaClient.js';

describe('isDcRedirectError', () => {
  describe('positive cases — should detect DC redirect errors', () => {
    it('detects "File lives in another DC" message', () => {
      expect(isDcRedirectError(new Error('File lives in another DC'))).toBe(true);
    });

    it('detects "file is in a different dc" (case-insensitive)', () => {
      expect(isDcRedirectError(new Error('file is in a different dc'))).toBe(true);
    });

    it('detects "File lives in another DC" with extra context', () => {
      expect(isDcRedirectError(new Error('Failed to download: File lives in another DC (DC 4)'))).toBe(true);
    });

    it('detects "DC redirect" error', () => {
      expect(isDcRedirectError(new Error('DC redirect failed'))).toBe(true);
    });

    it('detects "dc_redirect" (underscore variant)', () => {
      expect(isDcRedirectError(new Error('Error: dc_redirect to DC 5'))).toBe(true);
    });

    it('detects FILE_MIGRATE error code', () => {
      expect(isDcRedirectError(new Error('RPCError: FILE_MIGRATE_4'))).toBe(true);
    });

    it('detects NETWORK_MIGRATE error code', () => {
      expect(isDcRedirectError(new Error('NETWORK_MIGRATE_2'))).toBe(true);
    });

    it('handles string input (not Error object)', () => {
      expect(isDcRedirectError('File lives in another DC')).toBe(true);
    });

    it('handles case variations', () => {
      expect(isDcRedirectError(new Error('FILE_MIGRATE'))).toBe(true);
      expect(isDcRedirectError(new Error('file_migrate'))).toBe(true);
      expect(isDcRedirectError(new Error('File_Migrate'))).toBe(true);
    });
  });

  describe('negative cases — should NOT detect as DC redirect', () => {
    it('returns false for generic download errors', () => {
      expect(isDcRedirectError(new Error('Download failed: timeout'))).toBe(false);
    });

    it('returns false for network errors', () => {
      expect(isDcRedirectError(new Error('ECONNREFUSED'))).toBe(false);
    });

    it('returns false for auth errors', () => {
      expect(isDcRedirectError(new Error('AUTH_KEY_UNREGISTERED'))).toBe(false);
    });

    it('returns false for empty error', () => {
      expect(isDcRedirectError(new Error(''))).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isDcRedirectError(null)).toBe(false);
      expect(isDcRedirectError(undefined)).toBe(false);
    });

    it('returns false for unrelated "file" or "dc" mentions', () => {
      expect(isDcRedirectError(new Error('file not found'))).toBe(false);
      expect(isDcRedirectError(new Error('dc connection lost'))).toBe(false);
    });

    it('returns false for number input', () => {
      expect(isDcRedirectError(42)).toBe(false);
    });
  });
});
