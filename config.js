/**
 * Project-wide runtime configuration. Imported wherever a behaviour
 * toggle needs to be read; flip values here to change behaviour
 * without touching call sites.
 */

export const config = {
    network: {
        // When true, a remote joiner connecting mid-match is seated
        // and spawned into the running game instead of waiting for
        // the next lobby phase. The slot reservation + room-full
        // overflow handling stay the same either way; this only
        // controls whether the joiner has to wait.
        allowMidGameJoin: true,
    },
};
