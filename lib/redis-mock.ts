/**
 * Mock Redis Implementation
 *
 * In-memory mock that mimics Upstash Redis API for local development and testing.
 * Includes full Lua script simulation for atomic operations.
 *
 * Usage:
 * - Set USE_MOCK_REDIS=true in environment
 * - Or NODE_ENV=test
 *
 * Features:
 * - All core Redis operations (set, get, del, exists, incr, decr, pexpire)
 * - Full Lua script parsing and execution via eval()
 * - TTL/expiry management
 * - Thread-safe for single-process concurrent access
 */

interface StoreEntry {
  value: string;
  expiry?: number; // Unix timestamp in ms when key expires
}

/**
 * Simple Lua script executor for Redis-like Lua scripts
 * Supports the subset of Lua used in our distributed locking code
 */
class LuaExecutor {
  constructor(
    private store: Map<string, StoreEntry>,
    private keys: string[],
    private args: string[],
  ) {}

  /**
   * Execute a Lua script and return the result
   */
  execute(script: string): unknown {
    // Clean up the script
    const cleanScript = script.trim();

    // Parse and execute
    return this.executeBlock(cleanScript);
  }

  private executeBlock(block: string): unknown {
    const lines = this.parseLines(block);
    const variables: Record<string, unknown> = {};
    let result: unknown = null;
    let i = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();

      if (!trimmed || trimmed.startsWith("--")) {
        i++;
        continue;
      }

      // Handle local variable assignment
      if (trimmed.startsWith("local ")) {
        const match = trimmed.match(/^local\s+(\w+)\s*=\s*(.+)$/);
        if (match) {
          const [, varName, expr] = match;
          variables[varName] = this.evaluateExpression(expr, variables);
        }
        i++;
        continue;
      }

      // Handle variable assignment (non-local)
      const assignMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (
        assignMatch &&
        !trimmed.startsWith("if ") &&
        !trimmed.startsWith("return ")
      ) {
        const [, varName, expr] = assignMatch;
        variables[varName] = this.evaluateExpression(expr, variables);
        i++;
        continue;
      }

      // Handle if statements
      if (trimmed.startsWith("if ")) {
        const ifResult = this.executeIfWithIndex(i, lines, variables);
        if (ifResult.hasReturn) {
          return ifResult.value;
        }
        i = ifResult.endIndex + 1; // Skip past the entire if block
        continue;
      }

      // Handle return statements
      if (trimmed.startsWith("return ")) {
        const expr = trimmed.substring(7);
        return this.evaluateExpression(expr, variables);
      }

      // Handle standalone redis.call
      if (trimmed.startsWith("redis.call(")) {
        result = this.evaluateExpression(trimmed, variables);
      }

      i++;
    }

    return result;
  }

  private parseLines(block: string): string[] {
    // Split by newlines but handle multi-line statements
    return block.split("\n").map((l) => l.trim());
  }

  private executeIfWithIndex(
    ifIndex: number,
    allLines: string[],
    variables: Record<string, unknown>,
  ): { hasReturn: boolean; value: unknown; endIndex: number } {
    const ifLine = allLines[ifIndex].trim();

    // Find the full if block boundaries
    let depth = 1;
    let elseIndex = -1;
    let endIndex = -1;

    for (let i = ifIndex + 1; i < allLines.length; i++) {
      const line = allLines[i].trim();
      if (line.startsWith("if ")) depth++;
      if (line === "else" && depth === 1) elseIndex = i;
      if (line === "end") {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }

    if (endIndex === -1) {
      return { hasReturn: false, value: null, endIndex: allLines.length - 1 };
    }

    // Extract condition
    const condMatch = ifLine.match(/^if\s+(.+)\s+then$/);
    if (!condMatch) {
      return { hasReturn: false, value: null, endIndex };
    }

    const condition = this.evaluateCondition(condMatch[1], variables);

    // Determine which block to execute
    let startLine: number;
    let endLine: number;

    if (condition) {
      startLine = ifIndex + 1;
      endLine = elseIndex !== -1 ? elseIndex : endIndex;
    } else if (elseIndex !== -1) {
      startLine = elseIndex + 1;
      endLine = endIndex;
    } else {
      return { hasReturn: false, value: null, endIndex };
    }

    // Execute the selected block
    for (let i = startLine; i < endLine; i++) {
      const trimmed = allLines[i].trim();
      if (!trimmed || trimmed === "end" || trimmed === "else") continue;

      if (trimmed.startsWith("return ")) {
        const expr = trimmed.substring(7);
        return {
          hasReturn: true,
          value: this.evaluateExpression(expr, variables),
          endIndex,
        };
      }

      // Handle local variable assignment
      if (trimmed.startsWith("local ")) {
        const match = trimmed.match(/^local\s+(\w+)\s*=\s*(.+)$/);
        if (match) {
          variables[match[1]] = this.evaluateExpression(match[2], variables);
        }
        continue;
      }

      // Handle regular variable assignment (e.g., current = 0)
      const assignMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        const [, varName, expr] = assignMatch;
        variables[varName] = this.evaluateExpression(expr, variables);
        continue;
      }

      // Handle standalone redis.call
      if (trimmed.startsWith("redis.call(")) {
        this.evaluateExpression(trimmed, variables);
      }
    }

    return { hasReturn: false, value: null, endIndex };
  }

  private evaluateCondition(
    condition: string,
    variables: Record<string, unknown>,
  ): boolean {
    // Handle "value == something" comparisons
    const eqMatch = condition.match(/(.+?)\s*==\s*(.+)/);
    if (eqMatch) {
      const left = this.evaluateExpression(eqMatch[1].trim(), variables);
      const right = this.evaluateExpression(eqMatch[2].trim(), variables);
      return left === right;
    }

    // Handle "value ~= something" (not equal)
    const neqMatch = condition.match(/(.+?)\s*~=\s*(.+)/);
    if (neqMatch) {
      const left = this.evaluateExpression(neqMatch[1].trim(), variables);
      const right = this.evaluateExpression(neqMatch[2].trim(), variables);
      return left !== right;
    }

    // Handle "value >= something"
    const gteMatch = condition.match(/(.+?)\s*>=\s*(.+)/);
    if (gteMatch) {
      const left = this.evaluateExpression(gteMatch[1].trim(), variables);
      const right = this.evaluateExpression(gteMatch[2].trim(), variables);
      return Number(left) >= Number(right);
    }

    // Handle "value > something"
    const gtMatch = condition.match(/(.+?)\s*>\s*(.+)/);
    if (gtMatch) {
      const left = this.evaluateExpression(gtMatch[1].trim(), variables);
      const right = this.evaluateExpression(gtMatch[2].trim(), variables);
      return Number(left) > Number(right);
    }

    // Handle "value and value2" (both truthy)
    if (condition.includes(" and ")) {
      const parts = condition.split(" and ");
      return parts.every((p) => {
        const val = this.evaluateExpression(p.trim(), variables);
        return val !== null && val !== false && val !== 0;
      });
    }

    // Handle simple truthy check
    const val = this.evaluateExpression(condition, variables);
    return val !== null && val !== false && val !== 0;
  }

  private evaluateExpression(
    expr: string,
    variables: Record<string, unknown>,
  ): unknown {
    const trimmed = expr.trim();

    // Handle nil/false literals
    if (trimmed === "nil" || trimmed === "false") return null;
    if (trimmed === "true") return true;

    // Handle numeric literals
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);

    // Handle string literals
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    // Handle KEYS[n] and ARGV[n]
    const keysMatch = trimmed.match(/^KEYS\[(\d+)\]$/);
    if (keysMatch) {
      return this.keys[parseInt(keysMatch[1], 10) - 1] ?? null;
    }

    const argvMatch = trimmed.match(/^ARGV\[(\d+)\]$/);
    if (argvMatch) {
      return this.args[parseInt(argvMatch[1], 10) - 1] ?? null;
    }

    // Handle variables
    if (Object.hasOwn(variables, trimmed)) {
      return variables[trimmed];
    }

    // Handle tonumber()
    const tonumberMatch = trimmed.match(/^tonumber\((.+)\)$/);
    if (tonumberMatch) {
      const inner = this.evaluateExpression(tonumberMatch[1], variables);
      if (inner === null || inner === false) return 0;
      return parseInt(String(inner), 10) || 0;
    }

    // Handle redis.call()
    const redisCallMatch = trimmed.match(/^redis\.call\((.+)\)$/);
    if (redisCallMatch) {
      return this.executeRedisCall(redisCallMatch[1], variables);
    }

    // Handle arithmetic operations
    if (trimmed.includes(" + ")) {
      const [left, right] = trimmed.split(" + ");
      return (
        Number(this.evaluateExpression(left, variables)) +
        Number(this.evaluateExpression(right, variables))
      );
    }

    if (trimmed.includes(" - ")) {
      const [left, right] = trimmed.split(" - ");
      return (
        Number(this.evaluateExpression(left, variables)) -
        Number(this.evaluateExpression(right, variables))
      );
    }

    return null;
  }

  private executeRedisCall(
    argsStr: string,
    variables: Record<string, unknown>,
  ): unknown {
    // Parse arguments - handle quoted strings and expressions
    const args: unknown[] = [];
    let current = "";
    let inString = false;
    let stringChar = "";

    for (let i = 0; i < argsStr.length; i++) {
      const char = argsStr[i];

      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
        current += char;
      } else if (inString && char === stringChar) {
        inString = false;
        current += char;
      } else if (!inString && char === ",") {
        if (current.trim()) {
          args.push(this.evaluateExpression(current.trim(), variables));
        }
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) {
      args.push(this.evaluateExpression(current.trim(), variables));
    }

    const command = String(args[0]).toLowerCase();
    const key = String(args[1] ?? "");

    switch (command) {
      case "get": {
        const entry = this.store.get(key);
        if (!entry) return null; // Lua false
        if (entry.expiry && Date.now() > entry.expiry) {
          this.store.delete(key);
          return null;
        }
        return entry.value;
      }

      case "set": {
        const value = String(args[2] ?? "");
        this.store.set(key, { value });
        return "OK";
      }

      case "del": {
        const deleted = this.store.delete(key);
        return deleted ? 1 : 0;
      }

      case "incr": {
        const entry = this.store.get(key);
        let value = 0;
        if (entry) {
          if (entry.expiry && Date.now() > entry.expiry) {
            this.store.delete(key);
          } else {
            value = parseInt(entry.value, 10) || 0;
          }
        }
        value++;
        // Preserve expiry if it exists
        const existingExpiry = this.store.get(key)?.expiry;
        this.store.set(key, { value: String(value), expiry: existingExpiry });
        return value;
      }

      case "decr": {
        const entry = this.store.get(key);
        let value = 0;
        if (entry) {
          if (entry.expiry && Date.now() > entry.expiry) {
            this.store.delete(key);
          } else {
            value = parseInt(entry.value, 10) || 0;
          }
        }
        value--;
        const existingExpiry = this.store.get(key)?.expiry;
        this.store.set(key, { value: String(value), expiry: existingExpiry });
        return value;
      }

      case "pexpire": {
        const entry = this.store.get(key);
        if (!entry) return 0;
        const ttl = parseInt(String(args[2]), 10);
        entry.expiry = Date.now() + ttl;
        return 1;
      }

      case "exists": {
        const entry = this.store.get(key);
        if (!entry) return 0;
        if (entry.expiry && Date.now() > entry.expiry) {
          this.store.delete(key);
          return 0;
        }
        return 1;
      }

      default:
        console.warn(`MockRedis: Unknown redis.call command: ${command}`);
        return null;
    }
  }
}

/**
 * Mock Redis client that mimics @upstash/redis API
 */
export class MockRedis {
  private store = new Map<string, StoreEntry>();

  /**
   * Set a key with optional NX (only if not exists) and PX (expiry in ms) options
   */
  async set(
    key: string,
    value: string,
    opts?: { nx?: boolean; px?: number },
  ): Promise<string | null> {
    this.cleanupExpiredKey(key);

    if (opts?.nx && this.store.has(key)) {
      return null;
    }

    const entry: StoreEntry = { value };
    if (opts?.px) {
      entry.expiry = Date.now() + opts.px;
    }

    this.store.set(key, entry);
    return "OK";
  }

  /**
   * Get a key's value
   */
  async get(key: string): Promise<string | null> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    return entry?.value ?? null;
  }

  /**
   * Delete one or more keys
   */
  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  /**
   * Check if one or more keys exist
   */
  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      this.cleanupExpiredKey(key);
      if (this.store.has(key)) count++;
    }
    return count;
  }

  /**
   * Increment a key's numeric value
   */
  async incr(key: string): Promise<number> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    let value = entry ? parseInt(entry.value, 10) || 0 : 0;
    value++;
    this.store.set(key, { value: String(value), expiry: entry?.expiry });
    return value;
  }

  /**
   * Decrement a key's numeric value
   */
  async decr(key: string): Promise<number> {
    this.cleanupExpiredKey(key);
    const entry = this.store.get(key);
    let value = entry ? parseInt(entry.value, 10) || 0 : 0;
    value--;
    this.store.set(key, { value: String(value), expiry: entry?.expiry });
    return value;
  }

  /**
   * Set expiry on a key in milliseconds
   */
  /**
   * Set operations, backed by a JSON array in the same string store.
   *
   * #1146 — the maintenance drain records the exact channels it froze so the
   * unfreeze can reverse that set rather than re-deriving it from a heuristic
   * that misses the sessions whose `call.end()` failed. A Redis SET is the
   * right shape for it (add-many, read-all, remove-some, no duplicates), and
   * the mock has to support what local dev and CI actually run.
   *
   * Serialised as JSON rather than kept as a live `Set` so it shares the
   * existing expiry and cleanup machinery instead of needing a parallel store.
   */
  private readSet(key: string): string[] {
    this.cleanupExpiredKey(key);
    const raw = this.store.get(key)?.value;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      // A key of this name holding a non-set value is a programming error, not
      // a runtime condition to paper over — but throwing here would take down
      // a maintenance drain, so it reads as empty and the caller degrades.
      return [];
    }
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const existing = new Set(this.readSet(key));
    const before = existing.size;
    for (const m of members) existing.add(m);
    this.store.set(key, { value: JSON.stringify([...existing]) });
    return existing.size - before;
  }

  async smembers(key: string): Promise<string[]> {
    return this.readSet(key);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const existing = new Set(this.readSet(key));
    const before = existing.size;
    for (const m of members) existing.delete(m);
    if (existing.size === 0) this.store.delete(key);
    else this.store.set(key, { value: JSON.stringify([...existing]) });
    return before - existing.size;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiry = Date.now() + ms;
    return 1;
  }

  /**
   * Ping the server (always returns PONG for mock)
   */
  async ping(): Promise<string> {
    return "PONG";
  }

  /**
   * Get the remaining time to live for a key in milliseconds
   * Returns -2 if key doesn't exist, -1 if no expiry, or remaining TTL in ms
   */
  async pttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) {
      return -2; // Key doesn't exist
    }
    if (entry.expiry === undefined) {
      return -1; // Key exists but has no expiry
    }
    if (entry.expiry <= Date.now()) {
      this.store.delete(key); // Clean up expired key
      return -2; // Key expired
    }
    return entry.expiry - Date.now();
  }

  /**
   * Execute a Lua script
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const executor = new LuaExecutor(this.store, keys, args);
    return executor.execute(script);
  }

  /**
   * Clear all keys (useful for test cleanup)
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get all keys (useful for debugging)
   */
  keys(): string[] {
    this.cleanupAllExpired();
    return Array.from(this.store.keys());
  }

  /**
   * Get store size (useful for debugging)
   */
  size(): number {
    this.cleanupAllExpired();
    return this.store.size;
  }

  // Private helpers

  private cleanupExpiredKey(key: string): void {
    const entry = this.store.get(key);
    if (entry?.expiry && Date.now() > entry.expiry) {
      this.store.delete(key);
    }
  }

  private cleanupAllExpired(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    this.store.forEach((entry, key) => {
      if (entry.expiry && now > entry.expiry) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => this.store.delete(key));
  }
}

// Singleton instance for use across the application
let mockRedisInstance: MockRedis | null = null;

/**
 * Get the mock Redis instance (singleton)
 */
export function getMockRedis(): MockRedis {
  if (!mockRedisInstance) {
    mockRedisInstance = new MockRedis();
  }
  return mockRedisInstance;
}

/**
 * Reset the mock Redis instance (for testing)
 */
export function resetMockRedis(): void {
  if (mockRedisInstance) {
    mockRedisInstance.clear();
  }
}

export default getMockRedis();
