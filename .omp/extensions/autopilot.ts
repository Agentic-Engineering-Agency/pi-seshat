/**
 * Auto-loaded extension shim — autopilot (cross-session autonomy).
 *
 * WHY THIS FILE EXISTS (Seshat v2, slice v2.8):
 * omp v15 discovers extension modules from `.omp/extensions/*.ts`
 * (src/discovery/builtin.ts). The flat `.omp/hooks/*.ts` factories are NOT
 * auto-loaded, so this shim re-exports the hook factory from its
 * source-of-truth location so it actually runs under omp. `--hook` is an
 * alias for `--extension`; both import `export default function(pi)`.
 */
export { default } from "../hooks/autopilot";
