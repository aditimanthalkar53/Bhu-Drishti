import type { Role } from "./auth";

/**
 * Pages hidden from each role's website: no sidebar entry, the address redirects to the role's home, and links to them
 * are not shown. Nothing is deleted: remove a path from a list to bring the page back.
 */
const HIDDEN: Record<Role, string[]> = {
  authority: ["/app/areas", "/app/monitors", "/app/updates", "/app/hazard", "/app/audit", "/app/data", "/app/drift"],
  citizen: ["/app/hazard"],
  volunteer: ["/app/hazard"],
};

export const isHiddenFor = (role: Role | undefined, path: string): boolean =>
  (HIDDEN[role ?? "citizen"] ?? []).some((p) => path === p || path.startsWith(`${p}/`));
