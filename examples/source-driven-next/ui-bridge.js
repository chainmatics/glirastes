import { useAiClientActionById } from 'glirastes/react';

// One setup-time bridge, not a per-view or per-filter tool catalogue.
export function NativeUiBridge({ bus, ui }) {
  useAiClientActionById(bus, 'native.navigate', (action) => ui.navigate(action.payload));
  useAiClientActionById(bus, 'native.filter', (action) => ui.filter(action.payload));
  return null;
}
