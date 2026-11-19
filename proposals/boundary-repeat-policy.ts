/** WIRED as of the boundary-repeat feature (owner-settled policies 2026-11-19 IST).
 * The module moved to src/boundary-repeat/policy.ts; this re-export keeps the proposal
 * combination suite and the pinned selected-policy suite importing one implementation.
 * Selected policy: { stopScope: 'caregiver', stale: 'unresolved_reminder', stopOnReturn: true }.
 */
export * from '../src/boundary-repeat/policy';
