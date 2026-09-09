import { writable } from 'svelte/store';
import { browser } from '$app/environment';

// The browser's IANA time zone, or undefined during server rendering.
//
// Pages render on Vercel in UTC, and a date formatted there is baked into the
// HTML; hydration does not re-run it. Any formatter that reads this store
// re-renders once the browser sets it, so "ends Nov 7" becomes "ends Nov 6" for
// someone in California. Pass `$tz` as the timeZone option — undefined means
// "system zone", which is right on both server (UTC) and client.
export const tz = writable<string | undefined>(
  browser ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined
);
