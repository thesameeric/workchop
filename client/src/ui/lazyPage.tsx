import { use, type ComponentType, type FulfilledReactPromise } from 'react';

/**
 * A page that loads the first time it's needed, so the home page doesn't wait for it (App.tsx's
 * Suspense shows nothing meanwhile). Once loaded, or preloaded, it shows at once.
 */
export function lazyPage(load: () => Promise<ComponentType>) {
  let loading: Promise<ComponentType> | undefined;
  const preload = () => {
    if (!loading) {
      const page = load().then(
        (Component) => {
          // Marked fulfilled as React marks the promises it has seen, so use() reads a page preloaded
          // before React saw it (main.tsx waits for the first one) at once, without suspending.
          Object.assign(page, { status: 'fulfilled', value: Component } satisfies Omit<FulfilledReactPromise<ComponentType>, 'then'>);
          return Component;
        },
        (err: unknown) => {
          // Tried again next time it's needed.
          loading = undefined;
          throw err;
        },
      );
      loading = page;
    }
    return loading;
  };
  function LazyPage() {
    // Always through use(), also once loaded: React tries a suspended page again expecting the same hooks.
    const Component = use(preload());
    return <Component />;
  }
  return Object.assign(LazyPage, { preload });
}
