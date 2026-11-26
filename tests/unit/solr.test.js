import { jest } from '@jest/globals';

const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch
}));

// api.peviitor.ro jobs response shape: { total, data }
function makeJobsResponse(total, data) {
  return {
    ok: true,
    json: async () => ({ total, data })
  };
}

// api.peviitor.ro company response shape: { success, data }
function makeCompanyResponse(data) {
  return {
    ok: true,
    json: async () => ({ success: true, data })
  };
}

function makeErrorResponse(status, text) {
  return {
    ok: false,
    status,
    text: async () => text
  };
}

describe('solr.js', () => {
  let solr;

  beforeAll(async () => {
    solr = await import('../../solr.js');
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('querySOLR', () => {
    it('should return response object with docs', async () => {
      mockFetch.mockResolvedValue(makeJobsResponse(2, [
        { id: 'job1', url: 'https://test.com/1', cif: '17549799' },
        { id: 'job2', url: 'https://test.com/2', cif: '17549799' }
      ]));

      const result = await solr.querySOLR('17549799');

      expect(result).toHaveProperty('numFound', 2);
      expect(result).toHaveProperty('docs');
      expect(Array.isArray(result.docs)).toBe(true);
      expect(result.docs).toHaveLength(2);
    });

    it('should return empty docs when no jobs found', async () => {
      mockFetch.mockResolvedValue(makeJobsResponse(0, []));

      const result = await solr.querySOLR('99999999');

      expect(result.numFound).toBe(0);
      expect(result.docs).toEqual([]);
    });

    it('should zero-pad short CIFs before querying', async () => {
      mockFetch.mockResolvedValue(makeJobsResponse(0, []));

      await solr.querySOLR('123');

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('cif=00000123');
    });

    it('should treat 404 "No jobs for CIF" as an empty result', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(404, '{"error":"No jobs for CIF 17549799","code":404}'));

      const result = await solr.querySOLR('17549799');

      expect(result.numFound).toBe(0);
      expect(result.docs).toEqual([]);
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));

      await expect(solr.querySOLR('17549799')).rejects.toThrow('API jobs query error: 500');
    });
  });

  describe('getCompanyByCif', () => {
    it('should return the first matching company', async () => {
      mockFetch.mockResolvedValue(makeCompanyResponse([
        { id: '17549799', company: 'RANDSTAD ROMANIA SRL', brand: 'RANDSTAD' }
      ]));

      const result = await solr.getCompanyByCif('17549799');

      expect(result.brand).toBe('RANDSTAD');
    });

    it('should return null when company not found', async () => {
      mockFetch.mockResolvedValue(makeCompanyResponse([]));

      const result = await solr.getCompanyByCif('00000000');

      expect(result).toBeNull();
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500, 'Server Error'));

      await expect(solr.getCompanyByCif('17549799')).rejects.toThrow('API company search error: 500');
    });
  });

  describe('upsertCompany', () => {
    it('should accept a company doc and zero-pad its id', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

      await expect(
        solr.upsertCompany({ id: '17549799', company: 'RANDSTAD ROMANIA SRL' })
      ).resolves.not.toThrow();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.id).toBe('17549799');
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(400, 'Bad Request'));

      await expect(solr.upsertCompany({ id: '17549799' })).rejects.toThrow('API company upsert error: 400');
    });
  });

  describe('upsertJobs', () => {
    it('should accept array of jobs', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 1 }) });

      const testJob = {
        url: 'https://test.com/job1',
        title: 'Test Job',
        company: 'TEST COMPANY',
        cif: '12345678',
        status: 'scraped'
      };

      await expect(solr.upsertJobs([testJob])).resolves.not.toThrow();
    });

    it('should skip the upload when there are no jobs', async () => {
      await expect(solr.upsertJobs([])).resolves.toEqual({ count: 0 });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(400, 'Bad Request'));

      await expect(solr.upsertJobs([{ url: 'https://test.com/bad', cif: '12345678' }]))
        .rejects.toThrow('API jobs upload error: 400');
    });
  });

  describe('deleteJobByUrl', () => {
    it('should delete a job by URL', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 1 }) });

      await expect(solr.deleteJobByUrl('https://test.com/old-job')).resolves.not.toThrow();
    });

    it('should not throw on 404 (nothing to delete)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      await expect(solr.deleteJobByUrl('https://test.com/missing')).resolves.not.toThrow();
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500, 'Error'));

      await expect(solr.deleteJobByUrl('https://test.com/bad')).rejects.toThrow('API jobs delete error: 500');
    });
  });

  describe('deleteJobsByCIF', () => {
    it('should delete all jobs for a CIF', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 3 }) });

      await expect(solr.deleteJobsByCIF('17549799')).resolves.not.toThrow();
    });

    it('should not throw on 404 (nothing to delete)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      await expect(solr.deleteJobsByCIF('17549799')).resolves.not.toThrow();
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500, 'Error'));

      await expect(solr.deleteJobsByCIF('17549799')).rejects.toThrow('API jobs delete error: 500');
    });
  });

  describe('Data Integrity', () => {
    it('should not have duplicate URLs for same CIF', async () => {
      mockFetch.mockResolvedValue(makeJobsResponse(2, [
        { url: 'https://test.com/job1', title: 'Job 1', cif: '17549799' },
        { url: 'https://test.com/job2', title: 'Job 2', cif: '17549799' }
      ]));

      const result = await solr.querySOLR('17549799');
      const urls = result.docs.map(j => j.url);
      const uniqueUrls = new Set(urls);

      expect(uniqueUrls.size).toBe(result.numFound);
    });

    it('should have valid CIF format for all jobs', async () => {
      mockFetch.mockResolvedValue(makeJobsResponse(2, [
        { url: 'https://test.com/1', title: 'Job 1', cif: '17549799' },
        { url: 'https://test.com/2', title: 'Job 2', cif: '12345678' }
      ]));

      const result = await solr.querySOLR('17549799');

      for (const job of result.docs) {
        expect(job.cif).toMatch(/^\d{8}$/);
      }
    });

    it('should have valid status values', async () => {
      const validStatuses = ['scraped', 'tested', 'verified', 'published'];

      mockFetch.mockResolvedValue(makeJobsResponse(3, [
        { url: 'https://test.com/1', title: 'Job 1', cif: '17549799', status: 'scraped' },
        { url: 'https://test.com/2', title: 'Job 2', cif: '17549799', status: 'verified' },
        { url: 'https://test.com/3', title: 'Job 3', cif: '17549799', status: 'published' }
      ]));

      const result = await solr.querySOLR('17549799');

      for (const job of result.docs) {
        expect(validStatuses).toContain(job.status);
      }
    });
  });
});
