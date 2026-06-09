/**
 * Auto-loaded extension shim — SpecSafe session lifecycle.
 *
 * WHY THIS FILE EXISTS (Seshat v2, slice v2.0):
 * omp v15 discovers extension modules from `.omp/extensions/*.ts`
 * (src/discovery/builtin.ts:430-528, helpers.ts:520). The legacy
 * `hookCapability` provider only models Claude-style `hooks/<type>/*`
 * subdirs, so the flat `.omp/hooks/*.ts` factories from SPEC-008 were
 * NEVER auto-loaded. This shim re-exports the hook factory from its
 * source-of-truth location so it actually runs under omp.
 *
 * `--hook` is an alias for `--extension`; the HookAPI factory signature
 * (`export default function(pi)`) is what the extension runner imports.
 */
export { default } from "../hooks/specsafe-session";
