/**
 * Re-export atomic write utilities for extension use.
 *
 * Extensions should import from here rather than reaching into `src/`.
 */
export { atomicWriteFileSync, restoreFromBackup } from "../../runtime/atomic-write.js";
