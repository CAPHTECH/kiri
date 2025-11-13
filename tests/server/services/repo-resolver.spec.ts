import { describe, expect, it, vi } from "vitest";

import { RepoRepository } from "../../../src/server/services/repo-repository.js";
import { RepoNotFoundError, RepoResolver } from "../../../src/server/services/repo-resolver.js";

describe("RepoResolver", () => {
  describe("resolveId", () => {
    it("throws RepoNotFoundError when repo table does not exist", async () => {
      const mockRepository = {
        tableExists: vi.fn().mockResolvedValueOnce(false),
      } as unknown as RepoRepository;

      const resolver = new RepoResolver(mockRepository);

      await expect(resolver.resolveId("/test/path")).rejects.toThrow(RepoNotFoundError);
      await expect(resolver.resolveId("/test/path")).rejects.toThrow(/was not indexed/);
    });

    it("calls updateRoot when direct match succeeds but root differs from normalized", async () => {
      const mockRepository = {
        tableExists: vi.fn().mockResolvedValueOnce(true),
        findByPaths: vi.fn().mockResolvedValueOnce({ id: 1, root: "/old/path" }),
        updateRoot: vi.fn().mockResolvedValueOnce(undefined),
      } as unknown as RepoRepository;

      const resolver = new RepoResolver(mockRepository);
      const result = await resolver.resolveId("/users/user/project");

      expect(result).toBe(1);
      expect(mockRepository.updateRoot).toHaveBeenCalledTimes(1);
      // getRepoPathCandidates normalizes the path, so expects lowercase
      expect(mockRepository.updateRoot).toHaveBeenCalledWith(1, "/users/user/project");
    });

    it("does not call updateRoot when direct match root equals normalized path", async () => {
      const mockRepository = {
        tableExists: vi.fn().mockResolvedValueOnce(true),
        findByPaths: vi.fn().mockResolvedValueOnce({ id: 1, root: "/Users/user/project" }),
        updateRoot: vi.fn(),
      } as unknown as RepoRepository;

      const resolver = new RepoResolver(mockRepository);
      const result = await resolver.resolveId("/Users/user/project");

      expect(result).toBe(1);
      expect(mockRepository.updateRoot).not.toHaveBeenCalled();
    });

    it("uses fallback path when direct match fails but findByNormalizedPath succeeds", async () => {
      const mockRepository = {
        tableExists: vi.fn().mockResolvedValueOnce(true),
        findByPaths: vi.fn().mockResolvedValueOnce(null),
        findByNormalizedPath: vi.fn().mockResolvedValueOnce({ id: 2, root: "/fallback/path" }),
        updateRoot: vi.fn().mockResolvedValueOnce(undefined),
      } as unknown as RepoRepository;

      const resolver = new RepoResolver(mockRepository);
      const result = await resolver.resolveId("/fallback/path");

      expect(result).toBe(2);
      expect(mockRepository.findByNormalizedPath).toHaveBeenCalledTimes(1);
      // Should call updateRoot after fallback succeeds
      expect(mockRepository.updateRoot).toHaveBeenCalledTimes(1);
    });

    it("throws RepoNotFoundError when both direct and fallback paths fail", async () => {
      const mockRepository = {
        tableExists: vi.fn().mockResolvedValueOnce(true),
        findByPaths: vi.fn().mockResolvedValueOnce(null),
        findByNormalizedPath: vi.fn().mockResolvedValueOnce(null),
      } as unknown as RepoRepository;

      const resolver = new RepoResolver(mockRepository);

      await expect(resolver.resolveId("/nonexistent/path")).rejects.toThrow(RepoNotFoundError);
      await expect(resolver.resolveId("/nonexistent/path")).rejects.toThrow(/was not indexed/);
    });

    it("includes repoRoot in error message for better debugging", async () => {
      const mockRepository = {
        tableExists: vi.fn().mockResolvedValueOnce(false),
      } as unknown as RepoRepository;

      const resolver = new RepoResolver(mockRepository);

      await expect(resolver.resolveId("/specific/test/path")).rejects.toThrow(
        "/specific/test/path"
      );
    });
  });
});
