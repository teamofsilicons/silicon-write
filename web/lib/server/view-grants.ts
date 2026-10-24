/** Anonymous email submissions grant reading only; these opaque receipts never enter browser JS. */
export const viewGrantCookie = (id: string) => `write-view-${id}`;
export function viewGrantHeaders(cookies: { getAll(): { name: string; value: string }[] }): Record<string, string> {
  const grants = cookies.getAll().filter(cookie => /^write-view-d_[A-Za-z0-9]+$/.test(cookie.name) && /^[A-Za-z0-9_]{20,100}$/.test(cookie.value)).slice(-32).map(cookie => cookie.value);
  return grants.length ? { "x-write-view-grants": grants.join(",") } : {};
}
