import { clsx, type ClassValue } from 'clsx';

/**
 * Class-name join helper. Thin wrapper over `clsx` so the whole app has one
 * import site for conditional classes. Kept trivial on purpose: Tailwind class
 * merging (dedupe) is unnecessary here because the design system leans on
 * semantic component classes rather than long utility chains.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
