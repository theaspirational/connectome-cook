/** PATH entries cannot represent a colon, for either builds or launchers. */
export function assertHostEnginePath(path: string): void {
  if (path.includes(':')) throw new Error('E_HOST_ENGINE_PATH: selected-engine install path must not contain ":" (build PATH separator)');
}
