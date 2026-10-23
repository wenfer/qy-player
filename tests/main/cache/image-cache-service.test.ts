import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ImageCacheService } from '../../../src/main/modules/cache/image-cache-service';

vi.mock('axios');

describe('ImageCacheService', () => {
  let tmpDir: string;
  let service: ImageCacheService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'img-cache-test-'));
    service = new ImageCacheService({ cacheDir: tmpDir, timeoutMs: 1000 });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('sanitizes unsafe characters in cache key', () => {
    const safe = service.getCachePath('../../etc/passwd?x=1');
    expect(safe).not.toContain('..');
    expect(safe.startsWith(tmpDir)).toBe(true);
  });

  it('returns cached path immediately if file exists', async () => {
    const key = 'test-image.jpg';
    const filePath = join(tmpDir, key);
    writeFileSync(filePath, 'fake-jpeg-data');

    expect(service.isCached(key)).toBe(true);
    const result = await service.ensureImage(key, 'http://example.com/image.jpg');
    expect(result).toBe(filePath);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('downloads and saves file when not cached', async () => {
    const key = 'new-image.jpg';
    const fakeData = Buffer.from('image-binary-data');
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: fakeData,
    });

    const result = await service.ensureImage(key, 'http://example.com/new.jpg');
    const targetPath = join(tmpDir, key);
    expect(result).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath).toString()).toBe('image-binary-data');
  });

  it('deduplicates in-flight downloads for the same key', async () => {
    const key = 'shared.jpg';
    let resolveGet: (val: unknown) => void;
    const promise = new Promise((res) => {
      resolveGet = res;
    });
    vi.mocked(axios.get).mockReturnValueOnce(promise as ReturnType<typeof axios.get>);

    const req1 = service.ensureImage(key, 'http://example.com/shared.jpg');
    const req2 = service.ensureImage(key, 'http://example.com/shared.jpg');

    resolveGet!({ status: 200, data: Buffer.from('shared-data') });

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1).toBe(res2);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('returns null gracefully on download failure', async () => {
    const key = 'failed.jpg';
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));

    const result = await service.ensureImage(key, 'http://example.com/failed.jpg');
    expect(result).toBeNull();
    expect(service.isCached(key)).toBe(false);
  });
});
