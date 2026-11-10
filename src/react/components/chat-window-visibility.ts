import { createContext } from 'react';

/** Internal presentation signal, not a second recording/session owner.
 * Standalone components are visible unless a retained window hides them. */
export const ChatWindowVisibilityContext = createContext(true);
