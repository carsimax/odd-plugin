/** invalid: not a positive integer (never signalled: 0 and negatives would target process groups). dead: ESRCH. unknown: any other error. */
export function pidState(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return "invalid";
    try {
        process.kill(pid, 0);
        return "alive";
    }
    catch (err) {
        const code = err.code;
        if (code === "EPERM")
            return "alive";
        return code === "ESRCH" ? "dead" : "unknown";
    }
}
export function isPidAlive(pid) {
    return pidState(pid) === "alive";
}
