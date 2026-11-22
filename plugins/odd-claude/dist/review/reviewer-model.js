const LENS_ROLES = {
    risk: "odd-review-risk",
    resilience: "odd-review-resilience",
    readability: "odd-review-readability",
    reliability: "odd-review-reliability",
};
const FAMILIES = ["haiku", "sonnet", "opus"];
/** Profile role name of a reviewer child, or undefined when the profile has no row for it. */
export function profileRoleOf(role, lens) {
    if (role === "refuter")
        return "review-refuter";
    if (role === "validator")
        return "review-validator";
    return lens !== undefined && Object.hasOwn(LENS_ROLES, lens) ? LENS_ROLES[lens] : undefined;
}
/** Runner model/effort of a reviewer child under `profile`; `{}` (no flag) when unrouted. haiku never carries an effort. */
export function reviewerRoute(profile, role, lens) {
    const name = profileRoleOf(role, lens);
    const route = name === undefined ? undefined : profile.routing[name];
    if (route === undefined || !FAMILIES.includes(route.model))
        return {};
    return route.model === "haiku" || route.effort === undefined ? { model: route.model } : { model: route.model, effort: route.effort };
}
