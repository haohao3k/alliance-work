/** True when a list names one harness/model/effort for both Peer and Lens. Releases before
 * 0.1.18 keyed routes without a role and reject such a list. */
export function sharesRouteAcrossRoles(policy) {
  const keys = policy.routes.map((route) => `${route.harness}/${route.model}/${route.effort}`);
  return new Set(keys).size !== keys.length;
}
