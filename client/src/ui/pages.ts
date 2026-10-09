import type { ComponentType } from 'react';
import { createRegistry } from '../lib/registry';

/** A page of a feature's own at a path outside the offices (billing's /billing/return). */
export interface Page {
  /** The path. */
  id: string;
  order: number;
  path: string;
  Component: ComponentType;
}

const pages = createRegistry<Page>();

/** Adds a page at `path`, e.g. '/billing/return' (call it when your module loads); returns a function that removes it. */
export const registerPage = ({ path, Component }: { path: string; Component: ComponentType }) => pages.register({ id: path, order: 0, path, Component });

/** The page registered at `path`, if any. */
export const pageFor = (path: string): Page | undefined => pages.get(path);
