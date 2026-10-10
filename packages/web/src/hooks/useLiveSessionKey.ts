import { useIdesStore, viewedLiveKeyOf } from '../store/ides';
import { useUiStore } from '../store/ui';

/**
 * React binding of `viewedLiveKeyOf` — the session body key currently being viewed.
 * AppShell uses it as the Timeline remount key; the Timeline wrapper uses it to select the body.
 */
export function useLiveSessionKey(): string {
  const selectedIde = useIdesStore(s => s.selectedIde);
  const state = useIdesStore(s => s.ides[selectedIde]);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  return viewedLiveKeyOf(selectedIde, state, pendingSwitch);
}
