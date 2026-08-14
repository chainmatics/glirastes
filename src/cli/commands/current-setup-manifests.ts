import { detectSetupProfile, type SetupProfile } from './setup-profile.js';
import {
  renderManifests,
  type RenderedManifests,
} from './validate-build.js';

export async function renderCurrentSetupManifests(options: {
  rootDir: string;
  managed: boolean;
  profile?: SetupProfile;
}): Promise<RenderedManifests> {
  const profile = options.profile ?? await detectSetupProfile({
    rootDir: options.rootDir,
    managed: options.managed,
  });
  return renderManifests({
    rootDir: options.rootDir,
    appId: profile.appId,
    inventoryPath: profile.paths.inventory,
    promptBundlePath: profile.paths.promptBundle,
    setupArtifactPath: profile.paths.setupArtifact,
  });
}
