// A caller's hook bag with some members replaced, without copying the bag's values. Spreading a
// class instance keeps only its own properties, so a route that spreads a caller's bag loses the
// class's methods; this builds a plain object that keeps them.

/**
 * The bag with `overrides` in place of its own members. Every other member, own or inherited,
 * string- or symbol-keyed, becomes an enumerable accessor that reads the bag when it is read: a
 * getter runs only then, and a spread of the result keeps every member. An inherited method is
 * bound to the bag so its private fields still work; an own member is returned as it is. The
 * overrides are ordinary data properties.
 */
export function withHookOverrides<T extends object>(bag: T | undefined, overrides: Partial<T>): T {
  const forward: Record<PropertyKey, unknown> = {};
  const replaced = new Set(Reflect.ownKeys(overrides));
  for (
    let source: object | null = bag ?? null;
    source !== null && source !== Object.prototype;
    source = Object.getPrototypeOf(source) as object | null
  ) {
    const inherited = source !== bag;
    for (const key of Reflect.ownKeys(source)) {
      if (key === "constructor" || replaced.has(key) || Object.hasOwn(forward, key)) continue;
      Object.defineProperty(forward, key, {
        enumerable: true,
        configurable: true,
        get() {
          const value: unknown = Reflect.get(bag!, key, bag);
          return inherited && typeof value === "function" ? value.bind(bag) : value;
        },
        set(value: unknown) {
          Reflect.set(bag!, key, value, bag);
        },
      });
    }
  }
  for (const key of replaced) {
    Object.defineProperty(forward, key, {
      value: (overrides as Record<PropertyKey, unknown>)[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return forward as T;
}
