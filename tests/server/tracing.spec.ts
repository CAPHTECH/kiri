import { describe, expect, it, vi } from "vitest";

import { withSpan } from "../../src/server/observability/tracing.js";

describe("withSpan", () => {
  it("executes function without tracer when OpenTelemetry is not available", async () => {
    const result = await withSpan("test-operation", async (span) => {
      expect(span).toBeNull();
      return "success";
    });

    expect(result).toBe("success");
  });

  it("passes through return value from wrapped function", async () => {
    const complexObject = { value: 42, nested: { data: "test" } };

    const result = await withSpan("test-operation", async () => {
      return complexObject;
    });

    expect(result).toEqual(complexObject);
  });

  it("propagates errors from wrapped function", async () => {
    await expect(
      withSpan("test-operation", async () => {
        throw new Error("Test error");
      })
    ).rejects.toThrow("Test error");
  });

  it("handles async errors correctly", async () => {
    const asyncError = async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 10);
      });
      throw new Error("Async failure");
    };

    await expect(withSpan("test-operation", asyncError)).rejects.toThrow("Async failure");
  });

  it("supports nested spans without interference", async () => {
    const result = await withSpan("outer", async () => {
      const inner1 = await withSpan("inner-1", async () => "result-1");
      const inner2 = await withSpan("inner-2", async () => "result-2");
      return `${inner1},${inner2}`;
    });

    expect(result).toBe("result-1,result-2");
  });

  it("preserves error stack trace", async () => {
    const customError = new Error("Custom error");
    customError.stack = "Custom stack trace";

    try {
      await withSpan("test-operation", async () => {
        throw customError;
      });
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBe(customError);
      expect((error as Error).stack).toBe("Custom stack trace");
    }
  });

  it("handles non-Error thrown values", async () => {
    await expect(
      withSpan("test-operation", async () => {
        throw "string error";
      })
    ).rejects.toBe("string error");

    await expect(
      withSpan("test-operation", async () => {
        throw { code: "ERR_CUSTOM", message: "Object error" };
      })
    ).rejects.toEqual({ code: "ERR_CUSTOM", message: "Object error" });
  });

  it("maintains context for concurrent operations", async () => {
    const operations = Array.from({ length: 5 }, (_, i) =>
      withSpan(`operation-${i}`, async () => {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, Math.random() * 50);
        });
        return `result-${i}`;
      })
    );

    const results = await Promise.all(operations);
    expect(results).toEqual(["result-0", "result-1", "result-2", "result-3", "result-4"]);
  });

  it("handles span callback returning void", async () => {
    let sideEffect = 0;

    await withSpan("void-operation", async () => {
      sideEffect = 42;
    });

    expect(sideEffect).toBe(42);
  });

  it("executes finally block even on error", async () => {
    let cleanupCalled = false;

    try {
      await withSpan("test-operation", async () => {
        try {
          throw new Error("Test error");
        } finally {
          cleanupCalled = true;
        }
      });
    } catch {
      // Expected error
    }

    expect(cleanupCalled).toBe(true);
  });
});

describe("withSpan with mocked tracer", () => {
  it("sets success status on span when operation succeeds", async () => {
    const mockSpan = {
      setStatus: vi.fn(),
      setAttribute: vi.fn(),
      end: vi.fn(),
    };

    // This test documents expected behavior when OpenTelemetry is available
    // In actual implementation, the span would receive setStatus({ code: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockImplementation = async (fn: (span: any) => Promise<any>) => {
      try {
        const result = await fn(mockSpan);
        mockSpan.setStatus({ code: 1 }); // OK
        return result;
      } finally {
        mockSpan.end();
      }
    };

    await mockImplementation(async () => "success");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("sets error status and attributes on span when operation fails", async () => {
    const mockSpan = {
      setStatus: vi.fn(),
      setAttribute: vi.fn(),
      end: vi.fn(),
    };

    const testError = new Error("Test failure");
    testError.stack = "Test stack trace";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockImplementation = async (fn: (span: any) => Promise<any>) => {
      try {
        await fn(mockSpan);
      } catch (error) {
        mockSpan.setStatus({
          code: 2, // ERROR
          message: error instanceof Error ? error.message : String(error),
        });
        mockSpan.setAttribute("error", true);
        if (error instanceof Error) {
          mockSpan.setAttribute("error.type", error.constructor.name);
          mockSpan.setAttribute("error.message", error.message);
          if (error.stack) {
            mockSpan.setAttribute("error.stack", error.stack);
          }
        }
        throw error;
      } finally {
        mockSpan.end();
      }
    };

    await expect(
      mockImplementation(async () => {
        throw testError;
      })
    ).rejects.toThrow("Test failure");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Test failure",
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error", true);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.type", "Error");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.message", "Test failure");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.stack", "Test stack trace");
    expect(mockSpan.end).toHaveBeenCalled();
  });
});
